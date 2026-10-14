// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, type ConfigOut } from '../api'
import ConfigPage from './ConfigPage'

// The config page's component test (#47): what the Playwright smoke test does not pin. A save
// the server refused keeps the owner's edits on the page with the message; a save that landed
// adopts the response; a field the environment pins is disabled and never leaves the page.
vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, config: vi.fn(), fonts: vi.fn(), updateConfig: vi.fn() } }
})

const config: ConfigOut = {
  site_title: 'Sky',
  max_upload_mb: 60,
  public_gallery_enabled: true,
  nova_api_key_set: false,
  default_style: {},
  style_defaults: {
    font_file: 'Inter-Regular.ttf',
    text_color: '#ffffff',
    marker_color: '#ffcc00',
    leader_color: '#ffcc00',
    halo: true,
    halo_color: '#000000',
    show_aliases: true,
    max_aliases: 2,
    name_preference: 'popular',
  },
  locked: ['max_upload_mb'],
  locked_by: { max_upload_mb: 'ASTROCAPTION_MAX_UPLOAD_MB' },
  solve_timeout_seconds: 900,
  upload_chunk_mb: 16,
  min_label_radius_percent: 0.4,
}

beforeEach(() => {
  vi.mocked(api.config).mockResolvedValue(config)
  vi.mocked(api.fonts).mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  vi.mocked(api.config).mockReset()
  vi.mocked(api.fonts).mockReset()
  vi.mocked(api.updateConfig).mockReset()
})

async function mount() {
  const refreshHealth = vi.fn().mockResolvedValue({})
  render(<ConfigPage refreshHealth={refreshHealth} />)
  const title = (await screen.findByLabelText('Site title')) as HTMLInputElement
  return { title, refreshHealth }
}

describe('ConfigPage', () => {
  it('a refused save keeps the edits on the page and says why', async () => {
    const { title } = await mount()
    vi.mocked(api.updateConfig).mockRejectedValue(new ApiError(500, 'The settings could not be saved: the disk holding ./data is full.'))
    fireEvent.change(title, { target: { value: 'New sky' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('The settings could not be saved: the disk holding ./data is full.')
    expect(title.value).toBe('New sky') // not reset to what the server holds
    expect(screen.queryByText('Saved.')).toBeNull()
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('a save that landed adopts the response and refreshes the header', async () => {
    const { title, refreshHealth } = await mount()
    vi.mocked(api.updateConfig).mockResolvedValue({ ...config, site_title: 'New sky' })
    fireEvent.change(title, { target: { value: '  New sky ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(vi.mocked(api.updateConfig)).toHaveBeenCalledWith({ site_title: 'New sky' })
    expect(title.value).toBe('New sky')
    expect(refreshHealth).toHaveBeenCalledTimes(1)
    // An edit makes "Saved." stale.
    fireEvent.change(title, { target: { value: 'Newer sky' } })
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  it('a field pinned by the environment is disabled, named, and never in the body', async () => {
    const { title } = await mount()
    const upload = screen.getByLabelText(/^Upload limit/) as HTMLInputElement
    expect(upload.disabled).toBe(true)
    expect(screen.getByText('Set by ASTROCAPTION_MAX_UPLOAD_MB')).toBeTruthy()
    expect(title.disabled).toBe(false)
    vi.mocked(api.updateConfig).mockResolvedValue({ ...config, site_title: 'New sky' })
    fireEvent.change(title, { target: { value: 'New sky' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    const body = vi.mocked(api.updateConfig).mock.calls[0]![0]
    expect(body).toEqual({ site_title: 'New sky' })
    expect('max_upload_mb' in body).toBe(false)
  })

  it('the label threshold is shown as a percentage and saved as a number (#211)', async () => {
    await mount()
    const threshold = screen.getByLabelText(/^Label objects at least this large/) as HTMLInputElement
    expect(threshold.value).toBe('0.4')
    vi.mocked(api.updateConfig).mockResolvedValue({ ...config, min_label_radius_percent: 1 })
    fireEvent.change(threshold, { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(vi.mocked(api.updateConfig).mock.calls[0]![0]).toEqual({ min_label_radius_percent: 1 })
    expect(threshold.value).toBe('1')
  })
})
