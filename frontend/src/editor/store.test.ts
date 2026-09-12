import { beforeEach, describe, expect, it } from 'vitest'
import type { Annotations, FontOut, ImageOut, ObjectOut, StyleConfig } from '../api'
import { enabledLabels, fontFor, labelFor, useEditor, type LoadedDocument } from './store'

const image: ImageOut = {
  id: 'img-1',
  title: 'Orion',
  original_name: 'orion.jpg',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  width: 3000,
  height: 2000,
  solve_status: 'solved',
  solve_error: null,
  nova_submission_id: null,
  nova_job_id: null,
  nova_status_url: null,
  nova_job_log_url: null,
  calibration: null,
  published: false,
  object_count: 2,
  exported_at: null,
  original_format: 'jpeg',
  preview_url: '/preview',
  thumb_url: '/thumb',
  original_url: '/original',
  annotated_preview_url: null,
  export_url: null,
}

const objects: ObjectOut[] = [
  { id: 1, catalog_names: ['M42'], primary_name: 'M42', type: 'nebula', x: 100, y: 100, radius: 20 },
  { id: 2, catalog_names: ['M43'], primary_name: 'M43', type: 'nebula', x: 200, y: 200, radius: 10 },
]

const style: StyleConfig = {
  font_file: 'Inter-Regular.ttf',
  font_size: 24,
  text_color: '#ffffff',
  marker_color: '#ff0000',
  leader_color: '#ffffff',
  halo: true,
  halo_color: '#000000',
  halo_width: 2,
  marker_width: 2,
  marker_min_radius: 4,
  show_aliases: false,
  name_preference: 'popular',
}

const annotations: Annotations = {
  image_id: 'img-1',
  style,
  labels: [
    { object_id: 1, enabled: true, x: 120, y: 80, font_size: null, text_override: null, color: null, show_aliases: null, leader: 'auto', collided: false },
    { object_id: 2, enabled: false, x: 220, y: 180, font_size: null, text_override: null, color: null, show_aliases: null, leader: 'auto', collided: false },
  ],
  version: 5,
  updated_at: '2026-01-01T00:00:00Z',
}

const fonts: FontOut[] = [
  { file: 'Inter-Regular.ttf', family: 'Inter', weight: '400', sample: 'Aa', ascents: new Array(195).fill(20) },
]

const doc: LoadedDocument = { image, objects, annotations, fonts }

describe('editor store', () => {
  beforeEach(() => {
    useEditor.getState().reset()
  })

  it('loads a document into normalized state', () => {
    useEditor.getState().load(doc)
    const state = useEditor.getState()
    expect(state.objectOrder).toEqual([1, 2])
    expect(state.labels.get(1)?.enabled).toBe(true)
    expect(state.labels.get(2)?.enabled).toBe(false)
    expect(state.version).toBe(5)
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
      annotations: { ...annotations, style: { ...style, font_file: 'Missing.ttf' } },
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
