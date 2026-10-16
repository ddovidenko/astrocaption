// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type ConfigOut, type HealthOut, type ImageOut } from '../api'
import ImagesPage from './ImagesPage'
import { SEARCH_DEBOUNCE_MS } from './ListFilters'
import Url from './testUrl'

vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, listImages: vi.fn(), config: vi.fn(), image: vi.fn(), setPublished: vi.fn(), upload: vi.fn() } }
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
  vi.mocked(api.setPublished).mockReset()
  vi.mocked(api.upload).mockReset()
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

function mountAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ImagesPage health={health} refreshHealth={vi.fn(async () => health)} />
      <Url />
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

describe('ImagesPage search and filters (#189)', () => {
  it('fetches the list the URL names and shows the no-match sentence', async () => {
    vi.mocked(api.listImages).mockResolvedValue({ items: [], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    mountAt('/?q=veil&status=failed&published=true')
    await tick(0)
    expect(api.listImages).toHaveBeenCalledWith({ q: 'veil', status: 'failed', published: true })
    expect(screen.getByText('No images match.')).toBeTruthy()
    expect(screen.queryByText(/No images yet/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Failed' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Published' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('a chip rewrites the URL at once and a typed search after a pause, both from the top', async () => {
    vi.mocked(api.listImages).mockResolvedValue({ items: [image('a')], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    mountAt('/?before=old-cursor')
    await tick(0)
    fireEvent.click(screen.getByRole('button', { name: 'Solved' }))
    await tick(0)
    expect(screen.getByTestId('url').textContent).toBe('?status=solved')
    expect(api.listImages).toHaveBeenLastCalledWith({ status: 'solved' })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search images' }), { target: { value: 'm 27' } })
    await tick(SEARCH_DEBOUNCE_MS)
    expect(screen.getByTestId('url').textContent).toBe('?q=m+27&status=solved')
    expect(api.listImages).toHaveBeenLastCalledWith({ q: 'm 27', status: 'solved' })
  })

  it('a chip pressed inside the typing pause survives the search landing', async () => {
    vi.mocked(api.listImages).mockResolvedValue({ items: [image('a')], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    mountAt('/')
    await tick(0)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search images' }), { target: { value: 'veil' } })
    fireEvent.click(screen.getByRole('button', { name: 'Solved' }))
    await tick(0)
    expect(screen.getByTestId('url').textContent).toBe('?status=solved')
    await tick(SEARCH_DEBOUNCE_MS)
    expect(screen.getByTestId('url').textContent).toBe('?q=veil&status=solved')
    expect(api.listImages).toHaveBeenLastCalledWith({ q: 'veil', status: 'solved' })
  })

  it('a refresh after a card action re-queries with the current filters', async () => {
    vi.mocked(api.listImages).mockResolvedValue({ items: [image('a', { published: true })], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    vi.mocked(api.setPublished).mockResolvedValue(image('a', { published: false }))
    mountAt('/?published=true')
    await tick(0)
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }))
    await tick(0)
    const calls = vi.mocked(api.listImages).mock.calls
    expect(calls[calls.length - 1]![0]).toEqual({ limit: 24, published: true, before: null })
  })

  it('a search that fails shows the error and no cards from the previous list', async () => {
    vi.mocked(api.listImages)
      .mockResolvedValueOnce({ items: [image('a')], next: 'a' })
      .mockRejectedValueOnce(new ApiError(500, 'The server could not answer.'))
    vi.mocked(api.config).mockResolvedValue(config)
    mountAt('/')
    await tick(0)
    expect(titles()).toEqual(['a'])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search images' }), { target: { value: 'veil' } })
    await tick(SEARCH_DEBOUNCE_MS)
    expect(screen.getByText('The server could not answer.')).toBeTruthy()
    expect(screen.queryAllByRole('heading', { level: 3 })).toEqual([])
    expect(screen.queryByRole('link', { name: 'Show more' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy()
  })

  it('an upload clears the search and chips so the new card is in view', async () => {
    vi.mocked(api.listImages)
      .mockResolvedValueOnce({ items: [], next: null })
      .mockResolvedValue({ items: [image('fresh', { solve_status: 'pending' })], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    vi.mocked(api.upload).mockResolvedValue(image('fresh', { solve_status: 'pending' }))
    mountAt('/?q=orion&status=failed')
    await tick(0)
    expect(screen.getByText('No images match.')).toBeTruthy()
    const panel = screen.getByRole('heading', { name: 'Upload' }).closest('section')!
    fireEvent.drop(panel, { dataTransfer: { files: [new File(['jpg'], 'fresh.jpg', { type: 'image/jpeg' })] } })
    await tick(0)
    expect(screen.getByTestId('url').textContent).toBe('')
    expect(api.listImages).toHaveBeenLastCalledWith({})
    expect(titles()).toEqual(['fresh'])
  })

  it('a card action that finishes after the search moved on refreshes the new search', async () => {
    vi.mocked(api.listImages).mockResolvedValue({ items: [image('a', { published: true })], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    let finish: (img: ImageOut) => void = () => {}
    vi.mocked(api.setPublished).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    mountAt('/')
    await tick(0)
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search images' }), { target: { value: 'veil' } })
    await tick(SEARCH_DEBOUNCE_MS)
    expect(screen.getByTestId('url').textContent).toBe('?q=veil')
    await act(async () => { finish(image('a', { published: false })) })
    await tick(0)
    // The refresh the action triggers must list what the URL says now, not what it said
    // when the button was pressed: otherwise the whole library sits under "?q=veil" and the
    // next Show more appends veil rows to it.
    const calls = vi.mocked(api.listImages).mock.calls
    expect(calls[calls.length - 1]![0]).toEqual({ limit: 24, q: 'veil', before: null })
  })

  it('an upload that finishes after a search began still clears it', async () => {
    vi.mocked(api.listImages)
      .mockResolvedValueOnce({ items: [], next: null })
      .mockResolvedValueOnce({ items: [], next: null })
      .mockResolvedValue({ items: [image('fresh', { solve_status: 'pending' })], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    let finish: (img: ImageOut) => void = () => {}
    vi.mocked(api.upload).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    mountAt('/')
    await tick(0)
    const panel = screen.getByRole('heading', { name: 'Upload' }).closest('section')!
    fireEvent.drop(panel, { dataTransfer: { files: [new File(['jpg'], 'fresh.jpg', { type: 'image/jpeg' })] } })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search images' }), { target: { value: 'm31' } })
    await tick(SEARCH_DEBOUNCE_MS)
    expect(screen.getByTestId('url').textContent).toBe('?q=m31')
    await act(async () => { finish(image('fresh', { solve_status: 'pending' })) })
    await tick(0)
    expect(screen.getByTestId('url').textContent).toBe('')
    expect(titles()).toEqual(['fresh'])
  })

  it('an upload that finishes after the owner cleared the filters still shows the new card', async () => {
    vi.mocked(api.listImages)
      .mockResolvedValueOnce({ items: [], next: null })
      .mockResolvedValueOnce({ items: [], next: null })
      .mockResolvedValue({ items: [image('fresh', { solve_status: 'pending' })], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    let finish: (img: ImageOut) => void = () => {}
    vi.mocked(api.upload).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    mountAt('/?q=orion')
    await tick(0)
    const panel = screen.getByRole('heading', { name: 'Upload' }).closest('section')!
    fireEvent.drop(panel, { dataTransfer: { files: [new File(['jpg'], 'fresh.jpg', { type: 'image/jpeg' })] } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await tick(0)
    expect(screen.getByTestId('url').textContent).toBe('')
    await act(async () => { finish(image('fresh', { solve_status: 'pending' })) })
    await tick(0)
    // Clearing an already clear URL changes nothing, so the page must refresh instead.
    expect(titles()).toEqual(['fresh'])
  })

  it('Show more carries the filters and appends inside the result set', async () => {
    vi.mocked(api.listImages)
      .mockResolvedValueOnce({ items: [image('a')], next: 'a' })
      .mockResolvedValueOnce({ items: [image('b')], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    mountAt('/?q=orion')
    await tick(0)
    const more = screen.getByRole('link', { name: 'Show more' })
    expect(more.getAttribute('href')).toBe('?q=orion&before=a')
    fireEvent.click(more)
    await tick(0)
    expect(api.listImages).toHaveBeenLastCalledWith({ q: 'orion', before: 'a' })
    expect(titles()).toEqual(['a', 'b'])
  })
})
