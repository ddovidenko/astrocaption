// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ShowMore from './ShowMore'

afterEach(cleanup)

describe('ShowMore', () => {
  it('is a real link to the next page that the app handles itself', () => {
    const onMore = vi.fn()
    render(<ShowMore next="img 9" busy={false} error={null} onMore={onMore} />)
    const link = screen.getByRole('link', { name: 'Show more' })
    expect(link.getAttribute('href')).toBe('?before=img%209')
    fireEvent.click(link)
    expect(onMore).toHaveBeenCalledTimes(1)
  })

  it('says it is loading and ignores clicks meanwhile', () => {
    const onMore = vi.fn()
    render(<ShowMore next="img-9" busy error={null} onMore={onMore} />)
    const link = screen.getByRole('link', { name: 'Loading…' })
    expect(link.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(link)
    expect(onMore).not.toHaveBeenCalled()
  })

  it('shows the failure beside the link so the reader can try again', () => {
    render(<ShowMore next="img-9" busy={false} error="The server did not answer." onMore={() => {}} />)
    expect(screen.getByText('The server did not answer.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Show more' })).toBeTruthy()
  })

  it('renders nothing on the last page', () => {
    const { container } = render(<ShowMore next={null} busy={false} error={null} onMore={() => {}} />)
    expect(container.innerHTML).toBe('')
  })
})
