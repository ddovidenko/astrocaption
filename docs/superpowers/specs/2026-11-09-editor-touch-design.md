# Touch in the editor (#57) — design

Implements issue #57 (milestone "Later (post-v1)"): SPEC.md § 6 (editor interactions) gains touch,
and the § 3 non-goal "the editor may assume a mouse" and the § 14 open question go away. Behaviour
agreed with the owner in conversation on 2026-11-09 (toolbar option C from three mockups; the
gesture list; the testing trade). Items marked **(builder's call)** were decided while writing this
document; the owner was given them as a list and approved the document as written on 2026-11-09.

## Goal

The owner opened the production editor on an iPhone. Two things made it unusable:

- **The page jumps.** The canvas only listens for a mouse (`canvasGestures.ts` wires `onMouseDown`,
  `onMouseMove`, `onWheel`), there is no `touch-action` anywhere, so Safari scrolls and zooms the
  *page* under a finger while Konva drags a label.
- **The toolbar is gigantic.** The floating label toolbar's fields are `0.8rem` (12.8 px). iOS
  zooms the whole page when a field under 16 px takes the focus, and the page stays zoomed.

The ambition is modest and the owner's words: a phone is not where anyone lays out a whole image,
but someone should be able to make **minor tweaks** there (nudge a label, hide one, change a size or
a colour) without the page misbehaving.

Success: in the editor the page itself never zooms or scrolls; two fingers zoom the photo; a label
can be selected, moved, resized, recoloured, renamed and hidden with a finger on a 390 px screen.

## Non-goals

- A phone-first editor. The side panel and its four tabs keep today's layout and behaviour.
  *Amended 2026-11-09, after PR 1:* the top bar was on this list too, but measured at 390 px the
  site header and the wrapped toolbar took 330 px, which would have left no photo above the More
  sheet on a real iPhone. The owner chose to slim the top in a compact editor first (its own PR:
  header hidden on the editor screen, one row with back, title, Fit, undo, redo and the save
  state; 100 % and the zoom readout hidden).
- Selecting several labels by touch. Shift-click has no touch equivalent and none is added.
- Any change to what is drawn. The annotation JSON, `render.py`, `metrics.ts`, the placer and the
  render/names/placement vectors are untouched; `parity.spec.ts` must pass unchanged.
- New dependencies. Konva 10 and react-colorful already do everything needed.
- Verifying on a tablet. The design should work there; nobody has one to check (see "After the
  release").

Anti-goal: a mouse user must not notice any of this. Every existing e2e spec passes unmodified, and
the floating toolbar on a mouse-driven desktop is pixel-for-pixel what it is today.

## Decisions

| Question | Decision |
|---|---|
| What counts as touch for a **gesture** | The event, not the device: Konva's `touchstart`/`touchmove`/`touchend`/`tap` run the rules below, mouse events keep today's rules. A touch-screen laptop gets both. |
| What counts as touch for **layout** | `(pointer: coarse)` or a window ≤ 640 px (the width at which the side panel already starts closed). Call this a *compact* editor. **(builder's call, see note 1)** |
| Phone toolbar | Mockup option C: a short bar docked under the canvas plus a sheet for the rest. |
| Moving a label by touch | Only a label that is already selected moves. A drag that starts on an unselected label pans. |
| Toggling an object by touch | Two taps: the first shows the hover ring and name, the second on the same object toggles it. |
| Renaming by touch | A "Rename" row in the sheet. The inline double-click editor stays mouse-only. |
| Page zoom | Off for the whole editor screen (photo, bars, side panel, site header), not only the photo. Done with `touch-action` and 16 px fields, not with `user-scalable=no` (iOS ignores it, and every other page should stay zoomable). |
| Real-iPhone check | After the release, on production. Before merging, the owner smoke-tests in desktop devtools and CI runs touch e2e in Chromium. |

Note 1. The owner was told "an iPad keeps the floating strip, with bigger tap targets". Writing this
up showed that does not fit: with 44 px controls and 16 px text the nine-control strip is about
850 px wide, wider than an iPad in portrait (768 px), and it never wraps. So every touch-first
device gets the docked bar, whatever its width; the floating strip is for mouse-driven windows wider
than 640 px. This is the one place the document departs from what was said in conversation, and it
is flagged to the owner at hand-over.

## Gestures on the canvas (PR 1)

All in `canvasGestures.ts`, next to the mouse handlers and returned in the same `stage` and `label`
bundles; `EditorCanvas.tsx` spreads them as it does today. The pure arithmetic goes in `view.ts`.

**Two fingers: zoom and pan together.** On a `touchmove` with two touches, take the midpoint and
the distance between them in stage-container pixels. The new view keeps the world point that was
under the previous midpoint under the new midpoint, scaled by `distance / previousDistance` and
clamped to `MIN_SCALE`–`MAX_SCALE` like `zoomAt`. A new pure function in `view.ts`
(`pinchView(view, prevMid, prevDist, mid, dist)`, name **builder's call**) does this and is unit
tested; the handler only reads touches and calls `setView`. Konva's documented recipe for this
needs `Konva.hitOnDragEnabled = true` so `touchmove` still reaches the stage while a node is being
dragged; set it for the lifetime of the editor canvas and restore the previous value on unmount.

**A second finger landing during a label drag** ends that drag where the label is (`stopDrag`, so
the normal `dragend` commits one undo entry) and the pinch takes over. The drag does not resume
when a finger lifts. **(builder's call)**

**One finger: pan.** A `touchstart` with one touch records the start point and the view; a
`touchmove` with one touch pans by the displacement, exactly as the mouse pan does, unless a
selected label is being dragged. The pan starts wherever the finger lands: empty sky, a marker, or
an unselected label.

**Tap a label: select it.** Konva's `tap` on a label selects it (replacing any selection). `tap`
on the bare stage clears the selection and any touch hover. A finger may wander up to 10 screen
pixels and still be a tap (the mouse's slack stays 3). **(builder's call: 10)**

**Drag a selected label: move it.** Same store calls as the mouse drag (`moveLabel` preview frames,
one committed entry, the label becomes pinned). An unselected label under a finger must not move:
how that is enforced (turning `draggable` off for touch presses on unselected labels, or stopping
the drag in `dragstart` when the press was a touch on an unselected label) is the builder's, as
long as the label never visibly jumps and no undo entry is recorded.

**Tap an object: two steps.** The transparent hit circles in `EditorCanvas.tsx` get a `tap`
handler. If the tapped object is not the store's `hoveredId`, the tap only calls `hover(id)`: the
existing ring and name tooltip appear. If it already is, the tap calls
`tryToggleWithPlacement(id, …)` as a click does, and leaves the hover showing so a third tap
toggles back. Any tap elsewhere clears the hover. The hit circle's floor of 8 screen pixels becomes
16 when the editor is compact, so a star's marker is a 32 px target; where circles overlap, Konva's
topmost wins as it does for the mouse. **(builder's call: 16)**

**Nothing else on touch.** No double-tap action, no long-press, no wheel-resize equivalent (the bar
has − and +). Keyboard shortcuts are unchanged for anyone with a keyboard attached.

**The page stays put.** In `styles.css`:

- `.editor-canvas { touch-action: none; }` so the browser hands every touch on the photo to the
  page's handlers.
- Everything else on the editor screen gets `touch-action: pan-x pan-y`: taps and scrolling (the
  side panel's object list) still work, pinch-zoom and double-tap-zoom of the page do not.
  `manipulation` is not enough, it still allows a pinch. The rule goes on the editor's existing
  `body:has(> #root > main.editor-main)` hook, not on `main.editor-main`: the site `<header>`
  (title, nav, Log out) is rendered outside `main` on this route (`App.tsx`) and must be covered
  too. No other page changes.
- The same `body` rule (already `height: 100dvh`) gains `overscroll-behavior: none`, so a pan
  that reaches the edge does not rubber-band the page.
- Under `@media (pointer: coarse)`, every `input`, `select` and `textarea` inside the editor
  route renders at 16 px or more. This is the fix for the iOS focus zoom. The label toolbar's
  `0.8rem` rule is the known offender; the builder audits the side panel's fields the same way.

`index.html`'s viewport tag does not change.

**Touching the photo ends an edit in progress.** Konva calls `preventDefault()` on a `touchstart`
that lands on a listening shape, so no compatibility `mousedown` follows and the focus does not
move; on bare sky the `mousedown` arrives only after `touchend`. Today's commit paths hang on
exactly those: the size field commits on blur, the colour picker closes and commits on a document
`mousedown` (`ColorField.tsx`). Without help, a typed size or a picked colour would be dropped
silently when the next tap changes the selection. So the stage's `touchstart` first blurs a focused
toolbar field and closes any open picker or sheet *with* its commit, and only then lets the tap or
drag act. The `mousedown` listeners stay; the existing tests use them. This applies to the floating
strip as well, so it is part of PR 1.

**Read-only documents.** While a re-solve runs the document is not editable and, as today, the
label layer does not listen: labels cannot be selected, by mouse or by touch, and no bar shows.
Pinch, pan and the first (hover) tap on an object still work; the second tap does not toggle.

## The docked bar and the sheet (PR 2)

`LabelToolbar.tsx` keeps its logic (the size draft, the colour draft, mixed values, one undo entry
per control) and gains a second presentation. Which one renders is decided by a small hook
(`useCompactEditor`, name **builder's call**) that reads the two media queries above with
`matchMedia`, listens for changes, and reports `false` where `matchMedia` does not exist (jsdom),
so existing component tests keep seeing the floating strip.

**Floating strip** (not compact): unchanged.

**Docked bar** (compact): shown while at least one label is selected and the inline text editor is
closed, the same condition as the strip. It is a flex child of `.editor-pane` directly under
`.editor-canvas`, so the canvas gets shorter when it appears and no label is ever underneath it; it
is not an overlay. **(builder's call)** The view is not refitted when the canvas height changes.

Left to right: `−`, the size field, `+`, the colour swatch (chip only, no hex text), a spacer,
`Hide`, `More`. Controls are 44 px tall with 16 px text. The bar is as wide as the canvas pane,
which on a phone is the window minus the collapsed side panel's 32 px strip: 358 px on a 390 px
phone, 343 px on a 375 px one. It must fit 343 px without wrapping or scrolling (the size field is
the part that gives); in a narrower pane it scrolls sideways. `role="toolbar"` and
`aria-label="Selected labels"` as on the strip.

The bar and both sheets carry the hook the keyboard handler already uses to treat the strip as a
field (`el.closest('.label-toolbar')` in `canvasGestures.ts`), so Delete, Backspace and Escape
typed inside them edit the field and do not act on the selection.

- **Hide** calls `disableAll([...selectedIds])`, the same single change as the Delete key. The
  selection empties, so the bar goes away; Undo in the top bar brings the label back.
- **More** opens the sheet; the button shows as pressed while it is open.

**The sheet** is a panel anchored to the bottom of `.editor-canvas`, above the bar, full width,
with rounded top corners. It is plain DOM, not a `<dialog>`: the photo above it stays live. It
closes on a tap on the photo, on `More` again, on Escape, and when the selection becomes empty. It
does not drag and has no swipe-to-dismiss. **(builder's call)** Rows, each at least 48 px tall:

| Row | Control | Behaviour |
|---|---|---|
| Rename | text field, 16 px | Shown only when exactly one label is selected. Same rules as the inline editor: Enter or leaving the field commits the trimmed text as `text_override`, blank resets to the catalogue name, Escape restores the field. Share the commit logic with `LabelTextEditor.tsx`, do not copy it. |
| Aliases | native `select` | The strip's `MixedSelect`, same options. |
| Leader | native `select` | The strip's `MixedSelect`, same options. |
| Pin in place | toggle button, `aria-pressed` | The strip's Pin. |
| Reset position | button | The strip's action, including its error message path; closes the sheet. |
| Clear overrides | button | The strip's action; closes the sheet. |

**Keeping the label in view.** When the sheet (or the colour sheet below) opens and the selection's
bounding box would be hidden behind it, the view pans up by just enough to show the box with the
strip's `MARGIN` to spare. It does not pan back on close. **(builder's call)**

**Side panel.** Untouched. At phone width an open panel is a grid column that squeezes the canvas
pane to a sliver; it is not an overlay. The docked bar keeps its own width and is clipped with the
pane, and opening the panel closes an open sheet (with its commit). **(builder's call)**

## The colour sheet (PR 3)

`ColorField.tsx` today opens a 200 px popover beside its swatch and measures where it fits. It
gains a `sheet` presentation, used only by the docked bar: the same `HexColorPicker`,
`HexColorInput` (16 px) and "Use default" button, laid out full width in the same bottom sheet
container as More. Only one sheet is open at a time; opening one closes the other.

The commit rules do not change, and neither does what previews: dragging in the picker moves a
local draft that the swatch chip and the hex field show; the label on the photo changes when the
sheet closes, as one undo entry (`LabelToolbar.test.tsx` pins this for the strip). A typed hex
commits on the keystroke; "Use default" clears the override and cancels the draft. A live preview
on the photo itself would need store preview frames and would switch Undo off while the sheet is
open; it is left out so the desktop and the phone behave the same. **(builder's call)** Every
other user of `ColorField` (Style tab, config page) keeps the popover.

If PR 2 turns out small, PR 3 may be folded into it; if the sheet container is needed by both, it
lands in PR 2.

## Errors

No new failure modes on the server; nothing here calls the API differently. In the browser:

- A toggle or a reset whose placer throws keeps its existing message ("The label could not be
  changed; nothing was altered." and the reset equivalent), shown where it is today.
- A `touchcancel` (a call comes in, the browser takes the gesture) ends a pan or a pinch without
  committing anything new, and ends a label drag through Konva's own `dragend`, as a mouse release
  outside the window does today.

## Tests

**Unit (vitest).** `view.test.ts`: the pinch function keeps the world point under the midpoint,
pans with the midpoint, clamps at both scale limits, and is the identity when nothing moved.

**Component (jsdom).** `LabelToolbar.test.tsx` gains a compact block with `matchMedia` stubbed:
the bar's controls and names; Hide disables the selection as one change; More opens and closes the
sheet; Rename commits, resets on blank and is absent for a multi-selection; the existing strip
tests run unchanged with no stub. `ColorField` gets the sheet presentation's commit-on-close and
"Use default" cases.

**End to end (Playwright).** A new spec file run by a new project, both Chromium, so CI downloads
no extra browser: the project uses a 390 × 844 viewport with `hasTouch` and `isMobile`, and only
it matches `*.touch.spec.ts` (the `*.dev.spec.ts` convention). Playwright's `page.touchscreen`
only taps, so taps use it and every drag and pinch is dispatched through a CDP session
(`Input.dispatchTouchEvent`), wrapped in a helper in `e2e/helpers.ts`. A probe during review
confirmed both premises in headless Chromium: `(pointer: coarse)` matches under `hasTouch` +
`isMobile`, and a CDP pinch zooms an unprotected page while a `touch-action: none` element stays
at scale 1. Asserted against the Orion fixture:

1. A pinch on the photo changes the zoom percentage in the top bar, and `visualViewport.scale` is
   still 1 and the document has not scrolled. A second pinch on the top bar changes nothing at all.
2. A one-finger drag on empty sky pans; a one-finger drag that starts on an unselected label pans
   and leaves that label's stored position alone.
3. A tap on a label selects it and the docked bar appears; dragging it now moves it and Undo
   becomes available once.
4. Hide removes the label and the bar; Undo restores it.
5. More → Rename changes the label's text; Clear overrides restores it.
6. The colour sheet: a pick shows on the swatch chip, and closing the sheet by tapping the photo
   changes the label and adds one undo entry. The same for a size typed in the bar and committed
   by tapping the photo (the "ends an edit in progress" rule).
7. Two taps on a disabled object: the first shows the tooltip and changes nothing, the second
   enables it.
8. No focusable field in the editor has a computed font size under 16 px.

`layout.spec.ts`'s phone block gains one assertion: with a label selected at 390 px the editor
still has no horizontal overflow. `make e2e` runs the new project by default.

**Not automatable.** iOS Safari's focus zoom and its page pinch do not exist in Chromium; items 1
and 8 pin the *causes* (the page viewport stays at scale 1 under a synthetic pinch, no field is
under 16 px), not Safari itself. That gap is closed by hand after the release.

## Documents

Per PR, as behaviour lands:

- `docs/SPEC.md` § 3: reword the "Mobile-first editor" bullet (still not mobile-first; the editor
  now works by touch, see § 6.5).
- § 6: a new "6.5 Touch" subsection with the gesture list, the compact rule, the docked bar and
  the sheets; § 6.1 and § 6.2 point to it where a mouse gesture has a touch counterpart.
- § 14: drop the "Touch support in the editor" line once PR 1 merges; note "not verified on a
  tablet" there until someone checks.
- `README.md` / `docs/INSTALL.md`: nothing a self-hoster must do. One sentence in the README's
  feature list is enough.
- `CLAUDE.md`: add the `*.touch.spec.ts` convention next to the e2e description if `make e2e`'s
  one-line summary needs it.

## PRs

Small, in order, each smoke-tested by the owner on `make dev` (:5173) in desktop devtools at phone
width with touch emulation before it merges:

1. `feat: touch gestures in the editor (#57)`: pinch, one-finger pan, tap to select, drag only a
   selected label, two-tap toggle, the touch that ends an edit in progress, `touch-action`, 16 px
   fields, the compact hook (the hit-circle floor needs it), the Playwright touch project with
   e2e items 1, 2, 7, 8, the first half of 3 and the typed-size half of 6. On its own this already
   stops the jumping and the focus zoom; the floating strip is still too wide for a phone until
   PR 2.
2. `feat: docked label bar and sheet on touch screens (#57)`: the bar, Hide, More, Rename, e2e
   items 3–5, the layout assertion, SPEC § 6.5.
3. `feat: colour picker as a sheet in the docked bar (#57)`: e2e item 6. Closes #57.

## After the release

- The owner checks on the real iPhone once a release carrying all three PRs is on production:
  tapping the size field, the Rename field and the hex field does not zoom the page; a pinch on
  the photo zooms the photo and not the page; a pinch on the top bar does nothing; a label drags
  without the page moving. Anything that fails becomes a follow-up issue.
- A separate issue tracks "verify the touch editor on a tablet"; it stays open until someone has
  one.
