import { beforeEach, describe, expect, it } from 'vitest'
import {
  documentForSave,
  enabledLabels,
  fontFor,
  HISTORY_LIMIT,
  isEditable,
  labelFor,
  useEditor,
  type LoadedDocument,
} from './store'
import { makeDoc } from './testDoc'

let doc: LoadedDocument

beforeEach(() => {
  useEditor.getState().reset()
  doc = makeDoc()
})

describe('editor store', () => {
  it('loads a document into normalized state', () => {
    useEditor.getState().load(doc)
    const state = useEditor.getState()
    expect(state.objectOrder).toEqual([1, 2])
    expect(state.labels.get(1)?.enabled).toBe(true)
    expect(state.labels.get(2)?.enabled).toBe(false)
    expect(state.version).toBe(doc.annotations.version)
    expect(state.save.status).toBe('saved')
    expect(state.view).toEqual({ scale: 1, x: 0, y: 0 })
  })

  it('returns only enabled labels in objectOrder', () => {
    useEditor.getState().load(doc)
    const labels = enabledLabels(useEditor.getState())
    expect(labels).toHaveLength(1)
    expect(labels[0]?.object_id).toBe(1)
  })

  it('labelFor finds a label by object id', () => {
    useEditor.getState().load(doc)
    const state = useEditor.getState()
    expect(labelFor(state, 1)?.object_id).toBe(1)
    expect(labelFor(state, 999)).toBeUndefined()
  })

  it('fontFor returns the style font and throws the #63 message when absent', () => {
    useEditor.getState().load(doc)
    expect(fontFor(useEditor.getState()).file).toBe('Inter-Regular.ttf')

    useEditor.getState().load({
      ...doc,
      annotations: { ...doc.annotations, style: { ...doc.annotations.style, font_file: 'Missing.ttf' } },
    })
    expect(() => fontFor(useEditor.getState())).toThrow('Font Missing.ttf is not listed by the server.')
  })

  it('select and hover set and clear ids', () => {
    useEditor.getState().select(1)
    expect(useEditor.getState().selectedId).toBe(1)
    useEditor.getState().select(null)
    expect(useEditor.getState().selectedId).toBeNull()

    useEditor.getState().hover(2)
    expect(useEditor.getState().hoveredId).toBe(2)
    useEditor.getState().hover(null)
    expect(useEditor.getState().hoveredId).toBeNull()
  })

  it('reset empties everything', () => {
    useEditor.getState().load(doc)
    useEditor.getState().select(1)
    useEditor.getState().hover(2)
    useEditor.getState().reset()
    const state = useEditor.getState()
    expect(state.image).toBeNull()
    expect(state.objects.size).toBe(0)
    expect(state.objectOrder).toEqual([])
    expect(state.style).toBeNull()
    expect(state.labels.size).toBe(0)
    expect(state.version).toBe(0)
    expect(state.fonts.size).toBe(0)
    expect(state.selectedId).toBeNull()
    expect(state.hoveredId).toBeNull()
    expect(state.save).toEqual({ status: 'saved', message: null })
  })
})

describe('viewport and view actions', () => {
  it('fits on the first viewport size and keeps the view on later resizes', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.setViewport(1000, 500)
    const first = useEditor.getState().view
    expect(first.scale).toBeGreaterThan(0)
    useEditor.getState().setView({ scale: 2, x: 5, y: 5 })
    useEditor.getState().setViewport(1200, 500)
    expect(useEditor.getState().view).toEqual({ scale: 2, x: 5, y: 5 })
  })
  it('panTo centres the object without changing the scale', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.setViewport(1000, 500)
    s.setView({ scale: 0.5, x: 0, y: 0 })
    s.panTo(2)
    const v = useEditor.getState().view
    const obj = doc.objects[1]!
    expect(v.scale).toBe(0.5)
    expect(v.x + obj.x * 0.5).toBeCloseTo(500)
    expect(v.y + obj.y * 0.5).toBeCloseTo(250)
  })
})

