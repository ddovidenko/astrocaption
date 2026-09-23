// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type HealthOut } from '../api'
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

const item = {
  id: 'img-1',
  title: 'Orion',
  width: 3000,
  height: 2000,
  exported_at: '2026-09-22T10:05:00Z',
  thumb_url: '/api/gallery/img-1/files/thumb',
  preview_url: '/api/gallery/img-1/files/preview',
  annotated_preview_url: '/api/gallery/img-1/files/annotated-preview?v=x',
  export_url: '/api/gallery/img-1/files/export?v=x',
}

describe('GalleryPage', () => {
  it('lists published images as links to the full view', async () => {
    vi.mocked(api.gallery).mockResolvedValue([item])
    render(
      <MemoryRouter>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    const link = await screen.findByRole('link', { name: /Orion/ })
    expect(link.getAttribute('href')).toBe('/gallery/img-1')
  })

  it('says when nothing is published', async () => {
    vi.mocked(api.gallery).mockResolvedValue([])
    render(
      <MemoryRouter>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Nothing published yet.')).toBeTruthy()
  })

  it('shows only a sign-in link when the gallery is switched off', () => {
    render(
      <MemoryRouter>
        <GalleryPage health={health({ public_gallery_enabled: false })} />
      </MemoryRouter>,
    )
    expect(api.gallery).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'Log in' }).getAttribute('href')).toBe('/login')
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
