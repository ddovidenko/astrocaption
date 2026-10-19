// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type GalleryItem, type HealthOut } from '../api'
import { galleryItem as item } from './galleryTestItem'
import GalleryImagePage from './GalleryImagePage'
import GalleryPage from './GalleryPage'
import { SEARCH_DEBOUNCE_MS } from './ListFilters'
import Url from './testUrl'

vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, gallery: vi.fn(), galleryImage: vi.fn() } }
})

afterEach(() => {
  cleanup()
  vi.mocked(api.gallery).mockReset()
  vi.mocked(api.galleryImage).mockReset()
})

const health = (over: Partial<HealthOut> = {}): HealthOut => ({
  status: 'ok',
  version: '0.5.0',
  site_title: 'Sky',
  setup_required: false,
  authenticated: false,
  config_error: null,
  locked: [],
  public_gallery_enabled: true,
  ...over,
})

describe('GalleryPage', () => {
  it('lists published images as links to the full view', async () => {
    vi.mocked(api.gallery).mockResolvedValue({ items: [item], next: null })
    render(
      <MemoryRouter>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    const link = await screen.findByRole('link', { name: /Orion/ })
    expect(link.getAttribute('href')).toBe('/gallery/img-1')
    expect(api.gallery).toHaveBeenCalledWith({ before: null })
    expect(screen.queryByRole('link', { name: 'Show more' })).toBeNull()
  })

  it('appends the next page on Show more and stops on the last one', async () => {
    const second = { ...item, id: 'img-2', title: 'Pleiades' }
    vi.mocked(api.gallery)
      .mockResolvedValueOnce({ items: [item], next: 'img-1' })
      .mockResolvedValueOnce({ items: [second], next: null })
    render(
      <MemoryRouter>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    const more = await screen.findByRole('link', { name: 'Show more' })
    expect(more.getAttribute('href')).toBe('?before=img-1')
    fireEvent.click(more)
    expect(await screen.findByRole('link', { name: /Pleiades/ })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Orion/ })).toBeTruthy()
    expect(api.gallery).toHaveBeenLastCalledWith({ before: 'img-1' })
    expect(screen.queryByRole('link', { name: 'Show more' })).toBeNull()
  })

  it('starts from the page a followed Show more link names', async () => {
    vi.mocked(api.gallery).mockResolvedValue({ items: [item], next: null })
    render(
      <MemoryRouter initialEntries={['/gallery?before=img-7']}>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    await screen.findByRole('link', { name: /Orion/ })
    expect(api.gallery).toHaveBeenCalledWith({ before: 'img-7' })
  })

  it('restarts from the page the URL names when the cursor image was unpublished meanwhile', async () => {
    vi.mocked(api.gallery)
      .mockResolvedValueOnce({ items: [item], next: 'img-1' })
      .mockRejectedValueOnce(new ApiError(410, 'That page is no longer available; reload the list.'))
      .mockResolvedValueOnce({ items: [{ ...item, id: 'img-3', title: 'Andromeda' }], next: null })
    render(
      <MemoryRouter initialEntries={['/gallery?before=img-7']}>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('link', { name: 'Show more' }))
    expect(await screen.findByRole('link', { name: /Andromeda/ })).toBeTruthy()
    expect(api.gallery).toHaveBeenLastCalledWith({ before: 'img-7' })
  })

  it('restarts from the top when the cursor image was unpublished meanwhile', async () => {
    vi.mocked(api.gallery)
      .mockResolvedValueOnce({ items: [item], next: 'img-1' })
      .mockRejectedValueOnce(new ApiError(410, 'That page is no longer available; reload the list.'))
      .mockResolvedValueOnce({ items: [{ ...item, id: 'img-3', title: 'Andromeda' }], next: null })
    render(
      <MemoryRouter>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('link', { name: 'Show more' }))
    expect(await screen.findByRole('link', { name: /Andromeda/ })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Orion/ })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Show more' })).toBeNull()
  })

  it('starts from the top and drops the cursor from the URL when the followed page is gone (#227)', async () => {
    vi.mocked(api.gallery)
      .mockRejectedValueOnce(new ApiError(410, 'That page is no longer available; reload the list.'))
      .mockResolvedValueOnce({ items: [item], next: null })
    render(
      <MemoryRouter initialEntries={['/gallery?q=orion&before=unpublished']}>
        <GalleryPage health={health()} />
        <Url />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('link', { name: /Orion/ })).toBeTruthy()
    expect(screen.getByTestId('url').textContent).toBe('?q=orion')
    expect(api.gallery).toHaveBeenLastCalledWith({ q: 'orion', before: null })
    expect(screen.queryByText(/no longer available/)).toBeNull()
  })

  it('a Show more failure other than a gone cursor is shown as it is, with no restart (#227)', async () => {
    vi.mocked(api.gallery)
      .mockResolvedValueOnce({ items: [item], next: 'img-1' })
      .mockRejectedValueOnce(new ApiError(422, 'q: must be at most 200 characters'))
    render(
      <MemoryRouter>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('link', { name: 'Show more' }))
    expect(await screen.findByText('q: must be at most 200 characters')).toBeTruthy()
    expect(api.gallery).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('link', { name: /Orion/ })).toBeTruthy()
  })

  it('captions each card with its title and the upload day', async () => {
    vi.mocked(api.gallery).mockResolvedValue({ items: [item], next: null })
    render(
      <MemoryRouter>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    const caption = (await screen.findByText('Orion')).closest('figcaption')!
    const when = caption.querySelector('time')!
    expect(when.textContent).toBe('21 Sep 2026')
    expect(when.getAttribute('datetime')).toBe('2026-09-21T18:00:00Z')
  })

  it('says when nothing is published', async () => {
    vi.mocked(api.gallery).mockResolvedValue({ items: [], next: null })
    render(
      <MemoryRouter>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Nothing published yet.')).toBeTruthy()
  })

  it('searches from the URL and shows the no-match sentence with a way out', async () => {
    vi.mocked(api.gallery).mockResolvedValue({ items: [], next: null })
    render(
      <MemoryRouter initialEntries={['/gallery?q=veil']}>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Nothing matches.')).toBeTruthy()
    expect(api.gallery).toHaveBeenCalledWith({ q: 'veil', before: null })
    expect((screen.getByRole('searchbox', { name: 'Search the gallery' }) as HTMLInputElement).value).toBe('veil')
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy()
    expect(screen.queryByText('Nothing published yet.')).toBeNull()
  })

  it('writes a typed search into the URL after a pause and fetches the first page of it', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(api.gallery)
        .mockResolvedValueOnce({ items: [item], next: 'img-1' })
        .mockResolvedValueOnce({ items: [{ ...item, id: 'img-3', title: 'Andromeda' }], next: null })
      render(
        <MemoryRouter initialEntries={['/gallery?before=img-7']}>
          <GalleryPage health={health()} />
          <Url />
        </MemoryRouter>,
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByRole('link', { name: /Orion/ })).toBeTruthy()
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search the gallery' }), { target: { value: 'andromeda' } })
      expect(api.gallery).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS) })
      // The cursor is gone from the URL: the search starts from the top of its own result set.
      expect(screen.getByTestId('url').textContent).toBe('?q=andromeda')
      expect(api.gallery).toHaveBeenLastCalledWith({ q: 'andromeda', before: null })
      expect(screen.getByRole('link', { name: /Andromeda/ })).toBeTruthy()
      expect(screen.queryByRole('link', { name: /Orion/ })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a search that fails shows the error and no cards from the previous search, with Clear', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(api.gallery)
        .mockResolvedValueOnce({ items: [item], next: 'img-1' })
        .mockRejectedValueOnce(new ApiError(500, 'The server could not answer.'))
      render(
        <MemoryRouter>
          <GalleryPage health={health()} />
        </MemoryRouter>,
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByRole('link', { name: /Orion/ })).toBeTruthy()
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search the gallery' }), { target: { value: 'veil' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS) })
      expect(screen.getByText('The server could not answer.')).toBeTruthy()
      expect(screen.queryByRole('link', { name: /Orion/ })).toBeNull()
      expect(screen.queryByRole('link', { name: 'Show more' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('carries the search in the Show more link', async () => {
    vi.mocked(api.gallery).mockResolvedValue({ items: [item], next: 'img-1' })
    render(
      <MemoryRouter initialEntries={['/gallery?q=orion']}>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    const more = await screen.findByRole('link', { name: 'Show more' })
    expect(more.getAttribute('href')).toBe('?q=orion&before=img-1')
    fireEvent.click(more)
    expect(api.gallery).toHaveBeenLastCalledWith({ q: 'orion', before: 'img-1' })
  })

  it('drops a Show more page that lands after the visitor searched for something else', async () => {
    vi.useFakeTimers()
    try {
      let answerMore: (page: { items: GalleryItem[]; next: string | null }) => void = () => {}
      vi.mocked(api.gallery)
        .mockResolvedValueOnce({ items: [item], next: 'img-1' })
        .mockImplementationOnce(() => new Promise((resolve) => { answerMore = resolve }))
        .mockResolvedValueOnce({ items: [{ ...item, id: 'img-3', title: 'Andromeda' }], next: null })
      render(
        <MemoryRouter initialEntries={['/gallery']}>
          <GalleryPage health={health()} />
        </MemoryRouter>,
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      fireEvent.click(screen.getByRole('link', { name: 'Show more' }))
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search the gallery' }), { target: { value: 'andromeda' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS) })
      expect(screen.getByRole('link', { name: /Andromeda/ })).toBeTruthy()
      await act(async () => { answerMore({ items: [{ ...item, id: 'img-2', title: 'Pleiades' }], next: null }) })
      expect(screen.queryByRole('link', { name: /Pleiades/ })).toBeNull()
      expect(screen.getByRole('link', { name: /Andromeda/ })).toBeTruthy()
      expect(screen.queryByRole('link', { name: 'Show more' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a Show more restart that lands after the visitor searched for something else', async () => {
    vi.useFakeTimers()
    try {
      let answerRestart: (page: { items: GalleryItem[]; next: string | null }) => void = () => {}
      vi.mocked(api.gallery)
        .mockResolvedValueOnce({ items: [item], next: 'img-1' })
        .mockRejectedValueOnce(new ApiError(410, 'The page is gone.'))
        .mockImplementationOnce(() => new Promise((resolve) => { answerRestart = resolve }))
        .mockResolvedValueOnce({ items: [{ ...item, id: 'img-3', title: 'Andromeda' }], next: null })
      render(
        <MemoryRouter initialEntries={['/gallery']}>
          <GalleryPage health={health()} />
        </MemoryRouter>,
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      fireEvent.click(screen.getByRole('link', { name: 'Show more' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search the gallery' }), { target: { value: 'andromeda' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS) })
      expect(screen.getByRole('link', { name: /Andromeda/ })).toBeTruthy()
      await act(async () => { answerRestart({ items: [item], next: null }) })
      expect(screen.queryByRole('link', { name: /Orion/ })).toBeNull()
      expect(screen.getByRole('link', { name: /Andromeda/ })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('kind and dates reach the API from the URL, and a chosen day drops the cursor', async () => {
    vi.mocked(api.gallery).mockResolvedValue({ items: [item], next: null })
    render(
      <MemoryRouter initialEntries={['/gallery?kind=nebula&before=img-7']}>
        <GalleryPage health={health()} />
        <Url />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('link', { name: /Orion/ })).toBeTruthy()
    expect(api.gallery).toHaveBeenCalledWith({ kind: 'nebula', before: 'img-7' })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-31' } })
    expect(await screen.findByText('?kind=nebula&until=2026-10-31')).toBeTruthy()
    expect(api.gallery).toHaveBeenLastCalledWith({ kind: 'nebula', until: '2026-10-31', before: null })
  })

  it('drops the answer of a search the visitor has already moved on from', async () => {
    let answerSlow: (page: { items: GalleryItem[]; next: null }) => void = () => {}
    vi.mocked(api.gallery)
      .mockImplementationOnce(() => new Promise((resolve) => { answerSlow = resolve }))
      .mockResolvedValueOnce({ items: [{ ...item, id: 'img-3', title: 'Andromeda' }], next: null })
    const { rerender } = render(
      <MemoryRouter key="slow" initialEntries={['/gallery?q=slow']}>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    // The URL moves on (a second search) before the first answers. A new `key` remounts the
    // router: `initialEntries` is read once, so a plain rerender would keep the old URL.
    rerender(
      <MemoryRouter key="andromeda" initialEntries={['/gallery?q=andromeda']}>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('link', { name: /Andromeda/ })).toBeTruthy()
    await act(async () => { answerSlow({ items: [item], next: null }) })
    expect(screen.queryByRole('link', { name: /Orion/ })).toBeNull()
  })

  it('shows a plain sentence, not the gallery, when switched off', () => {
    render(
      <MemoryRouter>
        <GalleryPage health={health({ public_gallery_enabled: false })} />
      </MemoryRouter>,
    )
    expect(api.gallery).not.toHaveBeenCalled()
    expect(screen.getByText('Nothing to see here yet.')).toBeTruthy()
  })
})

describe('GalleryImagePage', () => {
  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/gallery/:id" element={<GalleryImagePage siteTitle="Sky" />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('names the image in the document title while it is open, as the server-filled shell does', async () => {
    document.title = 'Sky'
    vi.mocked(api.galleryImage).mockResolvedValue(item)
    const { unmount } = renderAt('/gallery/img-1')
    await screen.findByRole('link', { name: /^Download annotated image/ })
    expect(document.title).toBe('Orion · Sky')
    unmount()
    expect(document.title).toBe('Sky')
  })

  it('shows the picture, the download link and the size', async () => {
    vi.mocked(api.galleryImage).mockResolvedValue(item)
    renderAt('/gallery/img-1')
    const download = await screen.findByRole('link', { name: 'Download annotated image (3000 × 2000)' })
    expect(download.getAttribute('href')).toBe(item.export_url)
    expect(screen.getByRole('link', { name: 'Back to the gallery' }).getAttribute('href')).toBe('/gallery')
  })

  it('says when the image is not published', async () => {
    vi.mocked(api.galleryImage).mockRejectedValue(new ApiError(404, 'Image not found.'))
    renderAt('/gallery/nope')
    expect(await screen.findByText('This image is not published.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to the gallery' })).toBeTruthy()
  })
})