describe('document actions', () => {
  it('toggleObject disables and re-enables keeping the position, and marks dirty', () => {
    const s = useEditor.getState()
    s.load(doc)
    const before = useEditor.getState().labels.get(1)!
    s.toggleObject(1)
    expect(useEditor.getState().labels.get(1)).toMatchObject({ enabled: false, x: before.x, y: before.y })
    expect(useEditor.getState().save.status).toBe('dirty')
    useEditor.getState().toggleObject(1)
    expect(useEditor.getState().labels.get(1)).toMatchObject({ enabled: true, x: before.x, y: before.y })
  })
  it('toggleObject enables at the placed position when one is given', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(2, { x: 123, y: 456 })
    expect(useEditor.getState().labels.get(2)).toMatchObject({ enabled: true, x: 123, y: 456, collided: false })
  })
  it('toggleObject keeps the placer collided verdict from a placement', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(2, { x: 123, y: 456, collided: true })
    expect(useEditor.getState().labels.get(2)).toMatchObject({ enabled: true, collided: true })
    s.toggleObject(2) // off
    s.toggleObject(2) // on again, at its own position: the owner's placement is not a collision
    expect(useEditor.getState().labels.get(2)).toMatchObject({ enabled: true, collided: false })
  })
  it('toggleObject clears a selection that is being disabled, and keeps one being enabled', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.select(1)
    s.toggleObject(1) // off: nothing left on the canvas to select
    expect(useEditor.getState().selectedId).toBeNull()
    s.select(1)
    useEditor.getState().toggleObject(1) // on again
    expect(useEditor.getState().selectedId).toBe(1)
  })
  it('toggleObject leaves another label\'s selection alone', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.select(1)
    s.toggleObject(2, { x: 1, y: 2 })
    expect(useEditor.getState().selectedId).toBe(1)
  })
  it('moveLabel sets the position and clears collided', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.applyLabels([{ ...useEditor.getState().labels.get(1)!, collided: true }])
    s.moveLabel(1, 10, 20)
    expect(useEditor.getState().labels.get(1)).toMatchObject({ x: 10, y: 20, collided: false })
  })
  it('moveLabel to the current position changes nothing', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.applyLabels([{ ...useEditor.getState().labels.get(1)!, collided: true }])
    s.markSaving()
    s.markSaved(2, 't')
    const { x, y } = useEditor.getState().labels.get(1)!
    s.moveLabel(1, x, y)
    expect(useEditor.getState().labels.get(1)!.collided).toBe(true)
    expect(useEditor.getState().save.status).toBe('saved')
  })
  it('documentForSave lists every label in object order with the loaded version', () => {
    const s = useEditor.getState()
    s.load(doc)
    const out = documentForSave(useEditor.getState())
    expect(out.labels.map((l) => l.object_id)).toEqual(doc.objects.map((o) => o.id))
    expect(out.version).toBe(doc.annotations.version)
    expect(out.style).toEqual(doc.annotations.style)
  })
  it('documentForSave omits labels for objects the image no longer has (the server would reject them)', () => {
    const s = useEditor.getState()
    s.load(doc)
    const state = useEditor.getState()
    const orphan = { ...state.labels.get(1)!, object_id: 99 }
    useEditor.setState({ labels: new Map([...state.labels, [99, orphan]]) })
    const out = documentForSave(useEditor.getState())
    expect(out.labels.map((l) => l.object_id)).toEqual([1, 2])
  })
  it('carries the font fallback and clears it on save or on a font change', () => {
    const s = useEditor.getState()
    s.load({ ...doc, fontFallback: { stored: 'Gone.ttf', used: 'Inter-Regular.ttf' } })
    expect(useEditor.getState().fontFallback).toEqual({ stored: 'Gone.ttf', used: 'Inter-Regular.ttf' })
    s.markSaving()
    s.markSaved(2, 't')
    expect(useEditor.getState().fontFallback).toBeNull()
    useEditor.getState().load({ ...doc, fontFallback: { stored: 'Gone.ttf', used: 'Inter-Regular.ttf' } })
    useEditor.getState().setStyle({ font_size: 30 })
    expect(useEditor.getState().fontFallback).not.toBeNull()
    // A genuine font change (not the same file the style already holds): setStyle's no-op guard
    // (below) must not swallow this, since it is a real change, not a same-value patch.
    useEditor.getState().setStyle({ font_file: 'Lato-Regular.ttf' })
    expect(useEditor.getState().fontFallback).toBeNull()

    // A refused change (document not editable) must not clear the notice either.
    useEditor.getState().load({
      ...doc,
      image: { ...doc.image, solve_status: 'solving' },
      fontFallback: { stored: 'Gone.ttf', used: 'Inter-Regular.ttf' },
    })
    const styleBefore = useEditor.getState().style
    // A genuine change again (not a same-value patch): otherwise the no-op guard above would
    // refuse it for that reason, not for the not-editable reason this block means to test.
    useEditor.getState().setStyle({ font_file: 'Lato-Regular.ttf' })
    expect(useEditor.getState().fontFallback).toEqual({ stored: 'Gone.ttf', used: 'Inter-Regular.ttf' })
    expect(useEditor.getState().style).toBe(styleBefore)
  })

  it('setStyle commits a font_file patch equal to the current font while a fallback is pending', () => {
    useEditor.getState().load({ ...doc, fontFallback: { stored: 'Gone.ttf', used: doc.annotations.style.font_file } })
    useEditor.getState().setStyle({ font_file: doc.annotations.style.font_file })
    const state = useEditor.getState()
    expect(state.undo).toHaveLength(1)
    expect(state.save.status).toBe('dirty')
    expect(state.fontFallback).toBeNull()
  })

  it('applyLabels throws on an id the store does not have', () => {
    const s = useEditor.getState()
    s.load(doc)
    const label = useEditor.getState().labels.get(1)!
    expect(() => s.applyLabels([{ ...label, object_id: 42 }])).toThrow('applyLabels: no label for object 42')
    expect(useEditor.getState().labels.has(42)).toBe(false)
  })
  it('save state: dirty → saving → saved, but stays dirty if a change landed during the save', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(1)
    s.markSaving()
    expect(useEditor.getState().save.status).toBe('saving')
    s.markSaved(5, '2026-09-14T00:00:00+00:00')
    expect(useEditor.getState().save.status).toBe('saved')
    expect(useEditor.getState().version).toBe(5)
    s.toggleObject(1)
    s.markSaving()
    s.toggleObject(1) // a change while saving
    s.markSaved(6, '2026-09-14T00:00:01+00:00')
    expect(useEditor.getState().save.status).toBe('dirty')
    expect(useEditor.getState().version).toBe(6)
  })
  it('conflict and error carry the message', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.markConflict('This image was changed elsewhere. Reload to continue editing.')
    expect(useEditor.getState().save).toEqual({ status: 'conflict', message: 'This image was changed elsewhere. Reload to continue editing.' })
    s.markSaveError('boom')
    expect(useEditor.getState().save.status).toBe('error')
  })

  it('refuses every document change while a solve is running', () => {
    const s = useEditor.getState()
    s.load({ ...doc, image: { ...doc.image, solve_status: 'solving' } })
    const before = useEditor.getState().labels
    s.toggleObject(1)
    s.moveLabel(1, 10, 20)
    s.applyLabels([{ ...before.get(1)!, x: 5 }])
    expect(useEditor.getState().labels).toBe(before)
    expect(useEditor.getState().changeSeq).toBe(0)
    expect(useEditor.getState().save.status).toBe('saved')
  })

  it('keeps editing live after a conflict (only saving stops)', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.markConflict('changed elsewhere')
    s.toggleObject(1)
    expect(useEditor.getState().labels.get(1)?.enabled).toBe(false)
    expect(useEditor.getState().save.status).toBe('conflict')
  })
})

