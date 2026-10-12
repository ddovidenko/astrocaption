import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import Konva from 'konva'
import { disableAll, isEditable } from './editing'
import { clampFontSize } from './metrics'
import { useEditor } from './store'
import { zoomAt } from './view'

/** The gesture layer of the editor canvas (#108): the keyboard shortcuts, the pan (empty canvas,
 *  middle button, or Space held), the wheel's resize-or-zoom split, the press and click that
 *  select, and the exits that commit a wheel-resize preview when the button comes up anywhere.
 *  The canvas spreads `stage` onto its Konva `Stage` and hands `label` to every drawn label; the
 *  document-side handlers (double-click to edit, the drag itself) stay with the canvas. Pinned end
 *  to end by `gestures.spec.ts`, `labels.spec.ts` and `parity.spec.ts`. */
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
  }
  label: {
    onPress: (id: number, shift: boolean) => void
    /** A press that turned out to be a click, not a drag (the hook checks `movedRef`). */
    onClick: (id: number, shift: boolean) => void
  }
  /** Whether the pointer travelled since the last mousedown: the click Konva fires after a pan, or
   *  after a label drag that ended over a marker, is not a toggle. Read at click time, not on
   *  render (a ref, so the marker layer's memo is untouched). */
  moved: () => boolean
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

  const moved = useCallback(() => movedRef.current, [])

  return {
    spacePan,
    panning,
    moved,
    stage: { onMouseDown, onMouseMove, onMouseUp: stopPan, onMouseLeave: stopPan, onClick: onStageClick, onWheel },
    label: { onPress: onLabelPress, onClick: onLabelClick },
  }
}
