import { useId, useLayoutEffect, useRef, useState } from 'react'
import { HexColorInput, HexColorPicker } from 'react-colorful'
import { useEscapeKey, usePressAway } from './pressAway'
import { normalizeHex } from './styleForm'

/** A colour override: a swatch that opens an in-page picker, never the OS dialog.
 *
 *  Exactly one terminal callback leaves this component per interaction: `onCommit` for every
 *  close and for a typed hex, `onClear` for "Use default" — never both, so a caller with a live
 *  draft needs no one-shot flag of its own to tell a clear from the close that follows it. */
export default function ColorField({
  label,
  value,
  fallback,
  allowDefault = true,
  disabled = false,
  mixed = false,
  onChange,
  onCommit,
  onClear,
  presentation = 'popover',
  onOpen,
  onClose,
}: {
  label: string
  /** The override, or '' for "use the built-in default". */
  value: string
  /** The built-in default shown when there is no override. */
  fallback: string
  /** Whether '' ("use the built-in default") is a valid value: shows the default chip and the
   *  "Use default" button. Off in values mode, where every field always holds a concrete colour. */
  allowDefault?: boolean
  disabled?: boolean
  /** The caller's selection holds more than one colour, so `value` is blank for "differs", not
   *  for "no override". The swatch says "mixed" instead of "default", and "Use default" stays
   *  enabled: there *is* something to clear. */
  mixed?: boolean
  onChange: (hex: string) => void
  /** A colour picker closed or a hex was typed — commit the current value. A typed commit carries
   *  the just-typed hex, since the draft `onChange` set a moment earlier has not necessarily
   *  reached the caller's own state yet (StyleTab reads `draft` a render behind a keystroke); a
   *  close carries nothing, so the caller commits whatever it already has. */
  onCommit?: (hex?: string) => void
  /** "Use default" was clicked (allowDefault only). Without it the caller sees `onChange('')`
   *  followed by a bare `onCommit()`, which a stateless caller cannot tell from a plain close.
   *  It is the *only* terminal callback for that click: the close it triggers is silent, so a
   *  caller holding a draft never has to guess which of the two to believe. */
  onClear?: () => void
  /** How the picker shows: a popover placed beside the swatch where it fits (the default), or a
   *  `sheet` laid out full width against the nearest positioned ancestor of the field (the docked
   *  label bar, SPEC § 6.5), with no placement measurement; the field then marks itself
   *  `color-field-sheet` so that it is not that ancestor. The commit rules are the same in both. */
  presentation?: 'popover' | 'sheet'
  /** The picker opened (after the swatch's click). */
  onOpen?: () => void
  /** The picker closed, by any route, once per close; fires for the silent close too. */
  onClose?: () => void
}) {
  const [open, setOpen] = useState(false)
  // Whether the popover would run off the right edge of its container (the side panel, a config
  // page panel, or the viewport) if opened left-aligned under the swatch — decided by measurement
  // at open time, not by which grid column the field happens to land in: a `.span2` row ahead of
  // it can shift every field after it into the other column, so column parity does not track
  // which side has room (#94 IMPORTANT 4).
  const [alignRight, setAlignRight] = useState(false)
  // The same measurement for the other axis: the popover opens upwards when there is no room for
  // it below the swatch inside that container. The editor's floating label toolbar sits low over a
  // canvas that clips its overflow, so a downward popover there would simply be cut off.
  const [alignUp, setAlignUp] = useState(false)
  // Guards against a close reaching us twice for one interaction (mousedown fires on the
  // document before a blur's focusout bubbles, both before React re-renders `open`), so onCommit
  // fires exactly once per close.
  const openRef = useRef(false)
  const wrap = useRef<HTMLDivElement>(null)
  const swatch = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const id = useId()
  const valueId = `${id}-value`
  const shown = value || fallback
  const pick = (hex: string) => onChange(normalizeHex(hex))
  const typed = (hex: string) => {
    pick(hex)
    onCommit?.(normalizeHex(hex))
  }
  const openPicker = () => {
    openRef.current = true
    setOpen(true)
    // Left-aligned and below until the layout effect has measured the popover it just rendered.
    setAlignRight(false)
    setAlignUp(false)
    onOpen?.()
  }
  // Where the popover fits is measured from the popover itself once it is in the DOM, before the
  // browser paints it (#100, #104): its width differs by mode (the "Use default" button) and its
  // height by stylesheet, and neither is mirrored here by hand. `.editor-canvas` is a bound as
  // much as a panel is: it clips its overflow, so a popover reaching past its edges is invisible,
  // not merely awkward. When neither below nor above fits, the side with more room wins.
  useLayoutEffect(() => {
    const wrapEl = wrap.current
    const popEl = popover.current
    if (presentation !== 'popover' || !open || !wrapEl || !popEl) return
    const wrapRect = wrapEl.getBoundingClientRect()
    const bound = (wrapEl.closest('.editor-canvas, .side-panel-body, .panel') ?? document.documentElement).getBoundingClientRect()
    const { width, height } = popEl.getBoundingClientRect()
    setAlignRight(wrapRect.left + width > bound.right)
    const below = bound.bottom - wrapRect.bottom
    const above = wrapRect.top - bound.top
    setAlignUp(below < height && (above >= height || above > below))
  }, [open, presentation])
  /** Every way out of the picker: exactly one terminal callback per close, whichever event gets
   *  there first. `silent` is for the close that follows a callback of its own ("Use default",
   *  which has already fired `onClear`): a trailing bare `onCommit()` there would reach a caller
   *  that still closes over this render's draft and put back what was just cleared. */
  const closePicker = (refocus: boolean, { silent = false }: { silent?: boolean } = {}) => {
    if (!openRef.current) return
    openRef.current = false
    setOpen(false)
    onClose?.()
    if (refocus) swatch.current?.focus() // a keyboard user lands back where they started
    if (!silent) onCommit?.()
  }

  // A press anywhere else closes the picker, committing what it holds (see `usePressAway` for why
  // a cancelled touch counts as one). It calls this render's `closePicker`, so a drag that just
  // changed the draft is what gets committed, not whatever `onCommit` closed over on opening.
  usePressAway(wrap, open, () => closePicker(false))
  // Escape closes it too, and is spent on that (see `useEscapeKey`): the editor would otherwise
  // read the swatch about to be refocused as the thing to act on and clear the selection.
  useEscapeKey(open, () => closePicker(true))

  return (
    <div
      className={presentation === 'sheet' ? 'field color-field color-field-sheet' : 'field color-field'}
      ref={wrap}
      onBlur={(e) => {
        // Tabbing out of the popover closes it; moving focus within it does not.
        if (open && !wrap.current?.contains(e.relatedTarget as Node | null)) closePicker(false)
      }}
    >
      <span className="field-label" id={id}>
        {label}
      </span>
      <button
        ref={swatch}
        type="button"
        className="swatch"
        aria-labelledby={`${id} ${valueId}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? closePicker(true) : openPicker())}
      >
        <span className="swatch-chip" style={{ background: shown }} />
        <span className="swatch-hex" id={valueId}>
          {shown.toUpperCase()}
          {allowDefault && !value && <span className="swatch-note">{mixed ? ' mixed' : ' default'}</span>}
        </span>
      </button>
      {open && (
        <div
          ref={popover}
          className={presentation === 'sheet' ? 'color-sheet' : `popover${alignRight ? ' popover-right' : ''}${alignUp ? ' popover-up' : ''}`}
          role="dialog"
          aria-label={`${label} picker`}
        >
          <HexColorPicker color={shown} onChange={pick} />
          <div className="popover-row">
            <HexColorInput color={shown} onChange={typed} prefixed />
            {allowDefault && (
              <button
                type="button"
                className="secondary"
                disabled={!value && !mixed}
                onClick={() => {
                  onChange('')
                  onClear?.()
                  closePicker(true, { silent: true })
                }}
              >
                Use default
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
