// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_QUERY } from './listQuery'
import ShowMore from './ShowMore'

afterEach(cleanup)

describe('ShowMore', () => {
  it('is a real link to the next page that the app handles itself', () => {
    const onMore = vi.fn()
    render(<ShowMore next="img 9" busy={false} error={null} onMore={onMore} query={EMPTY_QUERY} />)
    const link = screen.getByRole('link', { name: 'Show more' })
    expect(link.getAttribute('href')).toBe('?before=img+9')
    fireEvent.click(link)
    expect(onMore).toHaveBeenCalledTimes(1)
  })

  it('says it is loading and ignores clicks meanwhile', () => {
    const onMore = vi.fn()
    render(<ShowMore next="img-9" busy error={null} onMore={onMore} query={EMPTY_QUERY} />)
    const link = screen.getByRole('link', { name: 'Loading…' })
    expect(link.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(link)
    expect(onMore).not.toHaveBeenCalled()
  })

  it('shows the failure beside the link so the reader can try again', () => {
    render(<ShowMore next="img-9" busy={false} error="The server did not answer." onMore={() => {}} query={EMPTY_QUERY} />)
    expect(screen.getByText('The server did not answer.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Show more' })).toBeTruthy()
  })

  it('keeps the search and filters in the link so a followed page stays in the result set', () => {
    render(
      <ShowMore next="img-9" busy={false} error={null} onMore={() => {}} query={{ ...EMPTY_QUERY, q: 'm 27', status: 'solved' }} />,
    )
    expect(screen.getByRole('link', { name: 'Show more' }).getAttribute('href')).toBe('?q=m+27&status=solved&before=img-9')
  })

  it('renders nothing on the last page', () => {
    const { container } = render(<ShowMore next={null} busy={false} error={null} onMore={() => {}} query={EMPTY_QUERY} />)
    expect(container.innerHTML).toBe('')
  })
})
