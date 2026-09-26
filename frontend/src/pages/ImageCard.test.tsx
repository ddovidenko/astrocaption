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
