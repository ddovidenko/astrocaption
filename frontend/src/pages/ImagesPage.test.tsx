// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type ConfigOut, type HealthOut, type ImageOut } from '../api'
import ImagesPage from './ImagesPage'

vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, listImages: vi.fn(), config: vi.fn(), image: vi.fn() } }
})

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.mocked(api.listImages).mockReset()
  vi.mocked(api.config).mockReset()
  vi.mocked(api.image).mockReset()
})

const health: HealthOut = {
  status: 'ok',
  version: '0.5.0',
  site_title: 'Sky',
  setup_required: false,
  authenticated: true,
  config_error: null,
  locked: [],
  public_gallery_enabled: true,
}

const config: ConfigOut = {
  site_title: 'Sky',
  max_upload_mb: 50,
  public_gallery_enabled: true,
  nova_api_key_set: true,
  default_style: {},
  style_defaults: {} as ConfigOut['style_defaults'],
  locked: [],
  locked_by: {},
  solve_timeout_seconds: 900,
  upload_chunk_mb: 8,
  min_label_radius_percent: 0.4,
}

function image(id: string, over: Partial<ImageOut> = {}): ImageOut {
  return {
    id,
    title: id,
    original_name: `${id}.jpg`,
    created_at: '2026-09-22T10:00:00Z',
    updated_at: '2026-09-22T10:00:00Z',
    width: 3000,
    height: 2000,
    solve_status: 'solved',
    solve_error: null,
    check_available: false,
    nova_submission_id: null,
    nova_job_id: null,
    nova_status_url: null,
    nova_job_log_url: null,
    calibration: null,
    published: false,
    object_count: 12,
    exported_at: null,
    annotations_hash: 'h1',
    exported_hash: null,
    original_format: 'JPEG',
    preview_url: `/api/images/${id}/files/preview`,
    thumb_url: `/api/images/${id}/files/thumb`,
    original_url: `/api/images/${id}/files/original`,
    annotated_preview_url: null,
    export_url: null,
    ...over,
  }
}

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

function mount() {
  render(
    <MemoryRouter>
      <ImagesPage health={health} refreshHealth={vi.fn(async () => health)} />
    </MemoryRouter>,
  )
}

/** The titles of the cards on screen, in order. */
const titles = () => screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)

describe('ImagesPage poll while a solve runs (#188)', () => {
  it('re-fetches only the busy rows and merges them in place', async () => {
    vi.mocked(api.listImages).mockResolvedValue({
      items: [image('newest'), image('solving', { solve_status: 'solving' }), image('oldest')],
      next: 'oldest',
    })
    vi.mocked(api.config).mockResolvedValue(config)
    vi.mocked(api.image).mockResolvedValue(image('solving', { solve_status: 'solved', updated_at: '2026-09-22T10:01:00Z' }))
    mount()
    await tick(0)
    expect(titles()).toEqual(['newest', 'solving', 'oldest'])
    expect(screen.getByText('Solving…')).toBeTruthy()

    await tick(3000)
    expect(api.image).toHaveBeenCalledTimes(1)
    expect(api.image).toHaveBeenCalledWith('solving')
    expect(api.listImages).toHaveBeenCalledTimes(1) // the list itself was not fetched again
    expect(titles()).toEqual(['newest', 'solving', 'oldest'])
    expect(screen.queryByText('Solving…')).toBeNull()

    // Nothing is busy any more: the poll stops.
    await tick(3000)
    expect(api.image).toHaveBeenCalledTimes(1)
  })

  it('falls back to a full refresh when a busy row is gone', async () => {
    vi.mocked(api.listImages)
      .mockResolvedValueOnce({ items: [image('a', { solve_status: 'pending' }), image('b')], next: null })
      .mockResolvedValue({ items: [image('b')], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    vi.mocked(api.image).mockRejectedValue(new ApiError(404, 'Image not found.'))
    mount()
    await tick(0)
    expect(titles()).toEqual(['a', 'b'])

    await tick(3000)
    expect(api.image).toHaveBeenCalledWith('a')
    expect(api.listImages).toHaveBeenCalledTimes(2)
    expect(titles()).toEqual(['b'])
  })
})
