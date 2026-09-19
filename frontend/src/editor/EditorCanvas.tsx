import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Circle, Group, Image as KImage, Layer, Line, Rect, Stage, Text } from 'react-konva'
import Konva from 'konva'
import { useShallow } from 'zustand/react/shallow'
import type { FontOut, Label, ObjectOut, StyleConfig } from '../api'
import LabelTextEditor from './LabelTextEditor'
import LabelToolbar from './LabelToolbar'
import { LabelTextShape } from './LabelTextShape'
import { disableAll, getMeasurer, isEditable, tryToggleWithPlacement } from './editing'
import { primaryName } from './names'
import { PAD_FACTOR } from './placement'
import { CANVAS_SIZE_ERROR, drawErrorNotice, previewErrorSentence, probeStatus } from './notices'
import {
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  labelText,
  leaderSegment,
  leaderVisible,
  markerRadius,
  markerStrokeRadius,
  measureLabel,
  scaleUnit,
  type Box,
  type Circle as Ring,
  type LabelBox,
  type LabelLines,
  type LeaderSegment,
  type TextMeasurer,
} from './metrics'
import { enabledLabels, enabledObjectIds, fontFor, useEditor } from './store'
import { useTaggedDraft } from './taggedDraft'
import { toScreen, zoomAt } from './view'

/** What the parity spec (PR 4's Playwright test) drives the canvas with. `renderAt` returns a PNG
 *  data URL of the annotated image alone — no hover overlay, no collided badges — at `scale`
 *  original pixels per screen pixel, so it can be diffed against the server's annotated preview.
 *
 *  The hook is production code on purpose: `make e2e` and CI drive the built bundle, so an env gate
 *  would strip it exactly where the test needs it — and Konva's own `Konva.stages` reaches the
 *  stage anyway. */
export interface EditorTestHook {
  stage: Konva.Stage
  /** The original image size, so a caller can pick the scale that matches a server render and
   *  keep a moved label inside the frame. */
  imageWidth: number
  imageHeight: number
  /** How many enabled labels the canvas actually drew (orphaned ones are not counted). */
  labelCount: number
  /** Where the drawn labels sit and how big their text boxes are, in original image pixels —
   *  what a drag has to move. */
  labelPositions(): { id: number; x: number; y: number; w: number; h: number }[]
  /** The leaders the canvas draws, in original image pixels: the parity spec checks that one
   *  moved behind another marker was routed around its ring (#14). */
  leaders(): { id: number; from: [number, number]; to: [number, number] }[]
  /** The selected object ids, for the spec that drives clicks and shift-clicks. */
  selectedIds(): number[]
  renderAt(scale: number): string
}

declare global {
  interface Window {
    __astrocaptionEditor?: EditorTestHook
  }
}

interface Entry {
  label: Label
  obj: ObjectOut
  box: LabelBox
  text: LabelLines
  seg: LeaderSegment | null
  leader: boolean
}

const HOVER_COLOR = '#8ab4ff'

// Only the left button ever drags a label: the middle button is a pan gesture everywhere on the
// canvas (SPEC § 6.1), and Konva would otherwise start a drag with it.
Konva.dragButtons = [0]

/** Every enabled object's ring, keyed by object id: the obstacles a leader routes around (#14).
 *  Its identity only changes with the enabled set, the objects or the style, never on a drag
 *  frame, so it can key the entry cache. */
type Rings = ReadonlyMap<number, Ring>

/** Layout numbers per label, memoised on the label's identity. A drag replaces one `Label` object
 *  per frame (the store never mutates them), so without this every other label would be measured
 *  again 60 times a second. A hit is only reused while the style, the rings and the object behind
 *  it are the same objects; the maps are weak, so a replaced label or style needs no eviction. */
const entryCache = new WeakMap<StyleConfig, WeakMap<Rings, WeakMap<Label, Entry>>>()

function entryFor(
  style: StyleConfig,
  rings: Rings,
  label: Label,
  obj: ObjectOut,
  measure: TextMeasurer,
  unit: number,
): Entry {
  let byRings = entryCache.get(style)
  if (!byRings) {
    byRings = new WeakMap<Rings, WeakMap<Label, Entry>>()
    entryCache.set(style, byRings)
  }
  let byLabel = byRings.get(rings)
  if (!byLabel) {
    byLabel = new WeakMap<Label, Entry>()
    byRings.set(rings, byLabel)
  }
  const hit = byLabel.get(label)
  if (hit && hit.obj === obj) return hit
  const box = measureLabel(measure, style, label, obj)
  const others: Ring[] = []
  for (const [id, ring] of rings) if (id !== label.object_id) others.push(ring)
  const seg = leaderSegment(
    obj.x,
    obj.y,
    markerRadius(obj, style),
    { left: label.x, top: label.y, right: label.x + box.width, bottom: label.y + box.height },
    others,
    PAD_FACTOR * unit,
  )
  const entry: Entry = {
    label,
    obj,
    box,
    text: labelText(obj, label, style),
    seg,
    leader: seg !== null && leaderVisible(label, seg.gap, unit),
  }
  byLabel.set(label, entry)
  return entry
}

