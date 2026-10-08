// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type HealthOut } from '../api'
import { galleryItem as item } from './galleryTestItem'
import GalleryImagePage from './GalleryImagePage'
import GalleryPage from './GalleryPage'

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
      .mockRejectedValueOnce(new ApiError(422, 'That page is no longer available; reload the list.'))
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
      .mockRejectedValueOnce(new ApiError(422, 'That page is no longer available; reload the list.'))
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

  it('says when nothing is published', async () => {
    vi.mocked(api.gallery).mockResolvedValue({ items: [], next: null })
    render(
      <MemoryRouter>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Nothing published yet.')).toBeTruthy()
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
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/gallery/:id" element={<GalleryImagePage />} />
        </Routes>
      </MemoryRouter>,
    )
  }

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
