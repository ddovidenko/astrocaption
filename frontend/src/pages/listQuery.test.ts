import { describe, expect, it } from 'vitest'
import { EMPTY_QUERY, isFiltered, pageHref, readListQuery, toPageQuery, writeListQuery } from './listQuery'

describe('readListQuery', () => {
  it('reads every filter from the URL and trims the text', () => {
    const q = readListQuery(new URLSearchParams('q=%20veil%20&status=failed&published=true&kind=nebula&since=2026-10-01&until=2026-10-31'))
    expect(q).toEqual({ q: 'veil', status: 'failed', published: true, kind: 'nebula', since: '2026-10-01', until: '2026-10-31' })
  })

  it('reads an empty URL as the empty query and ignores unknown values', () => {
    expect(readListQuery(new URLSearchParams(''))).toEqual(EMPTY_QUERY)
    expect(readListQuery(new URLSearchParams('status=weird&published=maybe&kind=planet&since=yesterday&until=2026-1-1'))).toEqual(EMPTY_QUERY)
  })
})

describe('writeListQuery', () => {
  it('sets the filters, drops before and keeps unrelated params', () => {
    const out = writeListQuery(new URLSearchParams('before=img-7&other=1'), { ...EMPTY_QUERY, q: 'm 27', status: 'solved', published: false })
    expect(out.toString()).toBe('other=1&q=m+27&status=solved&published=false')
  })

  it('spells every filter in one fixed order', () => {
    const out = writeListQuery(new URLSearchParams('until=2026-10-31&kind=galaxy'), { ...EMPTY_QUERY, kind: 'galaxy', since: '2026-10-01', until: '2026-10-31' })
    expect(out.toString()).toBe('kind=galaxy&since=2026-10-01&until=2026-10-31')
  })

  it('writes the same query as the same URL whichever filter was touched first', () => {
    const out = writeListQuery(new URLSearchParams('status=solved'), { ...EMPTY_QUERY, q: 'm 27', status: 'solved' })
    expect(out.toString()).toBe('q=m+27&status=solved')
  })

  it('removes the keys of unset filters', () => {
    const out = writeListQuery(new URLSearchParams('q=x&status=failed&published=true'), EMPTY_QUERY)
    expect(out.toString()).toBe('')
  })
})

describe('toPageQuery', () => {
  it('omits everything unset, including a blank q', () => {
    expect(toPageQuery(EMPTY_QUERY)).toEqual({})
    expect(toPageQuery({ ...EMPTY_QUERY, q: '  ' })).toEqual({})
    expect(toPageQuery({ q: 'veil', status: 'solving', published: true, kind: 'star', since: '2026-10-01', until: null })).toEqual({
      q: 'veil',
      status: 'solving',
      published: true,
      kind: 'star',
      since: '2026-10-01',
    })
  })
})

describe('isFiltered', () => {
  it('is true when any filter is set', () => {
    expect(isFiltered(EMPTY_QUERY)).toBe(false)
    expect(isFiltered({ ...EMPTY_QUERY, q: ' ' })).toBe(false)
    expect(isFiltered({ ...EMPTY_QUERY, published: false })).toBe(true)
    expect(isFiltered({ ...EMPTY_QUERY, until: '2026-10-31' })).toBe(true)
  })
})

describe('pageHref', () => {
  it('carries the filters before the cursor, spelled as the address bar spells them', () => {
    expect(pageHref(EMPTY_QUERY, 'img 9')).toBe('?before=img+9')
    expect(pageHref({ ...EMPTY_QUERY, q: 'm 27', status: 'failed', kind: 'nebula' }, 'img-9')).toBe('?q=m+27&status=failed&kind=nebula&before=img-9')
  })
})
