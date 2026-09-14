import type { Annotations, FontOut, ImageOut, ObjectOut, StyleConfig } from '../api'
import type { LoadedDocument } from './store'

/** A small solved document for editor tests: a 3000x2000 image, two objects (one radius-0
 *  "bright" object with no marker circle), and a label per object — one enabled away from its
 *  object, one disabled at its object's position. Returns a fresh object every call: tests
 *  mutate what they get back, and the store must never see the same object twice. */
export function makeDoc(): LoadedDocument {
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
    { id: 1, catalog_names: ['NGC 1976', 'M 42'], primary_name: 'M 42', type: 'ngc', x: 1500, y: 1000, radius: 40 },
    { id: 2, catalog_names: ['Alnitak'], primary_name: 'Alnitak', type: 'bright', x: 1560, y: 1010, radius: 0 },
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
    marker_min_radius: 6,
    show_aliases: false,
    name_preference: 'popular',
  }

  const annotations: Annotations = {
    image_id: 'img-1',
    style,
    labels: [
      {
        object_id: 1,
        enabled: true,
        x: 1552,
        y: 970,
        font_size: null,
        text_override: null,
        color: null,
        show_aliases: null,
        leader: 'auto',
        collided: false,
      },
      {
        object_id: 2,
        enabled: false,
        x: 1560,
        y: 1010,
        font_size: null,
        text_override: null,
        color: null,
        show_aliases: null,
        leader: 'auto',
        collided: false,
      },
    ],
    version: 1,
    updated_at: '2026-01-01T00:00:00Z',
  }

  const fonts: FontOut[] = [
    { file: 'Inter-Regular.ttf', family: 'Inter', weight: '400', sample: 'Aa', ascents: new Array(195).fill(20) },
  ]

  return { image, objects, annotations, fonts }
}
