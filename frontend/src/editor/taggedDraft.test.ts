// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useTaggedDraft } from './taggedDraft'

afterEach(cleanup)

/** Drives the hook the way the toolbar does: a tag that the test can move on between renders. */
function mount(tag: readonly unknown[]) {
  return renderHook(({ t }: { t: readonly unknown[] }) => useTaggedDraft<string>(t), { initialProps: { t: tag } })
}

describe('useTaggedDraft', () => {
  it('starts empty and holds what was set under the same tag', () => {
    const ids = new Set([1])
    const h = mount(['24', ids])
    expect(h.result.current[0]).toBeNull()
    act(() => h.result.current[1]('30'))
    expect(h.result.current[0]).toBe('30')
    h.rerender({ t: ['24', ids] })
    expect(h.result.current[0]).toBe('30')
  })

  it('goes stale when any part of the tag moves on', () => {
    const ids = new Set([1])
    const h = mount(['24', ids])
    act(() => h.result.current[1]('30'))
    h.rerender({ t: ['26', ids] }) // the stored value changed under it
    expect(h.result.current[0]).toBeNull()
    act(() => h.result.current[1]('31'))
    h.rerender({ t: ['26', new Set([1])] }) // a different selection, same members
    expect(h.result.current[0]).toBeNull()
  })

  it('comes back when the tag does: the tag alone cannot spend a draft', () => {
    // Why every caller drops its draft explicitly on commit — an undo that restores the value the
    // draft was raised against matches the tag again.
    const ids = new Set([1])
    const h = mount(['24', ids])
    act(() => h.result.current[1]('30'))
    h.rerender({ t: ['30', ids] })
    expect(h.result.current[0]).toBeNull()
    h.rerender({ t: ['24', ids] })
    expect(h.result.current[0]).toBe('30')
  })

  it('drop clears the draft for the tag it was raised under', () => {
    const ids = new Set([1])
    const h = mount(['24', ids])
    act(() => h.result.current[1]('30'))
    act(() => h.result.current[2]())
    expect(h.result.current[0]).toBeNull()
    h.rerender({ t: ['24', ids] })
    expect(h.result.current[0]).toBeNull()
  })

  it('a tag of a different length never matches', () => {
    const h = mount(['24'])
    act(() => h.result.current[1]('30'))
    h.rerender({ t: ['24', 'extra'] })
    expect(h.result.current[0]).toBeNull()
  })
})
