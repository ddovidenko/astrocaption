/** A stand-in for the editor canvas in component tests: an element that cancels every touch that
 *  lands on it (SPEC § 6.5), as Konva and the gesture layer do, so the browser sends no
 *  compatibility mouse events and a press-away has to be read from the touch itself. Appended to
 *  the body; the caller removes it (or `cleanup` does not: do so in `afterEach` if it matters). */
export function cancellingCanvas(): HTMLDivElement {
  const el = document.createElement('div')
  el.className = 'editor-canvas'
  el.addEventListener('touchstart', (e) => e.preventDefault())
  document.body.append(el)
  return el
}
