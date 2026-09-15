import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Circle, Group, Image as KImage, Layer, Line, Rect, Stage, Text } from 'react-konva'
import Konva from 'konva'
import { useShallow } from 'zustand/react/shallow'
import type { FontOut, Label, ObjectOut, StyleConfig } from '../api'
import { LabelTextShape } from './LabelTextShape'
import { getMeasurer, isEditable, toggleWithPlacement } from './editing'
import {
  labelText,
  leaderSegment,
  leaderVisible,
  markerRadius,
  markerStrokeRadius,
  measureLabel,
  scaleUnit,
  type LabelBox,
  type LabelLines,
  type LeaderSegment,
  type TextMeasurer,
} from './metrics'
import { enabledLabels, fontFor, useEditor } from './store'
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
  /** The original image width, so a caller can pick the scale that matches a server render. */
  imageWidth: number
  /** How many enabled labels the canvas actually drew (orphaned ones are not counted). */
  labelCount: number
  /** Where the drawn labels sit, in original image pixels — what a drag has to move. */
  labelPositions(): { id: number; x: number; y: number }[]
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

/** Layout numbers per label, memoised on the label's identity. A drag replaces one `Label` object
 *  per frame (the store never mutates them), so without this every other label would be measured
 *  again 60 times a second. A hit is only reused while the style and the object behind it are the
 *  same objects; the maps are weak, so a replaced label or style needs no eviction. */
const entryCache = new WeakMap<StyleConfig, WeakMap<Label, Entry>>()

