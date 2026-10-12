import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Circle, Group, Image as KImage, Layer, Line, Rect, Stage, Text } from 'react-konva'
import Konva from 'konva'
import { useShallow } from 'zustand/react/shallow'
import type { FontOut, Label, ObjectOut, StyleConfig } from '../api'
import LabelTextEditor from './LabelTextEditor'
import LabelToolbar from './LabelToolbar'
import { LabelTextShape } from './LabelTextShape'
import { useCanvasGestures } from './canvasGestures'
import { getMeasurer, isEditable, tryToggleWithPlacement } from './editing'
import { primaryName } from './names'
import { PAD_FACTOR } from './placement'
import { CANVAS_SIZE_ERROR, blockedLeaderNotice, drawErrorNotice, previewErrorSentence, probeStatus } from './notices'
import {
  labelText,
  leaderSegment,
  leaderVisible,
  routeLeader,
  markerRadius,
  markerRing,
  markerStroke,
  measureLabel,
  scaleUnit,
  type Box,
  type Circle as Ring,
  type LabelBox,
  type LabelLines,
  type RoutedLeader,
  type TextMeasurer,
} from './metrics'
import { enabledLabels, enabledObjectIds, fontFor, hasLivePreview, useEditor } from './store'
import { useTaggedDraft } from './taggedDraft'
import { toScreen } from './view'

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
  /** Where the leaders the canvas draws end, in original image pixels: the parity spec checks
   *  that one moved behind another marker was routed around its ring (#14). */
  leaders(): { id: number; to: [number, number] }[]
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
  /** The leader as drawn, routed around other markers' rings; null when none is drawn. */
  leader: RoutedLeader | null
}

const HOVER_COLOR = '#8ab4ff'

// Only the left button ever drags a label: the middle button is a pan gesture everywhere on the
// canvas (SPEC § 6.1), and Konva would otherwise start a drag with it.
Konva.dragButtons = [0]

/** Every enabled object's ring, keyed by object id: the obstacles a leader routes around (#14).
 *  Its identity only changes with the enabled set, the objects or the style, never on a drag
 *  frame. */
type Rings = ReadonlyMap<number, Ring>

interface Measured {
  obj: ObjectOut
  box: LabelBox
  text: LabelLines
}

/** Text measurements per label, memoised on the label's identity. A drag replaces one `Label`
 *  object per frame (the store never mutates them), so without this every other label would be
 *  measured again 60 times a second. A hit is only reused while the style and the object behind
 *  it are the same objects; the maps are weak, so a replaced label or style needs no eviction. */
const measureCache = new WeakMap<StyleConfig, WeakMap<Label, Measured>>()

function cached<K extends object, V>(map: WeakMap<K, V>, key: K, make: () => V): V {
  let value = map.get(key)
  if (value === undefined) {
    value = make()
    map.set(key, value)
  }
  return value
}

function measuredFor(style: StyleConfig, label: Label, obj: ObjectOut, measure: TextMeasurer): Measured {
  const byLabel = cached(measureCache, style, () => new WeakMap<Label, Measured>())
  const hit = byLabel.get(label)
  if (hit && hit.obj === obj) return hit
  const measured: Measured = { obj, box: measureLabel(measure, style, label, obj), text: labelText(obj, label, style) }
  byLabel.set(label, measured)
  return measured
}

/** Every enabled label's drawn numbers. The measurements come from the cache; the leaders are
 *  routed afresh each time, since any label's move can change another's route: a leader avoids
 *  the other labels' text boxes as well as their rings (#118). */
function entriesFor(
  style: StyleConfig,
  rings: Rings,
  measured: { label: Label; obj: ObjectOut; box: LabelBox; text: LabelLines }[],
  unit: number,
): Entry[] {
  const pad = PAD_FACTOR * unit
  const rects = measured.map(({ label, box }) => ({
    id: label.object_id,
    rect: { left: label.x, top: label.y, right: label.x + box.width, bottom: label.y + box.height } as Box,
  }))
  return measured.map(({ label, obj, box, text }, i) => {
    const r = markerRadius(obj, style)
    const rect = rects[i]!.rect
    const seg = leaderSegment(obj.x, obj.y, r, rect)
    let leader: RoutedLeader | null = null
    if (seg !== null && leaderVisible(label, seg.gap, unit)) {
      const others: Ring[] = []
      for (const [id, ring] of rings) if (id !== label.object_id) others.push(ring)
      const texts: Box[] = []
      for (const other of rects) if (other.id !== label.object_id) texts.push(other.rect)
      leader = routeLeader(seg, obj.x, obj.y, r, rect, others, pad, texts)
    }
    return { label, obj, box, text, leader }
  })
}

