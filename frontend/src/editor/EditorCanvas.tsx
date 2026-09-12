import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Circle, Group, Image as KImage, Layer, Line, Rect, Stage, Text } from 'react-konva'
import type Konva from 'konva'
import { useShallow } from 'zustand/react/shallow'
import type { FontOut, Label, ObjectOut, StyleConfig } from '../api'
import { LabelTextShape } from './LabelTextShape'
import {
  canvasMeasurer,
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
} from './metrics'
import { enabledLabels, fontFor, useEditor } from './store'
import { actualSize, fitView, toScreen, zoomAt } from './view'

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
  renderAt(scale: number): string
}

declare global {
  interface Window {
    __astrocaptionEditor?: EditorTestHook
  }
}

/** Fit and 100 % are driven from the page's toolbar as well as from the keyboard, and only the
 *  canvas knows the viewport size, so it publishes the two actions through this ref. */
export interface CanvasControls {
  fit(): void
  actual(): void
}

interface Entry {
  label: Label
  obj: ObjectOut
  box: LabelBox
  text: LabelLines
  radius: number
  seg: LeaderSegment | null
  leader: boolean
}

const HOVER_COLOR = '#8ab4ff'

/** The layer that draws exactly what the export draws. It is memoised and deliberately blind to
 *  the view transform (the Stage carries zoom and pan), so panning and zooming never rebuild it. */
