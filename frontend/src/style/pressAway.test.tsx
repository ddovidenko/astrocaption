// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePressAway } from './pressAway'

function Host({ active, onAway }: { active: boolean; onAway: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  usePressAway(ref, active, onAway)
  return (
    <>
      <div ref={ref} data-testid="inside">
        <button>in</button>
      </div>
      <div data-testid="outside" />
    </>
  )
}

/** A touch the page cancelled, as the editor canvas does with every touch that lands on it. */
function cancelledTouch(el: Element) {
  const cancel = (e: Event) => e.preventDefault()
  el.addEventListener('touchstart', cancel)
  fireEvent.touchStart(el)
  el.removeEventListener('touchstart', cancel)
}

afterEach(cleanup)

describe('usePressAway', () => {
  it('a mouse press outside calls back; one inside does not', () => {
    const onAway = vi.fn()
    render(<Host active onAway={onAway} />)
    fireEvent.mouseDown(screen.getByText('in'))
    expect(onAway).not.toHaveBeenCalled()
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(onAway).toHaveBeenCalledTimes(1)
  })

  it('a cancelled touch outside calls back: no mousedown will follow it', () => {
    const onAway = vi.fn()
    render(<Host active onAway={onAway} />)
    cancelledTouch(screen.getByTestId('inside'))
    expect(onAway).not.toHaveBeenCalled()
    cancelledTouch(screen.getByTestId('outside'))
    expect(onAway).toHaveBeenCalledTimes(1)
  })

  it('an ordinary touch outside does not: it may be a scroll, and a tap brings its own mousedown', () => {
    const onAway = vi.fn()
    render(<Host active onAway={onAway} />)
    fireEvent.touchStart(screen.getByTestId('outside'))
    expect(onAway).not.toHaveBeenCalled()
  })

  it('listens only while active', () => {
    const onAway = vi.fn()
    const { rerender } = render(<Host active={false} onAway={onAway} />)
    fireEvent.mouseDown(screen.getByTestId('outside'))
    cancelledTouch(screen.getByTestId('outside'))
    expect(onAway).not.toHaveBeenCalled()
    rerender(<Host active onAway={onAway} />)
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(onAway).toHaveBeenCalledTimes(1)
    rerender(<Host active={false} onAway={onAway} />)
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(onAway).toHaveBeenCalledTimes(1)
  })

  it('calls the callback of the latest render', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<Host active onAway={first} />)
    rerender(<Host active onAway={second} />)
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