describe('undo/redo', () => {
  it('a commit pushes the previous document and clears redo', () => {
    const s = useEditor.getState()
    s.load(doc)
    expect(useEditor.getState().undo).toHaveLength(0)
    s.toggleObject(1)
    expect(useEditor.getState().undo).toHaveLength(1)
    expect(useEditor.getState().redo).toHaveLength(0)
  })

  it('undoLast restores the labels and commits (autosave sees a change)', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(1)
    const seq = useEditor.getState().changeSeq
    useEditor.getState().undoLast()
    const state = useEditor.getState()
    expect(state.labels.get(1)?.enabled).toBe(true)
    expect(state.changeSeq).toBe(seq + 1)
    expect(state.save.status).toBe('dirty')
    expect(state.undo).toHaveLength(0)
    expect(state.redo).toHaveLength(1)
  })

  it('redoLast re-applies what undoLast took back', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(1)
    useEditor.getState().undoLast()
    useEditor.getState().redoLast()
    expect(useEditor.getState().labels.get(1)?.enabled).toBe(false)
    expect(useEditor.getState().redo).toHaveLength(0)
    expect(useEditor.getState().undo).toHaveLength(1)
  })

  it('a new commit after an undo drops the redo stack', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(1)
    useEditor.getState().undoLast()
    useEditor.getState().toggleObject(2, { x: 1, y: 2 })
    expect(useEditor.getState().redo).toHaveLength(0)
  })

  it('undo and redo are no-ops on empty stacks and while not editable', () => {
    const s = useEditor.getState()
    s.load(doc)
    const seq = useEditor.getState().changeSeq
    s.undoLast()
    s.redoLast()
    expect(useEditor.getState().changeSeq).toBe(seq)
    s.toggleObject(1)
    useEditor.setState({ image: { ...doc.image, solve_status: 'solving' } })
    useEditor.getState().undoLast()
    expect(useEditor.getState().labels.get(1)?.enabled).toBe(false)
  })

  it('the history is capped at HISTORY_LIMIT entries', () => {
    const s = useEditor.getState()
    s.load(doc)
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) useEditor.getState().toggleObject(1)
    expect(useEditor.getState().undo).toHaveLength(HISTORY_LIMIT)
  })

  it('load and markConflict clear both stacks', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(1)
    useEditor.getState().undoLast()
    useEditor.getState().markConflict('changed elsewhere')
    expect(useEditor.getState().undo).toHaveLength(0)
    expect(useEditor.getState().redo).toHaveLength(0)
    useEditor.getState().load(makeDoc())
    useEditor.getState().toggleObject(1)
    useEditor.getState().load(makeDoc())
    expect(useEditor.getState().undo).toHaveLength(0)
  })

  it('a style change is one undo entry too', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.setStyle({ font_size: 30 })
    expect(useEditor.getState().style?.font_size).toBe(30)
    useEditor.getState().undoLast()
    expect(useEditor.getState().style?.font_size).toBe(24)
  })

  it('setStyle skips a commit that matches the current style (no history, no dirty)', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.setStyle({ font_size: 24 })
    const state = useEditor.getState()
    expect(state.undo).toEqual([])
    expect(state.save.status).toBe('saved')
  })

  it('a drag coalesces into one undo entry: preview frames record nothing, drag-end commits', () => {
    const s = useEditor.getState()
    s.load(doc)
    const seq = useEditor.getState().changeSeq
    s.moveLabel(1, 10, 20, false)
    useEditor.getState().moveLabel(1, 11, 21, false)
    expect(useEditor.getState().labels.get(1)).toMatchObject({ x: 11, y: 21 })
    expect(useEditor.getState().changeSeq).toBe(seq)
    expect(useEditor.getState().undo).toHaveLength(0)
    expect(useEditor.getState().save.status).toBe('saved')
    useEditor.getState().moveLabel(1, 12, 22)
    expect(useEditor.getState().changeSeq).toBe(seq + 1)
    expect(useEditor.getState().undo).toHaveLength(1)
    useEditor.getState().undoLast()
    expect(useEditor.getState().labels.get(1)).toMatchObject({ x: doc.annotations.labels[0]!.x, y: doc.annotations.labels[0]!.y })
  })

  it('undoLast clears a selection the restored snapshot disables', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(2, { x: 1, y: 2 }) // enables 2
    s.select(2)
    useEditor.getState().undoLast() // back to 2 disabled
    expect(useEditor.getState().selectedId).toBeNull()
  })

  it('undoLast leaves a selection alone when the restored snapshot keeps it enabled', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.select(1) // label 1 is enabled in both the current and the restored snapshot
    s.toggleObject(2, { x: 1, y: 2 })
    useEditor.getState().undoLast()
    expect(useEditor.getState().selectedId).toBe(1)
  })

  it('a drag that ends where it began restores the committed document and records nothing', () => {
    const s = useEditor.getState()
    s.load(doc)
    const committedLabels = useEditor.getState().labels
    const { x, y } = committedLabels.get(1)!
    s.moveLabel(1, x + 5, y, false)
    useEditor.getState().moveLabel(1, x, y)
    expect(useEditor.getState().labels).toBe(committedLabels)
    expect(useEditor.getState().undo).toHaveLength(0)
    expect(useEditor.getState().save.status).toBe('saved')
  })
})

describe('isEditable', () => {
  it('is true for solved and failed, false while pending or solving', () => {
    for (const [status, want] of [['solved', true], ['failed', true], ['pending', false], ['solving', false]] as const) {
      useEditor.getState().load({ ...doc, image: { ...doc.image, solve_status: status } })
      expect(isEditable(useEditor.getState())).toBe(want)
    }
  })
})
