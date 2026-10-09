// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type ImageOut } from '../api'
import { ImageCard, UploadPanel } from './ImagesPage'

vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, setPublished: vi.fn(), resolve: vi.fn(), upload: vi.fn() } }
})

afterEach(() => {
  cleanup()
  vi.mocked(api.setPublished).mockReset()
  vi.mocked(api.resolve).mockReset()
  vi.mocked(api.upload).mockReset()
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

function renderCard(img: ImageOut, onChange = vi.fn(async () => {}), staleAfterSeconds: number | null = 900) {
  render(
    <MemoryRouter>
      <ImageCard image={img} onChange={onChange} staleAfterSeconds={staleAfterSeconds} now={Date.now()} />
    </MemoryRouter>,
  )
  return onChange
}

describe('ImageCard while a solve runs (#80)', () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()

  it('says how long the row has been queued or solving', () => {
    renderCard(image({ solve_status: 'solving', updated_at: minutesAgo(3) }))
    expect(screen.getByText('Solving…')).toBeTruthy()
    expect(screen.getByText('since 3 minutes ago')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Re-solve' })).toBeNull()
  })

  it('offers Re-solve again once the row has sat in solving for a whole timeout', async () => {
    vi.mocked(api.resolve).mockResolvedValue(image({ solve_status: 'pending' }))
    const onChange = renderCard(image({ solve_status: 'solving', updated_at: minutesAgo(16) }))
    expect(screen.getByText(/no word from the solver for 16 minutes/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Re-solve' }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(api.resolve).toHaveBeenCalledWith('img-1', undefined)
  })

  it('never calls a queued row stuck, and never without the timeout', () => {
    renderCard(image({ solve_status: 'pending', updated_at: minutesAgo(60) }))
    expect(screen.queryByRole('button', { name: 'Re-solve' })).toBeNull()
    cleanup()
    renderCard(image({ solve_status: 'solving', updated_at: minutesAgo(60) }), undefined, null)
    expect(screen.queryByRole('button', { name: 'Re-solve' })).toBeNull()
  })
})

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
        <ImageCard image={image({ solve_status: 'pending' })} onChange={vi.fn(async () => {})} staleAfterSeconds={900} now={Date.now()} />
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
        <ImageCard image={image(exported)} onChange={vi.fn(async () => {})} staleAfterSeconds={900} now={Date.now()} />
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

// #29: the rarer nova levers sit behind More hints; only what is filled in is sent.
describe('ImageCard re-solve hints', () => {
  const failed = () => image({ solve_status: 'failed', solve_error: 'nope' })

  it('keeps downsample and the position hint behind a toggle', () => {
    renderCard(failed())
    expect(screen.queryByLabelText('Downsample')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More hints' }))
    expect(screen.getByLabelText('Downsample')).toBeTruthy()
    expect(screen.getByLabelText('Centre RA °')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Fewer hints' }))
    expect(screen.queryByLabelText('Downsample')).toBeNull()
  })

  it('sends only the hints that were filled in', async () => {
    vi.mocked(api.resolve).mockResolvedValue(image({ solve_status: 'pending' }))
    renderCard(failed())
    fireEvent.click(screen.getByRole('button', { name: 'More hints' }))
    fireEvent.change(screen.getByLabelText('Downsample'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Centre RA °'), { target: { value: '83.8' } })
    fireEvent.change(screen.getByLabelText('Dec °'), { target: { value: '-5.4' } })
    fireEvent.change(screen.getByLabelText('Radius °'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Re-solve' }))
    await waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(1))
    expect(api.resolve).toHaveBeenCalledWith('img-1', {
      downsample_factor: 2,
      center_ra: 83.8,
      center_dec: -5.4,
      radius_deg: 3,
    })
  })

  it('sends a half position hint as given, so the server can refuse it in words', async () => {
    vi.mocked(api.resolve).mockResolvedValue(image({ solve_status: 'pending' }))
    renderCard(failed())
    fireEvent.click(screen.getByRole('button', { name: 'More hints' }))
    fireEvent.change(screen.getByLabelText('Centre RA °'), { target: { value: '83.8' } })
    fireEvent.click(screen.getByRole('button', { name: 'Re-solve' }))
    await waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(1))
    expect(api.resolve).toHaveBeenCalledWith('img-1', { center_ra: 83.8 })
  })

  it('sends nothing when the inputs are blank', async () => {
    vi.mocked(api.resolve).mockResolvedValue(image({ solve_status: 'pending' }))
    renderCard(failed())
    fireEvent.click(screen.getByRole('button', { name: 'Re-solve' }))
    await waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(1))
    expect(api.resolve).toHaveBeenCalledWith('img-1', undefined)
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
    expect(screen.getByText('12 objects')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull() // needs a solved row
  })

  it('hides them on a failed row that was never solved', () => {
    renderCard(image({ solve_status: 'failed', solve_error: 'nope', annotations_hash: null, object_count: 0 }))
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull()
  })

  it.each(['pending', 'solving'] as const)('hides them while a solve is %s', (solve_status) => {
    renderCard(image({ solve_status }))
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull()
  })
})

describe('UploadPanel cancel (#80)', () => {
  it('shows Cancel while bytes go out, aborts on click and clears the panel without an error', async () => {
    let signal: AbortSignal | undefined
    vi.mocked(api.upload).mockImplementation(
      (_file, _title, onProgress, s) =>
        new Promise((_resolve, reject) => {
          signal = s
          onProgress?.(10, 100)
          s?.addEventListener('abort', () => reject(new Error('The upload was cancelled.')))
        }),
    )
    const onUploaded = vi.fn(async () => {})
    render(<UploadPanel onUploaded={onUploaded} maxUploadMb={null} />)
    const input = document.querySelector('input[type=file]') as HTMLInputElement
    const file = new File(['x'], 'orion.jpg', { type: 'image/jpeg' })
    Object.defineProperty(input, 'files', { value: [file] })
    fireEvent.submit(input.closest('form')!)
    const cancel = await screen.findByRole('button', { name: 'Cancel' })
    expect(screen.getByRole('button', { name: /Uploading… 10%/ })).toBeTruthy()
    fireEvent.click(cancel)
    await waitFor(() => expect(signal?.aborted).toBe(true))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload & solve' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(document.querySelector('.error')).toBeNull()
    expect(onUploaded).not.toHaveBeenCalled()
  })

  it('withdraws Cancel once every byte is out and the server is processing', async () => {
    vi.mocked(api.upload).mockImplementation(
      (_file, _title, onProgress) =>
        new Promise(() => {
          onProgress?.(100, 100)
        }),
    )
    render(<UploadPanel onUploaded={vi.fn(async () => {})} maxUploadMb={null} />)
    const input = document.querySelector('input[type=file]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'orion.jpg')] })
    fireEvent.submit(input.closest('form')!)
    expect(await screen.findByRole('button', { name: 'Processing…' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })
})

describe('UploadPanel drag and drop (#149)', () => {
  function panel() {
    const onUploaded = vi.fn(async () => {})
    render(<UploadPanel onUploaded={onUploaded} maxUploadMb={null} />)
    return { onUploaded, section: document.querySelector('section.panel')! }
  }
  const transfer = (files: File[]) => ({ dataTransfer: { files, types: ['Files'], dropEffect: 'none' } })

  it('starts the upload from a dropped image with the title typed so far', async () => {
    vi.mocked(api.upload).mockResolvedValue(image())
    const { onUploaded, section } = panel()
    fireEvent.change(screen.getByPlaceholderText('Title (optional)'), { target: { value: 'Pelican' } })
    const file = new File(['x'], 'Pelican.TIF')
    fireEvent.drop(section, transfer([file]))
    await waitFor(() => expect(onUploaded).toHaveBeenCalled())
    expect(api.upload).toHaveBeenCalledWith(file, 'Pelican', expect.any(Function), expect.any(AbortSignal), null)
    expect(document.querySelector('.error')).toBeNull()
  })

  it('shows the target while a file is over the panel and clears it when it leaves', () => {
    const { section } = panel()
    expect(screen.getByText('or drop an image here')).toBeTruthy()
    fireEvent.dragOver(section, transfer([]))
    expect(section.classList.contains('dragging')).toBe(true)
    expect(screen.getByText('Drop to upload')).toBeTruthy()
    fireEvent.dragLeave(section, { relatedTarget: document.body })
    expect(section.classList.contains('dragging')).toBe(false)
    expect(screen.getByText('or drop an image here')).toBeTruthy()
  })

  it('refuses several files, and a file the picker would not accept', () => {
    const { section } = panel()
    fireEvent.drop(section, transfer([new File(['x'], 'a.jpg'), new File(['x'], 'b.jpg')]))
    expect(screen.getByText('Drop one image at a time.')).toBeTruthy()
    fireEvent.drop(section, transfer([new File(['x'], 'orion.gif')]))
    expect(screen.getByText('Drop a JPG, PNG or TIFF.')).toBeTruthy()
    expect(api.upload).not.toHaveBeenCalled()
  })

  it('ignores a drop while an upload is running', async () => {
    vi.mocked(api.upload).mockImplementation(() => new Promise(() => {}))
    const { section } = panel()
    fireEvent.drop(section, transfer([new File(['x'], 'one.jpg')]))
    await screen.findByRole('button', { name: 'Uploading…' })
    fireEvent.drop(section, transfer([new File(['x'], 'two.jpg')]))
    expect(api.upload).toHaveBeenCalledTimes(1)
  })
})
