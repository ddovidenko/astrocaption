// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type ImageOut } from '../api'
import { ImageCard } from './ImagesPage'

vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, setPublished: vi.fn() } }
})

afterEach(() => {
  cleanup()
  vi.mocked(api.setPublished).mockReset()
})

function image(over: Partial<ImageOut> = {}): ImageOut {
  return {
    id: 'img-1',
    title: 'Orion',
    original_name: 'orion.jpg',
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
    preview_url: '/api/images/img-1/files/preview',
    thumb_url: '/api/images/img-1/files/thumb',
    original_url: '/api/images/img-1/files/original',
    annotated_preview_url: null,
    export_url: null,
    ...over,
  }
}

const exported = {
  exported_at: '2026-09-22T10:05:00Z',
  exported_hash: 'h1',
  annotated_preview_url: '/api/images/img-1/files/annotated-preview?v=x',
  export_url: '/api/images/img-1/export?v=x',
}

function renderCard(img: ImageOut, onChange = vi.fn(async () => {})) {
  render(
    <MemoryRouter>
      <ImageCard image={img} onChange={onChange} />
    </MemoryRouter>,
  )
  return onChange
}

describe('ImageCard publish button', () => {
  it('is disabled with a reason until the image has an export', () => {
    renderCard(image())
    const button = screen.getByRole('button', { name: 'Publish' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.title).toBe('Export the image first')
    expect(screen.queryByText('Published')).toBeNull()
  })

  it('publishes an exported image and refreshes the list', async () => {
    vi.mocked(api.setPublished).mockResolvedValue(image({ ...exported, published: true }))
    const onChange = renderCard(image(exported))
    const button = screen.getByRole('button', { name: 'Publish' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(api.setPublished).toHaveBeenCalledWith('img-1', true)
  })

  it('offers Unpublish and a badge on a published image', async () => {
    vi.mocked(api.setPublished).mockResolvedValue(image({ ...exported, published: false }))
    renderCard(image({ ...exported, published: true }))
    expect(screen.getByText('Published')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }))
    await waitFor(() => expect(api.setPublished).toHaveBeenCalledWith('img-1', false))
  })

  it('still offers Unpublish, and no Publish, on a published image that is now failed', () => {
    renderCard(image({ ...exported, published: true, solve_status: 'failed', solve_error: 'nova timed out' }))
    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
  })

  it('shows the server refusal on the card', async () => {
    vi.mocked(api.setPublished).mockRejectedValue(new ApiError(409, 'Export the image before publishing it.'))
    renderCard(image(exported))
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect(await screen.findByText('Export the image before publishing it.')).toBeTruthy()
  })
})

describe('ImageCard nova links', () => {
  it('links the latest solve without repeating the nova copies note (it lives on the config page, #113)', () => {
    renderCard(image({ nova_status_url: 'https://nova.astrometry.net/status/1' }))
    expect(screen.getByRole('link', { name: 'nova status' })).toBeTruthy()
    expect(screen.queryByText(/uploads a copy/)).toBeNull()
  })
})

// #141: the card has no thumbnail of the original; a download link for it is always there, and on an
// exported image it comes first in the downloads line, before the export.
describe('ImageCard downloads', () => {
  it('offers the original, under its uploaded name, without showing a thumbnail', () => {
    const { container } = render(
      <MemoryRouter>
        <ImageCard image={image({ solve_status: 'pending' })} onChange={vi.fn(async () => {})} />
      </MemoryRouter>,
    )
    const link = screen.getByRole('link', { name: 'Download original' })
    expect(link.getAttribute('href')).toBe('/api/images/img-1/files/original')
    expect(link.getAttribute('download')).toBe('orion.jpg')
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Download full-resolution export' })).toBeNull()
  })

  it('puts the original before the export once the image is exported', () => {
    const { container } = render(
      <MemoryRouter>
        <ImageCard image={image(exported)} onChange={vi.fn(async () => {})} />
      </MemoryRouter>,
    )
    const links = screen.getAllByRole('link').map((a) => a.textContent)
    expect(links.indexOf('Download original')).toBeGreaterThanOrEqual(0)
    expect(links.indexOf('Download original')).toBeLessThan(links.indexOf('Download full-resolution export'))
    // Every <img>, decorative ones included (the old thumbnail had alt="", which no role query sees).
    const imgs = container.querySelectorAll('img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0]!.getAttribute('src')).toBe(exported.annotated_preview_url)
  })
})

// #173: Edit and Export follow the layout, not the status. A failed re-solve keeps the previous
// layout (the editor edits and exports it); a never-solved failure and a solve in flight have none.
describe('ImageCard edit and export availability', () => {
  it('offers Edit and Export on a failed row that still has a layout', () => {
    renderCard(image({ solve_status: 'failed', solve_error: 'nope', annotations_hash: 'h1' }))
    expect(screen.getByRole('link', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Re-solve' })).toBeTruthy()
  })

  it('hides them on a failed row that was never solved', () => {
    renderCard(image({ solve_status: 'failed', solve_error: 'nope', annotations_hash: null, object_count: 0 }))
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull()
  })

  it('hides them while a solve is running', () => {
    renderCard(image({ solve_status: 'solving' }))
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull()
  })
})
