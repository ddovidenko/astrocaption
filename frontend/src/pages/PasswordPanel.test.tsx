// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../api'
import PasswordPanel from './PasswordPanel'

// The password panel's component test (#82): what the Playwright round trip does not pin. The
// mismatch check never reaches the API; a landed change clears the fields; a refused one keeps
// them with the server's sentence; a lost reply says the change is undecided.
vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, changePassword: vi.fn() } }
})

afterEach(() => {
  cleanup()
  vi.mocked(api.changePassword).mockReset()
})

function mount() {
  render(<PasswordPanel />)
  const current = screen.getByLabelText('Current password') as HTMLInputElement
  const next = screen.getByLabelText('New password') as HTMLInputElement
  const again = screen.getByLabelText('New password again') as HTMLInputElement
  const fill = (from: string, to: string, repeat = to) => {
    fireEvent.change(current, { target: { value: from } })
    fireEvent.change(next, { target: { value: to } })
    fireEvent.change(again, { target: { value: repeat } })
  }
  const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
  return { current, next, again, fill, submit }
}

describe('PasswordPanel', () => {
  it('two different new passwords never reach the API', () => {
    const { fill, submit, current } = mount()
    fill('old-password', 'new-password-1', 'new-password-2')
    submit()
    expect(screen.getByText('The two new passwords do not match.')).toBeTruthy()
    expect(vi.mocked(api.changePassword)).not.toHaveBeenCalled()
    expect(current.value).toBe('old-password')
    // Typing again makes the verdict stale.
    fireEvent.change(current, { target: { value: 'old-password-' } })
    expect(screen.queryByText('The two new passwords do not match.')).toBeNull()
  })

  it('a change that landed clears the fields and says so', async () => {
    const { fill, submit, current, next, again } = mount()
    vi.mocked(api.changePassword).mockResolvedValue(undefined)
    fill('old-password', 'new-password-1')
    submit()
    await screen.findByText('Password changed.')
    expect(vi.mocked(api.changePassword)).toHaveBeenCalledWith('old-password', 'new-password-1')
    expect([current.value, next.value, again.value]).toEqual(['', '', ''])
    fireEvent.change(current, { target: { value: 'n' } })
    expect(screen.queryByText('Password changed.')).toBeNull()
  })

  it('a refused change keeps the fields and shows the server\'s sentence', async () => {
    const { fill, submit, current, next } = mount()
    vi.mocked(api.changePassword).mockRejectedValue(new ApiError(403, 'The current password is wrong.'))
    fill('old-password', 'new-password-1')
    submit()
    await screen.findByText('The current password is wrong.')
    expect(current.value).toBe('old-password')
    expect(next.value).toBe('new-password-1')
    expect(screen.queryByText('Password changed.')).toBeNull()
    expect((screen.getByRole('button', { name: 'Change password' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('a reply that never came says the change is undecided', async () => {
    const { fill, submit, current } = mount()
    vi.mocked(api.changePassword).mockRejectedValue(new TypeError('Failed to fetch'))
    fill('old-password', 'new-password-1')
    submit()
    await screen.findByText(/The password may or may not have been changed/)
    expect(screen.getByText(/Could not reach the server/)).toBeTruthy()
    expect(current.value).toBe('old-password')
  })
})