interface EntryProps {
  entry: Entry
  style: StyleConfig
  font: FontOut
  editable: boolean
  onPress: (id: number, shift: boolean) => void
  /** A press that turned out to be a click, not a drag (the gesture hook checks its `movedRef`). */
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
  entry: { label, obj, box, text, leader },
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
  const ring = markerStroke(obj, style)
  return (
    <Group>
      {/* Not the stored radius: the stroke sits half a marker width inside it so Konva's
          centred stroke lands where Pillow's inward outline does (see markerStroke). */}
      <Circle
        x={obj.x}
        y={obj.y}
        radius={ring.radius}
        stroke={style.marker_color}
        strokeWidth={ring.width}
        listening={false}
      />
      {leader && (
        <Line
          points={[leader.from[0], leader.from[1], leader.to[0], leader.to[1]]}
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
  const gestures = useCanvasGestures(stageRef)
  const { moved } = gestures

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
      if (obj) out.set(id, markerRing(obj, style))
    }
    return out
  }, [enabledIds, objects, style])

  // 4. Every layout number for the enabled labels, recomputed only when the document changes.
  const { entries, orphans } = useMemo<{ entries: Entry[]; orphans: number }>(() => {
    if (!image || !style) return { entries: [], orphans: 0 }
    const measured: { label: Label; obj: ObjectOut; box: LabelBox; text: LabelLines }[] = []
    let orphans = 0
    const unit = scaleUnit(image.width, image.height)
    for (const label of labels) {
      const obj = objects.get(label.object_id)
      // Hidden, not dropped: the save path writes these labels back untouched.
      if (!obj) {
        orphans++
        continue
      }
      measured.push({ label, ...measuredFor(style, label, obj, measure) })
    }
    return { entries: entriesFor(style, rings, measured, unit), orphans }
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

  // Which label a double-click opened for inline text editing.
  const [editingId, setEditingId] = useState<number | null>(null)
  const onLabelDoubleClick = useCallback((id: number) => {
    setEditingId(id)
  }, [])
  const closeEditing = useCallback(() => setEditingId(null), [])

  // 5. The test hook, live only while the canvas is mounted.
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
      leaders: () => entriesRef.current.flatMap((e) => (e.leader ? [{ id: e.label.object_id, to: e.leader.to }] : [])),
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
              if (e.evt.button === 0 && !moved()) tryToggleWithPlacement(id, setToggleError)
            }}
          />
        )
      }),
    [objectOrder, objects, style, view.scale, hover, moved],
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

  // The blocked-leader notice (#119) follows the committed document, not the drag preview: the
  // verdict can flip every frame while a label skims a neighbour, and a notice popping in and out
  // above the canvas also resizes the stage under the pointer. It settles on the drop. Adjusted
  // during render like `editingId` below (lint refuses `set-state-in-effect`).
  const livePreview = useEditor(hasLivePreview)
  const settledBlockedNotice = useMemo<string | null | undefined>(() => {
    if (livePreview || !style) return undefined // keep what is showing
    const blocked = entries.filter((e) => e.leader?.blocked)
    if (blocked.length === 0) return null
    const first = blocked[0]!.obj
    return blockedLeaderNotice(blocked.length, primaryName(first.catalog_names, style.name_preference))
  }, [livePreview, entries, style])
  const [blockedNotice, setBlockedNotice] = useState<string | null>(null)
  if (settledBlockedNotice !== undefined && settledBlockedNotice !== blockedNotice) setBlockedNotice(settledBlockedNotice)

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
  if (blockedNotice) notices.push({ text: blockedNotice, error: false })

  return (
    <>
      {notices.map((n) => (
        <div key={n.text} className={n.error ? 'notice error' : 'notice'}>
          {n.text}
        </div>
      ))}
      <div ref={containerRef} className={`editor-canvas${gestures.panning ? ' panning' : ''}`}>
        {viewport.w > 0 && (
          <Stage
            ref={stageRef}
            width={viewport.w}
            height={viewport.h}
            scaleX={view.scale}
            scaleY={view.scale}
            x={view.x}
            y={view.y}
            {...gestures.stage}
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
              onPress={gestures.label.onPress}
              onClick={gestures.label.onClick}
              onDoubleClick={onLabelDoubleClick}
              moveLabel={moveLabel}
              spacePan={gestures.spacePan}
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