const AnnotationLayer = memo(function AnnotationLayer({
  entries,
  style,
  font,
  onDrawError,
  badgesRef,
}: {
  entries: Entry[]
  style: StyleConfig
  font: FontOut
  onDrawError: (message: string) => void
  badgesRef: RefObject<Konva.Group | null>
}) {
  return (
    // Hover is served by the overlay's hit circles, so nothing here has to listen.
    // PR 5: drag/select will turn this on.
    <Layer listening={false}>
      {entries.map(({ label, obj, box, text, seg, leader }) => (
        <Group key={label.object_id}>
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
          <LabelTextShape label={label} style={style} font={font} box={box} text={text} onDrawError={onDrawError} />
        </Group>
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

export default function EditorCanvas({ controlsRef }: { controlsRef?: RefObject<CanvasControls | null> }) {
  const image = useEditor((s) => s.image)
  const style = useEditor((s) => s.style)
  const objects = useEditor((s) => s.objects)
  const objectOrder = useEditor((s) => s.objectOrder)
  const view = useEditor((s) => s.view)
  const hoveredId = useEditor((s) => s.hoveredId)
  const selectedId = useEditor((s) => s.selectedId)
  const setView = useEditor((s) => s.setView)
  const hover = useEditor((s) => s.hover)
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
  const spaceRef = useRef(false)
  const fittedRef = useRef(false)

  const [viewport, setViewport] = useState({ w: 0, h: 0 })
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
      setViewport((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
      if (!fittedRef.current && image) {
        fittedRef.current = true
        setView(fitView(image.width, image.height, w, h))
      }
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
  }, [image, setView])

  const current = loadedPreview && image && loadedPreview.src === image.preview_url ? loadedPreview : null
  const preview = current?.el ?? null
  const previewError = current?.error ?? null

  // 2. The preview bitmap; until it has loaded the stage draws nothing but the background.
  useEffect(() => {
    if (!image) return
    // A new image has to be fitted again; the view of the previous one means nothing here.
    fittedRef.current = false
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

  // 3. One offscreen context for every width the canvas measures (design § 3).
  const measure = useMemo(() => {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) throw new Error('This browser could not open a canvas to measure text with.')
    return canvasMeasurer(ctx)
  }, [])

  // 4. Every layout number for the enabled labels, recomputed only when the document changes.
  const { entries, orphans } = useMemo<{ entries: Entry[]; orphans: number }>(() => {
    if (!image || !style) return { entries: [], orphans: 0 }
    const out: Entry[] = []
    let orphans = 0
    const s = scaleUnit(image.width, image.height)
    for (const label of labels) {
      const obj = objects.get(label.object_id)
      // PR 5: these labels are hidden, not dropped — the save path must write them back.
      if (!obj) {
        orphans++
        continue
      }
      const box = measureLabel(measure, style, label, obj)
      const radius = markerRadius(obj, style)
      const seg = leaderSegment(obj.x, obj.y, radius, {
        left: label.x,
        top: label.y,
        right: label.x + box.width,
        bottom: label.y + box.height,
      })
      out.push({
        label,
        obj,
        box,
        text: labelText(obj, label, style),
        radius,
        seg,
        leader: seg !== null && leaderVisible(label, seg.gap, s),
      })
    }
    return { entries: out, orphans }
  }, [image, style, labels, objects, measure])

  // The first draw failure of any label becomes one notice; the shape itself stops drawing.
  const onDrawError = useCallback((message: string) => {
    setDrawError((prev) => prev ?? message)
  }, [])

  const fit = useCallback(() => {
    const { image: img, setView: apply } = useEditor.getState()
    if (!img || viewport.w <= 0) return
    apply(fitView(img.width, img.height, viewport.w, viewport.h))
  }, [viewport])

  const actual = useCallback(() => {
    const { view: current, setView: apply } = useEditor.getState()
    if (viewport.w <= 0) return
    apply(actualSize(current, viewport.w, viewport.h))
  }, [viewport])

  useEffect(() => {
    if (!controlsRef) return
    controlsRef.current = { fit, actual }
    return () => {
      controlsRef.current = null
    }
  }, [controlsRef, fit, actual])

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
        spaceRef.current = true
        return
      }
      if (inField() || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'f' || e.key === 'F') fit()
      else if (e.key === '1') actual()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceRef.current = false
    }
    // A Space released outside the window would otherwise leave every mousedown panning.
    const blur = () => {
      spaceRef.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [fit, actual])

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

  useEffect(() => {
    const stage = stageRef.current
    // Published only once there is something to diff: no preview bitmap (or a failed one) means
    // the stage would render the annotations over an empty background.
    if (!stage || !image || !preview || previewError) return
    window.__astrocaptionEditor = { stage, imageWidth: image.width, labelCount: entries.length, renderAt }
    return () => {
      delete window.__astrocaptionEditor
    }
    // `viewport`: the Stage is only mounted once the container has a size, so the hook has to be
    // published again when that first measurement arrives.
  }, [image, renderAt, viewport, preview, previewError, entries])

  const selected = useMemo(
    () => entries.find((e) => e.label.object_id === selectedId) ?? null,
    [entries, selectedId],
  )

  // The hit targets for hover: one transparent circle per object, rebuilt only when the objects,
  // the marker sizes or the zoom (the 8 px floor is in screen pixels) change — not on every pan.
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
          />
        )
      }),
    [objectOrder, objects, style, view.scale, hover],
  )

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
    if (!(e.target === stage || e.evt.button === 1 || spaceRef.current)) return
    const pointer = stage.getPointerPosition()
    if (!pointer) return
    e.evt.preventDefault()
    panRef.current = { sx: pointer.x, sy: pointer.y, vx: view.x, vy: view.y }
    setPanning(true)
  }

  const onMouseMove = () => {
    const start = panRef.current
    const pointer = stageRef.current?.getPointerPosition()
    if (!start || !pointer) return
    setView({ scale: view.scale, x: start.vx + (pointer.x - start.sx), y: start.vy + (pointer.y - start.sy) })
  }

  // spaceRef is not cleared here: Space owns only whether the *next* mousedown pans, and the
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
            onMouseMove={onMouseMove}
            onMouseUp={stopPan}
            onMouseLeave={stopPan}
          >
            <Layer listening={false}>
              {preview && <KImage image={preview} width={image.width} height={image.height} />}
            </Layer>
            <AnnotationLayer
              entries={entries}
              style={style}
              font={font}
              onDrawError={onDrawError}
              badgesRef={badgesRef}
            />
            <Layer ref={overlayRef}>
              {hitCircles}
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
