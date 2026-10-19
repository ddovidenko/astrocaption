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
  return { ...real, api: { ...real.api, listImages: vi.fn(), config: vi.fn(), image: vi.fn(), setPublished: vi.fn(), rename: vi.fn(), upload: vi.fn() } }
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
  vi.mocked(api.rename).mockReset()
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

  it('kind and dates reach the API from the URL and ride on the Show more link', async () => {
    vi.mocked(api.listImages).mockResolvedValue({ items: [image('a')], next: 'a' })
    vi.mocked(api.config).mockResolvedValue(config)
    mountAt('/?kind=nebula&since=2026-10-01&until=2026-10-31')
    await tick(0)
    expect(api.listImages).toHaveBeenCalledWith({ kind: 'nebula', since: '2026-10-01', until: '2026-10-31' })
    expect(screen.getByRole('button', { name: 'Nebulae' }).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-10-01')
    expect(screen.getByRole('link', { name: 'Show more' }).getAttribute('href')).toBe('?kind=nebula&since=2026-10-01&until=2026-10-31&before=a')
    fireEvent.click(screen.getByRole('button', { name: 'Galaxies' }))
    await tick(0)
    expect(screen.getByTestId('url').textContent).toBe('?kind=galaxy&since=2026-10-01&until=2026-10-31')
    expect(api.listImages).toHaveBeenLastCalledWith({ kind: 'galaxy', since: '2026-10-01', until: '2026-10-31' })
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

describe('ImagesPage followed Show more page (#227)', () => {
  const gone = () => new ApiError(410, 'That page is no longer available; reload the list.')

  it('starts from the page the URL names, and a refresh keeps that start', async () => {
    vi.mocked(api.listImages).mockResolvedValue({ items: [image('b', { published: true })], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    vi.mocked(api.setPublished).mockResolvedValue(image('b', { published: false }))
    mountAt('/?q=orion&before=a')
    await tick(0)
    expect(api.listImages).toHaveBeenCalledWith({ q: 'orion', before: 'a' })
    expect(titles()).toEqual(['b'])
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }))
    await tick(0)
    expect(api.listImages).toHaveBeenLastCalledWith({ limit: 24, q: 'orion', before: 'a' })
  })

  it('falls back to the top and drops the cursor from the URL when that page is gone', async () => {
    vi.mocked(api.listImages)
      .mockRejectedValueOnce(gone())
      .mockResolvedValueOnce({ items: [image('a')], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    mountAt('/?q=orion&before=deleted')
    await tick(0)
    expect(screen.getByTestId('url').textContent).toBe('?q=orion')
    expect(api.listImages).toHaveBeenLastCalledWith({ q: 'orion' })
    expect(titles()).toEqual(['a'])
    expect(screen.queryByText(/no longer available/)).toBeNull()
  })

  it('an upload while on a followed page drops the cursor so the new card is in view', async () => {
    vi.mocked(api.listImages)
      .mockResolvedValueOnce({ items: [image('b')], next: null })
      .mockResolvedValue({ items: [image('fresh', { solve_status: 'pending' })], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    vi.mocked(api.upload).mockResolvedValue(image('fresh', { solve_status: 'pending' }))
    mountAt('/?before=a')
    await tick(0)
    const panel = screen.getByRole('heading', { name: 'Upload' }).closest('section')!
    fireEvent.drop(panel, { dataTransfer: { files: [new File(['jpg'], 'fresh.jpg', { type: 'image/jpeg' })] } })
    await tick(0)
    expect(screen.getByTestId('url').textContent).toBe('')
    expect(api.listImages).toHaveBeenLastCalledWith({})
    expect(titles()).toEqual(['fresh'])
  })

  it('a Show more failure other than a gone cursor is shown as it is, with no restart', async () => {
    vi.mocked(api.listImages)
      .mockResolvedValueOnce({ items: [image('a')], next: 'a' })
      .mockRejectedValueOnce(new ApiError(422, 'q: must be at most 200 characters'))
    vi.mocked(api.config).mockResolvedValue(config)
    mountAt('/')
    await tick(0)
    fireEvent.click(screen.getByRole('link', { name: 'Show more' }))
    await tick(0)
    expect(screen.getByText('q: must be at most 200 characters')).toBeTruthy()
    expect(api.listImages).toHaveBeenCalledTimes(2)
    expect(titles()).toEqual(['a'])
  })

  it('a gone cursor on Show more restarts the list from the start the URL names', async () => {
    vi.mocked(api.listImages)
      .mockResolvedValueOnce({ items: [image('b')], next: 'b' })
      .mockRejectedValueOnce(gone())
      .mockResolvedValueOnce({ items: [image('c')], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    mountAt('/?before=a')
    await tick(0)
    fireEvent.click(screen.getByRole('link', { name: 'Show more' }))
    await tick(0)
    expect(api.listImages).toHaveBeenLastCalledWith({ limit: 24, before: 'a' })
    expect(titles()).toEqual(['c'])
  })

  it('the Show more link stays busy until the restart after a gone cursor has landed', async () => {
    let release!: (page: Awaited<ReturnType<typeof api.listImages>>) => void
    vi.mocked(api.listImages)
      .mockResolvedValueOnce({ items: [image('b')], next: 'b' })
      .mockRejectedValueOnce(gone())
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    vi.mocked(api.config).mockResolvedValue(config)
    mountAt('/?before=a')
    await tick(0)
    fireEvent.click(screen.getByRole('link', { name: 'Show more' }))
    await tick(0)
    // A second tap here would send the same gone cursor again, so the link is held busy.
    expect(screen.getByRole('link', { name: 'Loading…' }).getAttribute('aria-disabled')).toBe('true')
    release({ items: [image('c')], next: null })
    await tick(0)
    expect(screen.queryByRole('link', { name: 'Loading…' })).toBeNull()
    expect(titles()).toEqual(['c'])
  })

  it('a refresh whose walk loses a chained cursor keeps the start and the cards it has', async () => {
    const many = Array.from({ length: 101 }, (_, n) => image(`i${n}`, { published: n === 0 }))
    vi.mocked(api.listImages)
      .mockResolvedValueOnce({ items: many, next: 'i100' })
      // The refresh walks the 101 shown cards in two requests; the row the first one ends on
      // is deleted in between, so the second one answers 410 although the start is fine.
      .mockResolvedValueOnce({ items: many.slice(0, 100), next: 'i99' })
      .mockRejectedValueOnce(gone())
    vi.mocked(api.config).mockResolvedValue(config)
    vi.mocked(api.setPublished).mockResolvedValue(image('i0', { published: false }))
    mountAt('/?before=a')
    await tick(0)
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }))
    await tick(0)
    expect(api.listImages).toHaveBeenCalledTimes(3)
    expect(api.listImages).toHaveBeenNthCalledWith(2, { limit: 100, before: 'a' })
    expect(api.listImages).toHaveBeenNthCalledWith(3, { limit: 1, before: 'i99' })
    expect(screen.getByTestId('url').textContent).toBe('?before=a')
    expect(screen.queryByText(/no longer available/)).toBeNull()
    expect(titles()).toHaveLength(100)
  })
})

describe('ImageCard rename (#231)', () => {
  function mountOne(title = 'a') {
    vi.mocked(api.listImages).mockResolvedValueOnce({ items: [image('a', { title })], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    mount()
  }

  it('the heading is the control: clicking the name opens a box with it; Save sends the trimmed name and the card shows it', async () => {
    mountOne()
    await tick(0)
    // The name sits inside the heading, so the list of titles stays clean of any glyph.
    expect(titles()).toEqual(['a'])
    // The heading keeps the name as its own accessible name: the control inside is the name.
    expect(screen.getByRole('heading', { level: 3, name: 'a' }).contains(screen.getByRole('button', { name: 'a' }))).toBe(true)
    vi.mocked(api.listImages).mockResolvedValue({ items: [image('a', { title: 'Orion Belt' })], next: null })
    vi.mocked(api.rename).mockResolvedValue(image('a', { title: 'Orion Belt' }))
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    const box = screen.getByRole('textbox', { name: 'New name' }) as HTMLInputElement
    expect(box.value).toBe('a')
    expect(document.activeElement).toBe(box)
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull()
    fireEvent.change(box, { target: { value: '  Orion Belt ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await tick(0)
    expect(api.rename).toHaveBeenCalledWith('a', 'Orion Belt')
    expect(titles()).toEqual(['Orion Belt'])
    expect(screen.queryByRole('textbox', { name: 'New name' })).toBeNull()
  })

  it('Cancel and Escape put the heading back without a request', async () => {
    mountOne()
    await tick(0)
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'New name' }), { target: { value: 'typo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(titles()).toEqual(['a'])
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'New name' }), { key: 'Escape' })
    expect(titles()).toEqual(['a'])
    // A submit that bypasses the disabled Save button (Enter, a script) sends nothing for a blank name.
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    const box = screen.getByRole('textbox', { name: 'New name' })
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.submit(box.closest('form')!)
    expect(api.rename).not.toHaveBeenCalled()
  })

  it('a refused rename shows its sentence on the card and keeps the box for a second try', async () => {
    mountOne()
    await tick(0)
    vi.mocked(api.rename).mockRejectedValue(new ApiError(422, 'title: must not be blank'))
    vi.mocked(api.listImages).mockResolvedValue({ items: [image('a')], next: null })
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'New name' }), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await tick(0)
    expect(screen.getByText('title: must not be blank')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'New name' })).toBeTruthy()
  })
})
