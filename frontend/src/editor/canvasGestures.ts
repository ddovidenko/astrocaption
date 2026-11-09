import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import Konva from 'konva'
import { disableAll, isEditable } from './editing'
import { clampFontSize } from './metrics'
import { useEditor } from './store'
import { pinchView, zoomAt, type ScreenPoint } from './view'

/** The gesture layer of the editor canvas (#108): the keyboard shortcuts, the pan (empty canvas,
 *  middle button, or Space held), the wheel's resize-or-zoom split, the press and click that
 *  select, and the exits that commit a wheel-resize preview when the button comes up anywhere.
 *  The canvas spreads `stage` onto its Konva `Stage` and hands `label` to every drawn label; the
 *  document-side handlers (double-click to edit, the drag itself) stay with the canvas. Pinned end
 *  to end by `gestures.spec.ts`, `labels.spec.ts` and `parity.spec.ts`.
 *
 *  Touch (SPEC § 6.5, #57) lives beside the mouse and is told apart per event, never per device:
 *  two fingers zoom and pan the photo together, one finger pans it, a tap selects a label, and
 *  only a label that is already selected moves under a finger (a drag on any other one pans, so
 *  moving around a zoomed-in photo cannot nudge a label). The mouse handlers never see a finger:
 *  every touchstart on the canvas is cancelled, so the browser sends no compatibility mouse
 *  events after it. Pinned by `touch.spec.ts`. */
export interface CanvasGestures {
  /** Whether Space is held: a pan gesture, which wins over selecting or dragging a label. Held in
   *  React state so `draggable` can turn off before Konva sees the press. */
  spacePan: boolean
  /** Whether a pan is in flight (the container's cursor). */
  panning: boolean
  stage: {
    onMouseDown: (e: Konva.KonvaEventObject<MouseEvent>) => void
    onMouseMove: (e: Konva.KonvaEventObject<MouseEvent>) => void
    onMouseUp: () => void
    onMouseLeave: () => void
    onClick: (e: Konva.KonvaEventObject<MouseEvent>) => void
    onWheel: (e: Konva.KonvaEventObject<WheelEvent>) => void
    onTouchStart: (e: Konva.KonvaEventObject<TouchEvent>) => void
    onTouchMove: (e: Konva.KonvaEventObject<TouchEvent>) => void
    onTouchEnd: (e: Konva.KonvaEventObject<TouchEvent>) => void
    onTouchCancel: (e: Konva.KonvaEventObject<TouchEvent>) => void
    onTap: (e: Konva.KonvaEventObject<TouchEvent>) => void
  }
  label: {
    onPress: (id: number, shift: boolean) => void
    /** A press that turned out to be a click, not a drag (the hook checks `movedRef`). */
    onClick: (id: number, shift: boolean) => void
    /** A finger landed on this label. Fires before the stage's own touchstart (Konva bubbles from
     *  the shape), which reads it to leave a selected label's finger to the drag. */
    onTouchPress: (id: number) => void
    /** A finger tapped this label: it becomes the selection. */
    onTap: (id: number) => void
    /** Whether a drag Konva is about to start must be refused: one begun by a finger on a label
     *  that is not selected, or by any finger of a gesture a second finger has joined. The caller
     *  stops the drag inside `dragstart`, before the node has moved. */
    blocksDrag: (e: Konva.KonvaEventObject<DragEvent>, id: number) => boolean
  }
  /** Whether the pointer travelled since the last mousedown: the click Konva fires after a pan, or
   *  after a label drag that ended over a marker, is not a toggle. Read at click time, not on
   *  render (a ref, so the marker layer's memo is untouched). The same for a finger since its
   *  touchstart, with more slack, and for the whole of a gesture a second finger joined. */
  moved: () => boolean
}

/** How far a finger may wander and still be a tap, in screen pixels. The mouse's slack is 3. */
export const TOUCH_SLACK = 10

/** The fingers on the canvas, in stage-container pixels (what `View` is expressed in). Only the
 *  ones that landed on the canvas: `touches` lists every finger on the screen, and a thumb resting
 *  on the top bar or the side panel (a hand holding the device) is no part of a gesture on the
 *  photo. Counted in, it would turn every tap into the start of a pinch. */
function touchPoints(stage: Konva.Stage, touches: TouchList): ScreenPoint[] {
  const rect = stage.container().getBoundingClientRect()
  return Array.from(touches)
    .filter((t) => t.target instanceof Node && stage.content.contains(t.target))
    .map((t) => ({ x: t.clientX - rect.left, y: t.clientY - rect.top }))
}