function entryFor(style: StyleConfig, label: Label, obj: ObjectOut, measure: TextMeasurer, unit: number): Entry {
  let byLabel = entryCache.get(style)
  if (!byLabel) {
    byLabel = new WeakMap<Label, Entry>()
    entryCache.set(style, byLabel)
  }
  const hit = byLabel.get(label)
  if (hit && hit.obj === obj) return hit
  const box = measureLabel(measure, style, label, obj)
  const seg = leaderSegment(obj.x, obj.y, markerRadius(obj, style), {
    left: label.x,
    top: label.y,
    right: label.x + box.width,
    bottom: label.y + box.height,
  })
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
  select: (id: number | null) => void
  moveLabel: (id: number, x: number, y: number, commit?: boolean) => void
  /** Whether Space is held: a pan gesture, which wins over selecting or dragging a label. Held in
   *  React state so `draggable` can turn off before Konva sees the press. */
  spacePan: boolean
  onDrawError: (message: string) => void
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
  select,
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
          if (spacePan || e.evt.button === 1) return
          select(label.object_id)
        }}
        onDragStart={() => select(label.object_id)}
        onDragMove={(e) => moveLabel(label.object_id, e.target.x(), e.target.y(), false)}
        onDragEnd={(e) => moveLabel(label.object_id, e.target.x(), e.target.y())}
      >
        <LabelTextShape label={label} style={style} font={font} box={box} text={text} onDrawError={onDrawError} />
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
  const selectedId = useEditor((s) => s.selectedId)
  const setView = useEditor((s) => s.setView)
  const hover = useEditor((s) => s.hover)
  const select = useEditor((s) => s.select)
  const moveLabel = useEditor((s) => s.moveLabel)
  // A conflict keeps editing local (design § 5): only the saves stop, not the page.
  const editable = useEditor(isEditable)
  // A stale document (a font the server no longer lists) must throw, not draw in a fallback face.
  const font = useEditor((s) => (s.style ? fontFor(s) : null))
  // useShallow keeps the array identity while the labels themselves are unchanged, so the
  // measuring memo below does not rerun on every pan frame.
  const labels = useEditor(useShallow(enabledLabels))

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
  const [spacePan, setSpacePan] = useState(false)

  // Keyed by the URL it was loaded from, so a second image opened without unmounting can never
  // show the first bitmap (or the first failure) — resetting the state in the effect below would
  // paint the stale bitmap for one frame, and lint forbids the synchronous reset anyway.
  const [loadedPreview, setLoadedPreview] = useState<{
    src: string
    el: HTMLImageElement | null
    error: string | null
  } | null>(null)
  const [drawError, setDrawError] = useState<string | null>(null)
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
      else setSizeError('The editor could not size its canvas.')
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
      if (!cancelled) {
        setLoadedPreview({
          src,
          el: null,
          error:
            'The preview image for this photo could not be loaded. Reload the page; if it keeps failing, re-upload the image.',
        })
      }
    }
    el.src = src
    return () => {
      cancelled = true
    }
  }, [image])

  // 3. The one offscreen context the editor measures with (design § 3); shared with the placer.
  const measure = getMeasurer()

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
      out.push(entryFor(style, label, obj, measure, unit))
    }
    return { entries: out, orphans }
  }, [image, style, labels, objects, measure])

  // The first draw failure of any label becomes one notice; the shape itself stops drawing.
  const onDrawError = useCallback((message: string) => {
    setDrawError((prev) => prev ?? message)
  }, [])

  // 5. Keys, ignored while a form field has the focus.
  useEffect(() => {
    // `f` and `1` must keep working after a toolbar button was clicked, so a focused BUTTON only
    // blocks Space (which a focused button would take as a click).
    const inField = (withButton = false) => {
      const el = document.activeElement
      const tags = withButton ? ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'] : ['INPUT', 'TEXTAREA', 'SELECT']
      return !!el && tags.includes(el.tagName)
    }
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        // A focused toolbar button would otherwise take Space as a click, and the page would scroll.
        if (inField(true)) return
        e.preventDefault()
        setSpacePan(true)
        return
      }
      // Undo/redo: Ctrl (Cmd on macOS) + Z / Y / Shift+Z. Fields keep their own undo.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !inField()) {
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
        if (s.selectedId === null || !isEditable(s)) return
        toggleWithPlacement(s.selectedId)
        s.select(null)
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
      get labelCount() {
        return entriesRef.current.length
      },
      labelPositions: () =>
        entriesRef.current.map((e) => ({ id: e.label.object_id, x: e.label.x, y: e.label.y })),
      renderAt,
    }
    return () => {
      delete window.__astrocaptionEditor
    }
    // `viewport`: the Stage is only mounted once the container has a size, so the hook has to be
    // published again when that first measurement arrives.
  }, [image, renderAt, viewport, preview, previewError])

  const selected = useMemo(
    () => entries.find((e) => e.label.object_id === selectedId) ?? null,
    [entries, selectedId],
  )

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
            // this marker: the click Konva fires then is not a toggle.
            onClick={(e) => {
              if (e.evt.button === 0 && !movedRef.current) toggleWithPlacement(id)
            }}
          />
        )
      }),
    [objectOrder, objects, style, view.scale, hover],
  )

  // A click on the empty background (never on a label or a marker) clears the selection; a click
  // that ended a pan does not.
  const onStageClick = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.target === stageRef.current && !movedRef.current) select(null)
  }

  // 7. Wheel zoom about the cursor.
  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const stage = stageRef.current
    const pointer = stage?.getPointerPosition()
    if (!pointer) return
    setView(zoomAt(view, pointer.x, pointer.y, Math.exp(-e.evt.deltaY * 0.0015)))
  }

  // 8. Pan: empty canvas, the middle button, or space held down.
  const onMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
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

  if (!image || !style || !font) return null

  const hovered = hoveredId === null ? null : (objects.get(hoveredId) ?? null)
  const tip = hovered ? toScreen(view, hovered.x, hovered.y) : null

  const notices: { text: string; error: boolean }[] = []
  if (previewError) notices.push({ text: previewError, error: true })
  if (sizeError) notices.push({ text: sizeError, error: true })
  if (drawError) notices.push({ text: `Some labels could not be drawn: ${drawError}`, error: true })
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
              select={select}
              moveLabel={moveLabel}
              spacePan={spacePan}
              onDrawError={onDrawError}
              badgesRef={badgesRef}
            />
            {/* Chrome only, and none of it listens: `renderAt` hides this layer to diff the
                canvas against the server's render. */}
            <Layer ref={overlayRef} listening={false}>
              {selected && (
                <Rect
                  x={selected.label.x}
                  y={selected.label.y}
                  width={selected.box.width}
                  height={selected.box.height}
                  stroke={HOVER_COLOR}
                  strokeWidth={1 / view.scale}
                  listening={false}
                />
              )}
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
            {hovered.primary_name}
          </div>
        )}
      </div>
    </>
  )
}