interface EntryProps {
  entry: Entry
  style: StyleConfig
  font: FontOut
  editable: boolean
  onPress: (id: number, shift: boolean) => void
  /** A press that turned out to be a click, not a drag (the canvas checks `movedRef`). */
  onClick: (id: number, shift: boolean) => void
  onDoubleClick: (id: number) => void
  moveLabel: (id: number, x: number, y: number, commit?: boolean) => void
  /** Whether Space is held: a pan gesture, which wins over selecting or dragging a label. Held in
   *  React state so `draggable` can turn off before Konva sees the press. */
  spacePan: boolean
  onDrawError: (id: number, message: string) => void
}

/** One object's marker, leader and draggable label. Memoised on the cached `Entry`, so a drag
 *  frame re-renders the dragged label only, not every label on the layer. `spacePan` is a plain
 *  prop, not part of `Entry`, so a Space press or release still re-renders every label once (it
 *  flips `draggable` on each of them). */
const LabelEntry = memo(function LabelEntry({
  entry: { label, obj, box, text, seg, leader },
  style,
  font,
  editable,
  onPress,
  onClick,
  onDoubleClick,
  moveLabel,
  spacePan,
  onDrawError,
}: EntryProps) {
  return (
    <Group>
      {/* Not the stored radius: the stroke sits half a marker width inside it so Konva's
          centred stroke lands where Pillow's inward outline does (see markerStrokeRadius). */}
      <Circle
        x={obj.x}
        y={obj.y}
        radius={markerStrokeRadius(obj, style)}
        stroke={style.marker_color}
        strokeWidth={style.marker_width}
        listening={false}
      />
      {seg && leader && (
        <Line
          points={[seg.from[0], seg.from[1], seg.to[0], seg.to[1]]}
          stroke={style.leader_color}
          strokeWidth={style.marker_width}
          listening={false}
        />
      )}
      {/* The group carries the position, so a drag is `e.target.x()/y()` in original pixels
          (neither this layer nor the parent group has a transform of its own). */}
      <Group
        x={label.x}
        y={label.y}
        // Not draggable during a Space-pan: Konva then never starts the drag, so there is nothing
        // to suppress. Konva.dragButtons keeps the middle button out too.
        draggable={editable && !spacePan}
        onMouseDown={(e) => {
          // Space-drag and the middle button pan anywhere on the canvas, labels included: the
          // press bubbles to the stage, which starts the pan. A plain press also bubbles, so the
          // stage records it and `movedRef` can tell a later click from a drag; the stage does not
          // pan for it because the target is this group, not the stage.
          // Left button only: the middle button pans, and the right button opens the context
          // menu, whose swallowed mouseup would leave the label pressed for the wheel to resize.
          if (spacePan || e.evt.button !== 0) return
          onPress(label.object_id, e.evt.shiftKey)
        }}
        onClick={(e) => {
          if (e.evt.button === 0 && !spacePan) onClick(label.object_id, e.evt.shiftKey)
        }}
        onDblClick={(e) => {
          // Gated on `editable` like every other document change: a read-only document has no
          // text editor to open, and the store would refuse the commit anyway.
          if (editable && e.evt.button === 0 && !spacePan) onDoubleClick(label.object_id)
        }}
        onDragStart={() => {
          // A drag begun without a press we saw (a synthetic one) still selects the label.
          const s = useEditor.getState()
          if (!s.selectedIds.has(label.object_id)) s.select(label.object_id)
        }}
        onDragMove={(e) => moveLabel(label.object_id, e.target.x(), e.target.y(), false)}
        onDragEnd={(e) => moveLabel(label.object_id, e.target.x(), e.target.y())}
      >
        <LabelTextShape
          // A new font is a fresh attempt: remounting drops the shape's "already failed" flag, so
          // a label that failed under the old file draws again instead of staying blank.
          key={style.font_file}
          label={label}
          style={style}
          font={font}
          box={box}
          text={text}
          onDrawError={(m) => onDrawError(label.object_id, m)}
        />
      </Group>
    </Group>
  )
})