function spread(a: ScreenPoint, b: ScreenPoint): { mid: ScreenPoint; dist: number } {
  return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(b.x - a.x, b.y - a.y) }
}

export function useCanvasGestures(stageRef: RefObject<Konva.Stage | null>): CanvasGestures {
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
  // The touch gesture in flight. `down` is where a lone finger landed; `pan` appears once that
  // finger has left the tap slack, anchored where it left it so the photo does not jump by the
  // slack; `pinch` is the previous frame of a two-finger gesture. `spent` is set when a second
  // finger lands and stays until the last one lifts: fingers rarely leave together, and the one
  // still down must not turn the end of a pinch into a pan.
  // `onLabel`: the lone finger is on a selected label, so Konva's drag owns it and the photo
  // stays put.
  const touchRef = useRef<{
    down: ScreenPoint | null
    pan: { sx: number; sy: number; vx: number; vy: number } | null
    pinch: { mid: ScreenPoint; dist: number } | null
    spent: boolean
    onLabel: boolean
  }>({ down: null, pan: null, pinch: null, spent: false, onLabel: false })
  // Set by a label's touchstart, read and cleared by the stage's, which fires right after it.
  const touchedSelectedRef = useRef(false)
  const [spacePan, setSpacePan] = useState(false)
  const [panning, setPanning] = useState(false)

  // Keys, ignored while a form field has the focus.
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
      // Escape on a toolbar *button* (the colour swatch, refocused when its picker closed on the
      // previous Escape) is the editor's: a second Escape clears the selection (#104). The
      // toolbar's fields keep it, as they keep every key.
      const toolbarButton = el instanceof HTMLButtonElement && el.closest('.label-toolbar') !== null
      if ((inField() && !(e.key === 'Escape' && toolbarButton)) || e.ctrlKey || e.metaKey || e.altKey) return
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

  // A click on the empty background (never on a label or a marker) clears the selection; a click
  // that ended a pan does not.
  const onStageClick = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (e.target === stageRef.current && !movedRef.current) useEditor.getState().select(null)
    },
    [stageRef],
  )

  // Wheel: resize the pressed label (left button held), otherwise zoom about the cursor.
  const onWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault()
      const pressed = pressRef.current
      const s = useEditor.getState()
      if (pressed !== null && (e.evt.buttons & 1) === 1) {
        // A horizontal trackpad swipe reports deltaY 0; reading it as a notch down would shrink
        // the label on a gesture that never asked for a resize.
        if (e.evt.deltaY === 0) return
        const label = s.labels.get(pressed)
        if (!label || !s.style) return
        const current = label.font_size ?? s.style.font_size
        const size = clampFontSize(current + (e.evt.deltaY < 0 ? 1 : -1))
        s.updateLabels([pressed], { font_size: size }, false)
        return
      }
      const pointer = stageRef.current?.getPointerPosition()
      if (!pointer) return
      s.setView(zoomAt(s.view, pointer.x, pointer.y, Math.exp(-e.evt.deltaY * 0.0015)))
    },
    [stageRef],
  )

  // Pan: empty canvas, the middle button, or space held down.
  const onMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
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
      const { view } = useEditor.getState()
      panRef.current = { sx: pointer.x, sy: pointer.y, vx: view.x, vy: view.y }
      setPanning(true)
    },
    [stageRef, spacePan],
  )

  const onMouseMove = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      const pointer = stageRef.current?.getPointerPosition()
      if (!pointer) return
      // 3 screen pixels of slack, so a hand that shifts while clicking still counts as a click.
      const down = downRef.current
      if (down && e.evt.buttons !== 0 && Math.hypot(pointer.x - down.x, pointer.y - down.y) > 3) {
        movedRef.current = true
      }
      const start = panRef.current
      if (!start) return
      const s = useEditor.getState()
      s.setView({ scale: s.view.scale, x: start.vx + (pointer.x - start.sx), y: start.vy + (pointer.y - start.sy) })
    },
    [stageRef],
  )

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

  const onTouchStart = useCallback(
    (e: Konva.KonvaEventObject<TouchEvent>) => {
      const stage = stageRef.current
      if (!stage) return
      // Konva cancels a touchstart that lands on a listening shape; bare sky gets the same here.
      // Uncancelled, the browser follows a tap with mousedown, mouseup and click, and the mouse
      // handlers above would run a second time for the same finger.
      if (e.evt.cancelable) e.evt.preventDefault()
      // For the same reason the focus never moves on its own, and the toolbar's size field
      // commits on blur: without this, a size typed there would be dropped the moment the tap
      // that follows changed the selection. The colour picker listens for the touch itself.
      const focused = document.activeElement
      if (focused instanceof HTMLElement && focused !== document.body) focused.blur()
      const onLabel = touchedSelectedRef.current
      touchedSelectedRef.current = false
      const points = touchPoints(stage, e.evt.touches)
      const t = touchRef.current
      if (points.length >= 2) {
        // A label in mid-drag stays where it has got to: stopping fires the ordinary dragend,
        // which commits the move as its one undo entry, and the two fingers take over. With the
        // drag over, Konva delivers the moves of the pinch to the stage again (it skips hit
        // detection, and so the stage's touchmove, only while a node is being dragged).
        if (Konva.isDragging()) Konva.DD.node?.stopDrag()
        t.down = null
        t.pan = null
        t.spent = true
        t.pinch = spread(points[0]!, points[1]!)
        movedRef.current = true
        return
      }
      const [point] = points
      if (!point) return
      movedRef.current = false
      touchRef.current = { down: point, pan: null, pinch: null, spent: false, onLabel }
    },
    [stageRef],
  )

  const onTouchMove = useCallback(
    (e: Konva.KonvaEventObject<TouchEvent>) => {
      const stage = stageRef.current
      if (!stage) return
      const points = touchPoints(stage, e.evt.touches)
      const t = touchRef.current
      const s = useEditor.getState()
      if (points.length >= 2) {
        const now = spread(points[0]!, points[1]!)
        // No previous frame (a third finger just left, say): this one only restarts the gesture.
        if (t.pinch) s.setView(pinchView(s.view, t.pinch.mid, t.pinch.dist, now.mid, now.dist))
        t.pinch = now
        return
      }
      const [point] = points
      if (!point || t.spent || !t.down) return
      if (!t.pan) {
        if (Math.hypot(point.x - t.down.x, point.y - t.down.y) <= TOUCH_SLACK) return
        movedRef.current = true
        if (t.onLabel) return
        t.pan = { sx: point.x, sy: point.y, vx: s.view.x, vy: s.view.y }
        return
      }
      s.setView({ scale: s.view.scale, x: t.pan.vx + (point.x - t.pan.sx), y: t.pan.vy + (point.y - t.pan.sy) })
    },
    [stageRef],
  )

  // The same for a finger lifted and a gesture the browser took away (an incoming call). A pan
  // and a pinch only ever moved the view, so there is nothing to commit here; a label drag is
  // Konva's to end, which it does through its ordinary dragend in both cases.
  const onTouchEnd = useCallback(
    (e: Konva.KonvaEventObject<TouchEvent>) => {
      const stage = stageRef.current
      const t = touchRef.current
      t.pinch = null
      if (!stage || touchPoints(stage, e.evt.touches).length === 0) {
        touchRef.current = { down: null, pan: null, pinch: null, spent: false, onLabel: false }
      }
    },
    [stageRef],
  )

  const onLabelTouchPress = useCallback((id: number) => {
    touchedSelectedRef.current = useEditor.getState().selectedIds.has(id)
  }, [])

  // A tap is Konva's: a touch that ended on the shape it began on without becoming a drag. A pan
  // that carried the label along under the finger also ends on it, which `movedRef` rules out.
  const onLabelTap = useCallback((id: number) => {
    if (movedRef.current) return
    const s = useEditor.getState()
    s.select(id)
    s.hover(null)
  }, [])

  const blocksDrag = useCallback((e: Konva.KonvaEventObject<DragEvent>, id: number) => {
    // Konva hands `dragstart` the native event the press began with (touchstart or mousedown),
    // or nothing at all for a drag started from code.
    const type: string | undefined = (e.evt as Event | undefined)?.type
    if (!type?.startsWith('touch')) return false
    return touchRef.current.spent || !useEditor.getState().selectedIds.has(id)
  }, [])

  // A tap on bare canvas clears the selection and whatever a tap was showing the name of.
  const onStageTap = useCallback(
    (e: Konva.KonvaEventObject<TouchEvent>) => {
      if (e.target !== stageRef.current || movedRef.current) return
      const s = useEditor.getState()
      s.select(null)
      s.hover(null)
    },
    [stageRef],
  )

  const moved = useCallback(() => movedRef.current, [])

  return {
    spacePan,
    panning,
    moved,
    stage: {
      onMouseDown,
      onMouseMove,
      onMouseUp: stopPan,
      onMouseLeave: stopPan,
      onClick: onStageClick,
      onWheel,
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel: onTouchEnd,
      onTap: onStageTap,
    },
    label: {
      onPress: onLabelPress,
      onClick: onLabelClick,
      onTouchPress: onLabelTouchPress,
      onTap: onLabelTap,
      blocksDrag,
    },
  }
}
