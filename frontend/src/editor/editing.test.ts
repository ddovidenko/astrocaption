import { beforeEach, describe, expect, it } from 'vitest'
import { isEditable, toggleWithPlacement } from './editing'
import { useEditor, type LoadedDocument } from './store'
import { makeDoc } from './testDoc'

// vitest runs in node, so every case injects a measurer: getMeasurer() needs a real canvas.
const measure = () => 100 // every string 100 px wide; heights come from the size

let doc: LoadedDocument

beforeEach(() => {
  useEditor.getState().reset()
  doc = makeDoc()
})

describe('toggleWithPlacement', () => {
  it('places a label that has never been moved off its object', () => {
    useEditor.getState().load(doc)
    const obj = useEditor.getState().objects.get(2)!
    toggleWithPlacement(2, measure)
    const label = useEditor.getState().labels.get(2)!
    expect(label.enabled).toBe(true)
    expect([label.x, label.y]).not.toEqual([obj.x, obj.y])
  })

  it('restores the stored position of a label that was placed before', () => {
    useEditor.getState().load(doc)
    useEditor.getState().moveLabel(2, 100, 200) // as a drag would
    toggleWithPlacement(2, measure)
    const label = useEditor.getState().labels.get(2)!
    expect(label.enabled).toBe(true)
    expect([label.x, label.y]).toEqual([100, 200])
  })

  it('disables an enabled label and keeps its position', () => {
    useEditor.getState().load(doc)
    const before = useEditor.getState().labels.get(1)!
    toggleWithPlacement(1, measure)
    const label = useEditor.getState().labels.get(1)!
    expect(label.enabled).toBe(false)
    expect([label.x, label.y]).toEqual([before.x, before.y])
  })

  it('does nothing for an unknown object', () => {
    useEditor.getState().load(doc)
    const seq = useEditor.getState().changeSeq
    toggleWithPlacement(999, measure)
    expect(useEditor.getState().changeSeq).toBe(seq)
  })

  it('does nothing while the image is not solved', () => {
    const solving = makeDoc()
    solving.image = { ...solving.image, solve_status: 'solving' }
    useEditor.getState().load(solving)
    expect(isEditable(useEditor.getState())).toBe(false)
    toggleWithPlacement(2, measure)
    expect(useEditor.getState().labels.get(2)?.enabled).toBe(false)
    expect(useEditor.getState().changeSeq).toBe(0)
  })

  // SPEC § 5: a failed re-solve leaves the previous layout editable, and the server accepts
  // PUT/autoarrange for it.
  it('still edits after a failed re-solve', () => {
    const failed = makeDoc()
    failed.image = { ...failed.image, solve_status: 'failed' }
    useEditor.getState().load(failed)
    expect(isEditable(useEditor.getState())).toBe(true)
    toggleWithPlacement(2, measure)
    expect(useEditor.getState().labels.get(2)?.enabled).toBe(true)
  })
})

describe('isEditable', () => {
  it('is true only when no solve is running', () => {
    const state = (status: string) => {
      const doc = makeDoc()
      doc.image = { ...doc.image, solve_status: status as typeof doc.image.solve_status }
      useEditor.getState().load(doc)
      return useEditor.getState()
    }
    expect(isEditable(state('solved'))).toBe(true)
    expect(isEditable(state('failed'))).toBe(true)
    expect(isEditable(state('pending'))).toBe(false)
    expect(isEditable(state('solving'))).toBe(false)
    useEditor.getState().reset()
    expect(isEditable(useEditor.getState())).toBe(false)
  })
})