/** The layer that draws exactly what the export draws. It is memoised and deliberately blind to
 *  the view transform (the Stage carries zoom and pan), so panning and zooming never rebuild it. */
const AnnotationLayer = memo(function AnnotationLayer({
  entries,
  badgesRef,
  ...entryProps
}: Omit<EntryProps, 'entry'> & {
  entries: Entry[]
  badgesRef: RefObject<Konva.Group | null>
}) {
  return (
    // Only the label groups listen, and only while the document may be edited: markers and leaders
    // are drawn output, and hover is served by the hit-circle layer underneath.
    <Layer listening={entryProps.editable}>
      {entries.map((entry) => (
        <LabelEntry key={entry.label.object_id} entry={entry} {...entryProps} />
      ))}
      {/* UI chrome, not part of the export: hidden by renderAt. */}
      <Group ref={badgesRef}>
        {entries
          .filter(({ label }) => label.collided)
          .map(({ label, box }) => (
            <Text
              key={label.object_id}
              text="⚠"
              x={label.x + box.width + box.primarySize * 0.2}
              y={label.y}
              fontSize={box.primarySize * 0.6}
              fill="#ffd54a"
              listening={false}
            />
          ))}
      </Group>
    </Layer>
  )
})

export default function EditorCanvas() {
  const image = useEditor((s) => s.image)
  const style = useEditor((s) => s.style)
  const objects = useEditor((s) => s.objects)
  const objectOrder = useEditor((s) => s.objectOrder)
  const view = useEditor((s) => s.view)
  const viewport = useEditor((s) => s.viewport)
  const hoveredId = useEditor((s) => s.hoveredId)
  const selectedIds = useEditor((s) => s.selectedIds)
  const setView = useEditor((s) => s.setView)
  const hover = useEditor((s) => s.hover)
  const moveLabel = useEditor((s) => s.moveLabel)
  // A conflict keeps editing local (design § 5): only the saves stop, not the page.
  const editable = useEditor(isEditable)
  // A stale document (a font the server no longer lists) must throw, not draw in a fallback face.
  const font = useEditor((s) => (s.style ? fontFor(s) : null))
  // useShallow keeps the array identity while the labels themselves are unchanged, so the
  // measuring memo below does not rerun on every pan frame.
  const labels = useEditor(useShallow(enabledLabels))
  // The enabled ids alone: stable across a drag (which replaces labels, not the set), so the
  // rings below, and with them every other label's cached entry, survive the drag's frames.
  const enabledIds = useEditor(useShallow(enabledObjectIds))

  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const overlayRef = useRef<Konva.Layer>(null)
  const badgesRef = useRef<Konva.Group>(null)
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null)
  // Where the last mousedown that reached the stage landed, in screen pixels. Every press reaches
  // it, label presses included; `movedRef` below is what tells a click from a drag.
  const downRef = useRef<{ x: number; y: number } | null>(null)
  // Whether the pointer travelled far enough between that mousedown and the click Konva fires
  // after mouseup for the gesture to be a drag: a pan, or a label drag that happened to end over
  // a marker, is not the click that deselects or toggles.
  const movedRef = useRef(false)
  // The label under a held left button, for wheel-to-resize (SPEC § 6.2): set by the label's
  // mousedown, cleared (and the size preview committed) on the window's mouseup.
  const pressRef = useRef<number | null>(null)
  const [spacePan, setSpacePan] = useState(false)

  // Keyed by the URL it was loaded from, so a second image opened without unmounting can never
  // show the first bitmap (or the first failure) — resetting the state in the effect below would
  // paint the stale bitmap for one frame, and lint forbids the synchronous reset anyway.
  const [loadedPreview, setLoadedPreview] = useState<{
    src: string
    el: HTMLImageElement | null
    error: string | null
  } | null>(null)
  // Each failure remembers the font it happened under: picking another one is a fresh attempt
  // for every label (see the shape's key below), so those entries stop counting.
  const [drawErrors, setDrawErrors] = useState<ReadonlyMap<number, { font: string; message: string }>>(new Map())
  // A toolbar action that threw (the placer measures text, so Reset position can fail). Tagged
  // with the selection it was raised for, the same hook the toolbar's own drafts use, so it
  // clears itself the moment the selection moves on.
  const [toolbarError, setToolbarError] = useTaggedDraft<string>([selectedIds])
  // A marker click whose placement threw. Not tagged with the selection like the toolbar's error:
  // a click on a marker is not a selection change, so it is cleared by the next click.
  const [toggleError, setToggleError] = useState<string | null>(null)
  const [sizeError, setSizeError] = useState<string | null>(null)
  const [panning, setPanning] = useState(false)

  // 1. The viewport: one ResizeObserver, and the first non-zero size fits the image.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let measured = false
    const apply = (w: number, h: number) => {
      measured = true
      setSizeError(null)
      useEditor.getState().setViewport(w, h)
    }
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      const w = Math.floor(rect.width)
      const h = Math.floor(rect.height)
      if (w <= 0 || h <= 0) return
      apply(w, h)
    })
    ro.observe(el)
    // If the first non-zero observation never arrives (a CSS regression, or an observer that
    // never fires), measure once by hand so the failure is visible instead of a black rectangle.
    const fallback = window.setTimeout(() => {
      if (measured) return
      const rect = el.getBoundingClientRect()
      const w = Math.floor(rect.width)
      const h = Math.floor(rect.height)
      if (w > 0 && h > 0) apply(w, h)
      else setSizeError(CANVAS_SIZE_ERROR)
    }, 250)
    return () => {
      window.clearTimeout(fallback)
      ro.disconnect()
    }
  }, [])

  const current = loadedPreview && image && loadedPreview.src === image.preview_url ? loadedPreview : null
  const preview = current?.el ?? null
  const previewError = current?.error ?? null

  // 2. The preview bitmap; until it has loaded the stage draws nothing but the background.
  useEffect(() => {
    if (!image) return
    const src = image.preview_url
    let cancelled = false
    const el = new window.Image()
    el.onload = () => {
      if (!cancelled) setLoadedPreview({ src, el, error: null })
    }
    el.onerror = () => {
      if (cancelled) return
      // The bitmap says only that it failed; the status decides the sentence (a 401 is the
      // session, not the file).
      void probeStatus(src).then((status) => {
        if (!cancelled) setLoadedPreview({ src, el: null, error: previewErrorSentence(status) })
      })
    }
    el.src = src
    return () => {
      cancelled = true
    }
  }, [image])

  // 3. The one offscreen context the editor measures with (design § 3); shared with the placer.
  const measure = getMeasurer()

  // The rings every leader has to clear (#14): one per enabled object.
  const rings = useMemo<Rings>(() => {
    const out = new Map<number, Ring>()
    if (!style) return out
    for (const id of enabledIds) {
      const obj = objects.get(id)
      if (obj) out.set(id, { x: obj.x, y: obj.y, r: markerRadius(obj, style) })
    }
    return out
  }, [enabledIds, objects, style])

  // 4. Every layout number for the enabled labels, recomputed only when the document changes.
  const { entries, orphans } = useMemo<{ entries: Entry[]; orphans: number }>(() => {
    if (!image || !style) return { entries: [], orphans: 0 }
    const out: Entry[] = []
    let orphans = 0
    const unit = scaleUnit(image.width, image.height)
    for (const label of labels) {
      const obj = objects.get(label.object_id)
      // Hidden, not dropped: the save path writes these labels back untouched.
      if (!obj) {
        orphans++
        continue
      }
      out.push(entryFor(style, rings, label, obj, measure, unit))
    }
    return { entries: out, orphans }
  }, [image, style, rings, labels, objects, measure])

  // Every label whose draw threw, in failure order; the notice counts them and names the first.
  // A label that keeps failing reports once (the shape stops drawing after its first throw).
  const onDrawError = useCallback((id: number, message: string) => {
    const font = useEditor.getState().style?.font_file ?? ''
    setDrawErrors((prev) => (prev.has(id) ? prev : new Map(prev).set(id, { font, message })))
  }, [])

  // Only the failures that still stand: of labels the layer still draws (a label disabled, undone
  // away or left behind by a re-solve is no longer failing) and under the current font.
  const liveDrawErrors = useMemo(() => {
    const drawn = new Set(entries.map((e) => e.label.object_id))
    const live = new Map<number, string>()
    for (const [id, { font, message }] of drawErrors) {
      if (drawn.has(id) && font === style?.font_file) live.set(id, message)
    }
    return live
  }, [drawErrors, entries, style])

  // A press selects: plain replaces the selection unless the label is already in it (so a drag
  // of one selected label moves the whole group), shift toggles membership.
  const onLabelPress = useCallback((id: number, shift: boolean) => {
    const s = useEditor.getState()
    if (shift) s.toggleSelect(id)
    else if (!s.selectedIds.has(id)) s.select(id)
    // Read back, not `id`: a shift-click that *removed* the label leaves it without a selection
    // outline, and a wheel must not then resize it.
    pressRef.current = useEditor.getState().selectedIds.has(id) ? id : null
  }, [])

  // ...and the click that follows narrows: a plain click on a label of a group selection leaves
  // that one label selected (SPEC § 6.2). It cannot happen on the press, which has to keep the
  // group so that dragging any of its labels moves them all; and it must not happen after a drag,
  // which is what `movedRef` rules out.
  const onLabelClick = useCallback((id: number, shift: boolean) => {
    if (shift || movedRef.current) return
    const s = useEditor.getState()
    if (s.selectedIds.size > 1 && s.selectedIds.has(id)) s.select(id)
  }, [])

  // Which label a double-click opened for inline text editing.
  const [editingId, setEditingId] = useState<number | null>(null)
  const onLabelDoubleClick = useCallback((id: number) => {
    setEditingId(id)
  }, [])
  const closeEditing = useCallback(() => setEditingId(null), [])

  // 5. Keys, ignored while a form field has the focus.
  useEffect(() => {
    // `f` and `1` must keep working after a toolbar button was clicked, so a focused BUTTON out in
    // the page only blocks Space (which a focused button would take as a click). The label
    // toolbar is the exception: everything in it — the number field and the colour swatch above
    // all — keeps every key, so Escape and Delete stay with the control that has the focus.
    const inField = (withButton = false) => {
      const el = document.activeElement
      if (!el) return false
      // Everything inside the floating toolbar counts as a field, whatever it is: the colour
      // swatch and the picker are buttons and inputs, and Escape there closes the popover while
      // Delete/Backspace edits a hex — neither may clear the selection or disable its labels.
      if (el.closest('.label-toolbar')) return true
      const tags = withButton ? ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'] : ['INPUT', 'TEXTAREA', 'SELECT']
      return tags.includes(el.tagName)
    }
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        // A focused toolbar button would otherwise take Space as a click, and the page would scroll.
        if (inField(true)) return
        e.preventDefault()
        setSpacePan(true)
        return
      }
      // Undo/redo: Ctrl (Cmd on macOS) + Z / Y / Shift+Z. Fields keep their own undo — except a
      // checkbox (an Objects-tab row keeps the focus after a click), which has none, so the
      // editor's history answers from there. Every other shortcut still treats it as a field.
      const el = document.activeElement
      const checkboxFocused = el instanceof HTMLInputElement && el.type === 'checkbox' && !el.closest('.label-toolbar')
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (!inField() || checkboxFocused)) {
        const key = e.key.toLowerCase()
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault()
          useEditor.getState().undoLast()
          return
        }
        if (key === 'y' || (key === 'z' && e.shiftKey)) {
          e.preventDefault()
          useEditor.getState().redoLast()
          return
        }
      }
      if (inField() || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'f' || e.key === 'F') useEditor.getState().fit()
      else if (e.key === '1') useEditor.getState().actual()
      else if (e.key === 'Escape') useEditor.getState().select(null)
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        // Backspace is still "back" in some browsers when nothing has the focus, so it is
        // swallowed here whether or not there is a selection to disable.
        e.preventDefault()
        const s = useEditor.getState()
        if (s.selectedIds.size === 0 || !isEditable(s)) return
        // One commit for the whole selection (SPEC § 6.1). `changedDoc` drops the newly
        // disabled labels from the selection, so nothing is left behind to toggle back on.
        disableAll([...s.selectedIds])
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpacePan(false)
    }
    // A Space released outside the window would otherwise leave every mousedown panning.
    const blur = () => {
      setSpacePan(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // 6. The test hook, live only while the canvas is mounted.
  const renderAt = useCallback(
    (scale: number): string => {
      const stage = stageRef.current
      if (!stage || !image) throw new Error('the editor canvas is not mounted')
      const prev = {
        width: stage.width(),
        height: stage.height(),
        scale: stage.scaleX(),
        x: stage.x(),
        y: stage.y(),
      }
      const overlay = overlayRef.current
      const badges = badgesRef.current
      const overlayShown = overlay?.visible() ?? true
      const badgesShown = badges?.visible() ?? true
      try {
        overlay?.visible(false)
        badges?.visible(false)
        stage.size({ width: Math.ceil(image.width * scale), height: Math.ceil(image.height * scale) })
        stage.scale({ x: scale, y: scale })
        stage.position({ x: 0, y: 0 })
        stage.draw()
        return stage.toDataURL({ pixelRatio: 1, mimeType: 'image/png' })
      } finally {
        overlay?.visible(overlayShown)
        badges?.visible(badgesShown)
        stage.size({ width: prev.width, height: prev.height })
        stage.scale({ x: prev.scale, y: prev.scale })
        stage.position({ x: prev.x, y: prev.y })
        stage.draw()
      }
    },
    [image],
  )

  // The hook reads the entries through a ref so it is not republished on every drag frame.
  const entriesRef = useRef(entries)
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])
  useEffect(() => {
    const stage = stageRef.current
    // Published only once there is something to diff: no preview bitmap (or a failed one) means
    // the stage would render the annotations over an empty background.
    if (!stage || !image || !preview || previewError) return
    window.__astrocaptionEditor = {
      stage,
      imageWidth: image.width,
      imageHeight: image.height,
      get labelCount() {
        return entriesRef.current.length
      },
      labelPositions: () =>
        entriesRef.current.map((e) => ({
          id: e.label.object_id,
          x: e.label.x,
          y: e.label.y,
          w: e.box.width,
          h: e.box.height,
        })),
      leaders: () =>
        entriesRef.current
          .filter((e) => e.leader && e.seg !== null)
          .map((e) => ({ id: e.label.object_id, from: e.seg!.from, to: e.seg!.to })),
      selectedIds: () => [...useEditor.getState().selectedIds],
      renderAt,
    }
    return () => {
      delete window.__astrocaptionEditor
    }
    // `viewport`: the Stage is only mounted once the container has a size, so the hook has to be
    // published again when that first measurement arrives.
  }, [image, renderAt, viewport, preview, previewError])

  const selectedEntries = useMemo(
    () => entries.filter((e) => selectedIds.has(e.label.object_id)),
    [entries, selectedIds],
  )

  // The union of the selected labels' text boxes, in original pixels: where the toolbar sits.
  const selectionBox = useMemo<Box | null>(() => {
    if (selectedEntries.length === 0) return null
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const { label, box } of selectedEntries) {
      left = Math.min(left, label.x)
      top = Math.min(top, label.y)
      right = Math.max(right, label.x + box.width)
      bottom = Math.max(bottom, label.y + box.height)
    }
    return { left, top, right, bottom }
  }, [selectedEntries])

  // The hit targets for hover and the toggle: one transparent circle per object, rebuilt only when
  // the objects, the marker sizes or the zoom (the 8 px floor is in screen pixels) change — not on
  // every pan. They sit on their own layer *below* the labels, so a label drawn inside a big
  // marker (M 42 swallows the Trapezium stars) is still the thing a click on it hits.
  const hitCircles = useMemo(
    () =>
      objectOrder.map((id) => {
        const obj = objects.get(id)
        // `style` is non-null by the time anything renders (the guard below), but this memo is
        // declared before it.
        if (!obj || !style) return null
        return (
          <Circle
            key={id}
            x={obj.x}
            y={obj.y}
            radius={Math.max(markerRadius(obj, style), 8 / view.scale)}
            fill="transparent"
            onMouseEnter={() => hover(id)}
            onMouseLeave={() => hover(null)}
            // Left button only, and not after a pan or a label drag that happened to end over
            // this marker: the click Konva fires then is not a toggle. `tryToggleWithPlacement` catches a
            // placer that throws (a stale font) and says so, rather than a dead click.
            onClick={(e) => {
              if (e.evt.button === 0 && !movedRef.current) tryToggleWithPlacement(id, setToggleError)
            }}
          />
        )
      }),
    [objectOrder, objects, style, view.scale, hover],
  )

  // While a solve runs the toggle above no-ops; the cursor over a marker says so (#76). An effect,
  // not the hover handlers: `editable` can flip while the pointer already rests on a marker, and
  // no mouseenter would follow to correct the cursor.
  useEffect(() => {
    const el = stageRef.current?.container()
    if (!el) return
    if (!editable && hoveredId !== null) el.style.setProperty('cursor', 'not-allowed')
    else el.style.removeProperty('cursor')
  }, [editable, hoveredId])

  // A click on the empty background (never on a label or a marker) clears the selection; a click
  // that ended a pan does not.
  const onStageClick = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.target === stageRef.current && !movedRef.current) useEditor.getState().select(null)
  }

  // 7. Wheel: resize the pressed label (left button held), otherwise zoom about the cursor.
  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const pressed = pressRef.current
    if (pressed !== null && (e.evt.buttons & 1) === 1) {
      // A horizontal trackpad swipe reports deltaY 0; reading it as a notch down would shrink
      // the label on a gesture that never asked for a resize.
      if (e.evt.deltaY === 0) return
      const s = useEditor.getState()
      const label = s.labels.get(pressed)
      if (!label || !s.style) return
      const current = label.font_size ?? s.style.font_size
      const size = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, current + (e.evt.deltaY < 0 ? 1 : -1)))
      s.updateLabels([pressed], { font_size: size }, false)
      return
    }
    const stage = stageRef.current
    const pointer = stage?.getPointerPosition()
    if (!pointer) return
    setView(zoomAt(view, pointer.x, pointer.y, Math.exp(-e.evt.deltaY * 0.0015)))
  }

  // 8. Pan: empty canvas, the middle button, or space held down.
  const onMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    // Konva fires on the shape first and bubbles up to the stage, so a label's own mousedown has
    // already recorded the press by the time this runs: only a press that can never start a
    // wheel-resize may clear it. A right-click's mouseup is swallowed by the context menu, which
    // would otherwise leave the previous press standing.
    if (e.evt.button !== 0) pressRef.current = null
    const stage = stageRef.current
    if (!stage) return
    movedRef.current = false
    const pointer = stage.getPointerPosition()
    // Recorded for every press that reaches the stage, pan or not: a Space-pan begun on a marker
    // ends with a click on that marker, and only the displacement below tells the two apart.
    downRef.current = pointer ? { x: pointer.x, y: pointer.y } : null
    if (!(e.target === stage || e.evt.button === 1 || spacePan)) return
    if (!pointer) return
    e.evt.preventDefault()
    panRef.current = { sx: pointer.x, sy: pointer.y, vx: view.x, vy: view.y }
    setPanning(true)
  }

  const onMouseMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const pointer = stageRef.current?.getPointerPosition()
    if (!pointer) return
    // 3 screen pixels of slack, so a hand that shifts while clicking still counts as a click.
    const down = downRef.current
    if (down && e.evt.buttons !== 0 && Math.hypot(pointer.x - down.x, pointer.y - down.y) > 3) {
      movedRef.current = true
    }
    const start = panRef.current
    if (!start) return
    setView({ scale: view.scale, x: start.vx + (pointer.x - start.sx), y: start.vy + (pointer.y - start.sy) })
  }

  // spacePan is not cleared here: Space owns only whether the *next* mousedown pans, and the
  // window `blur` listener above already resets it when the key-up would be missed.
  const stopPan = useCallback(() => {
    if (!panRef.current) return
    panRef.current = null
    setPanning(false)
  }, [])

  // A mouseup outside the stage (or outside the window) has to end the pan too; onMouseLeave
  // alone would leave the canvas panning after the button came up elsewhere.
  useEffect(() => {
    if (!panning) return
    window.addEventListener('mouseup', stopPan)
    return () => window.removeEventListener('mouseup', stopPan)
  }, [panning, stopPan])

  // The wheel-resize preview is committed when the button comes up, wherever that happens — and
  // when the pointer or the focus is lost instead, because a release outside the window fires no
  // mouseup here and would strand the preview on the canvas under a "Saved" status.
  //
  // Run inline: whether this listener or Konva's own window mouseup (which fires `dragend`) gets
  // there first no longer matters. A drag's *preview* frames already carry the pin (`moveLabel`
  // in store.ts), so committing them here produces exactly the label `dragend` would have
  // committed, and whichever runs second finds the maps identical and records nothing.
  useEffect(() => {
    // The button really came up, or the pointer was taken away: the gesture is over either way.
    const up = () => {
      if (pressRef.current === null) return
      pressRef.current = null
      useEditor.getState().commitPreview()
    }
    // Losing the focus or the tab is only the end of the gesture when Konva is not mid-drag: the
    // button is still down there, dragmove and dragend are still coming, and committing now would
    // split one drag into two undo entries and take the pressed label away from the wheel for the
    // rest of the press. A wheel-only press has no Konva drag, so it still commits here.
    const away = () => {
      if (!Konva.isDragging()) up()
    }
    // `visibilitychange` fires on the way back too; only the tab going away ends anything.
    const hidden = () => {
      if (document.visibilityState === 'hidden') away()
    }
    window.addEventListener('mouseup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', away)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('mouseup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', away)
      document.removeEventListener('visibilitychange', hidden)
      // Unmounting mid-gesture (the route changed under a held button) must not lose the preview
      // either: `up` is a no-op unless a label is still pressed.
      up()
    }
  }, [])

  if (!image || !style || !font) return null

  const hovered = hoveredId === null ? null : (objects.get(hoveredId) ?? null)
  const tip = hovered ? toScreen(view, hovered.x, hovered.y) : null
  // A label disabled or removed while the text editor is open (an undo, a re-solve) stops being
  // drawn, so this resolves to null and the child unmounts — before its own close effect can run.
  // `editingId` would then stay set and pop the editor open again the moment an undo brought the
  // label back. Adjusting state during render is React's own answer to derived state that has gone
  // stale (an effect would be `set-state-in-effect`, which lint refuses): the re-render happens
  // before anything is committed to the DOM.
  const editing = editingId === null ? null : (entries.find((e) => e.label.object_id === editingId) ?? null)
  if (editingId !== null && editing === null) setEditingId(null)

  const notices: { text: string; error: boolean }[] = []
  if (previewError) notices.push({ text: previewError, error: true })
  if (sizeError) notices.push({ text: sizeError, error: true })
  if (liveDrawErrors.size > 0) {
    const [firstId, firstMessage] = liveDrawErrors.entries().next().value as [number, string]
    const first = objects.get(firstId)
    const name = first ? primaryName(first.catalog_names, style.name_preference) : `object ${firstId}`
    notices.push({ text: drawErrorNotice(liveDrawErrors.size, name, firstMessage), error: true })
  }
  if (toolbarError) notices.push({ text: toolbarError, error: true })
  if (toggleError) notices.push({ text: toggleError, error: true })
  if (orphans > 0) {
    notices.push({
      text: `${orphans} label(s) refer to objects this image no longer has; they are not shown.`,
      error: false,
    })
  }

  return (
    <>
      {notices.map((n) => (
        <div key={n.text} className={n.error ? 'notice error' : 'notice'}>
          {n.text}
        </div>
      ))}
      <div ref={containerRef} className={`editor-canvas${panning ? ' panning' : ''}`}>
        {viewport.w > 0 && (
          <Stage
            ref={stageRef}
            width={viewport.w}
            height={viewport.h}
            scaleX={view.scale}
            scaleY={view.scale}
            x={view.x}
            y={view.y}
            onWheel={onWheel}
            onMouseDown={onMouseDown}
            onClick={onStageClick}
            onMouseMove={onMouseMove}
            onMouseUp={stopPan}
            onMouseLeave={stopPan}
          >
            <Layer listening={false}>
              {preview && <KImage image={preview} width={image.width} height={image.height} />}
            </Layer>
            {/* Below the labels on purpose (see hitCircles). It keeps listening while the document
                is read-only: hover and the tooltip are not edits, and the toggle itself is gated
                by `toggleWithPlacement`. */}
            <Layer>{hitCircles}</Layer>
            <AnnotationLayer
              entries={entries}
              style={style}
              font={font}
              editable={editable}
              onPress={onLabelPress}
              onClick={onLabelClick}
              onDoubleClick={onLabelDoubleClick}
              moveLabel={moveLabel}
              spacePan={spacePan}
              onDrawError={onDrawError}
              badgesRef={badgesRef}
            />
            {/* Chrome only, and none of it listens: `renderAt` hides this layer to diff the
                canvas against the server's render. */}
            <Layer ref={overlayRef} listening={false}>
              {selectedEntries.map(({ label, box }) => (
                <Rect
                  key={label.object_id}
                  x={label.x}
                  y={label.y}
                  width={box.width}
                  height={box.height}
                  stroke={HOVER_COLOR}
                  strokeWidth={1 / view.scale}
                  listening={false}
                />
              ))}
              {hovered && (
                <Circle
                  x={hovered.x}
                  y={hovered.y}
                  radius={markerRadius(hovered, style) + 4 / view.scale}
                  stroke={HOVER_COLOR}
                  strokeWidth={2 / view.scale}
                  listening={false}
                />
              )}
            </Layer>
          </Stage>
        )}
        {hovered && tip && (
          <div className="editor-tooltip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
            {primaryName(hovered.catalog_names, style.name_preference)}
          </div>
        )}
        {/* Hidden while the text editor is open, so the two overlays never stack. */}
        {selectionBox && editing === null && <LabelToolbar box={selectionBox} onError={setToolbarError} />}
        {editing && (
          <LabelTextEditor
            key={editing.label.object_id}
            id={editing.label.object_id}
            x={editing.label.x}
            y={editing.label.y}
            width={editing.box.width}
            fontSize={editing.box.primarySize}
            onClose={closeEditing}
          />
        )}
      </div>
    </>
  )
}
