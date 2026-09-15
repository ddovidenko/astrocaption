import { describe, expect, it } from 'vitest'
import raw from '../../../tests/fixtures/names/vectors.json'
import { MAX_ALIASES, aliasNames, nameCategory, primaryName } from './names'

describe('nameCategory', () => {
  it.each([
    ['M 42', 'messier'],
    ['M42', 'messier'],
    ['Messier 31', 'messier'],
    ['C 14', 'caldwell'],
    ['Caldwell 14', 'caldwell'],
    ['Sh2-279', 'sharpless'],
    ['Sh 2-279', 'sharpless'],
    ['Sharpless 279', 'sharpless'],
    ['B 33', 'barnard'],
    ['Barnard 33', 'barnard'],
    ['NGC 1976', 'ngc'],
    ['NGC 2024A', 'ngc'],
    ['IC 434', 'ic'],
    ['Cr 70', 'catalogue'],
    ['Mel 20', 'catalogue'],
    ['Abell 21', 'catalogue'],
    ['LDN 1622', 'catalogue'],
    ['LBN 974', 'catalogue'],
    ['HD 37742', 'star'],
    ['HIP 26727', 'star'],
    ['SAO 132444', 'star'],
    ['BD -02 1338', 'star'],
    ['ι Ori', 'bayer'],
    ['θ1 Ori C', 'bayer'],
    ['c Ori', 'bayer'],
    ['44 Ori', 'flamsteed'],
    ['41 Ori A', 'flamsteed'],
    ['XYZ 12', 'designation'],
    ['Orion Nebula', 'common'],
    ['Hatysa', 'common'],
    ['h Persei Cluster', 'common'],
    ['Horsehead Nebula', 'common'],
  ])('%s → %s', (name, category) => {
    expect(nameCategory(name)).toBe(category)
  })
})

describe('primaryName', () => {
  const orion = ['NGC 1976', 'M 42', 'LBN 974', 'Great Orion Nebula', 'Orion Nebula']
  it('follows the preference and keeps nova order on ties', () => {
    expect(primaryName(orion, 'popular')).toBe('M 42')
    expect(primaryName(orion, 'ngc_ic')).toBe('NGC 1976')
    expect(primaryName(['NGC 1980', 'LBN 977', 'Lower Sword'], 'popular')).toBe('NGC 1980')
    expect(primaryName(['IC 434', 'Sh2-277', 'Horsehead region'], 'popular')).toBe('Sh2-277')
    expect(primaryName(['IC 434', 'Sh2-277'], 'ngc_ic')).toBe('IC 434')
    expect(primaryName(['Mel 22', 'M 45', 'Pleiades'], 'ngc_ic')).toBe('M 45')
    expect(primaryName(['ι Ori', 'Hatysa'], 'popular')).toBe('Hatysa')
    expect(primaryName(['Mintaka'], 'popular')).toBe('Mintaka')
  })
  it('rejects an empty list', () => {
    expect(() => primaryName([], 'popular')).toThrow()
  })
})

describe('aliasNames', () => {
  const orion = ['NGC 1976', 'M 42', 'LBN 974', 'Great Orion Nebula', 'Orion Nebula']
  it('puts common names first, drops nested ones, then designations in ranking order, capped', () => {
    expect(aliasNames(orion, 'popular', 2)).toEqual(['Great Orion Nebula', 'NGC 1976'])
    expect(aliasNames(orion, 'popular', 5)).toEqual(['Great Orion Nebula', 'NGC 1976', 'LBN 974'])
    expect(aliasNames(orion, 'ngc_ic', 2)).toEqual(['Great Orion Nebula', 'M 42'])
    expect(aliasNames(['Mel 22', 'M 45', 'Pleiades'], 'popular', 2)).toEqual(['Pleiades', 'Mel 22'])
  })
  it('drops star ids and unknown abbreviations only when a better alias exists', () => {
    expect(aliasNames(['ζ Ori', 'Alnitak', 'HD 37742', 'HIP 26727'], 'popular', 5)).toEqual(['ζ Ori'])
    expect(aliasNames(['HD 37742', 'HIP 26727'], 'popular', 5)).toEqual(['HIP 26727'])
    expect(aliasNames(['XYZ 12', 'ABC 3'], 'popular', 5)).toEqual(['ABC 3'])
  })
  it('caps at zero and keeps nova order within a category', () => {
    expect(aliasNames(orion, 'popular', 0)).toEqual([])
    expect(aliasNames(['NGC 1', 'Alpha', 'Beta', 'Gamma'], 'popular', 5)).toEqual(['Alpha', 'Beta', 'Gamma'])
  })
  it('nesting is case-insensitive and whole-string', () => {
    expect(aliasNames(['NGC 1', 'the Witch Head Nebula', 'WITCH HEAD NEBULA'], 'popular', 5)).toEqual([
      'the Witch Head Nebula',
    ])
    expect(aliasNames(['NGC 1', 'Eyes', 'Eyes Galaxy'], 'popular', 5)).toEqual(['Eyes Galaxy'])
  })
})

interface NamesVectors {
  max_aliases: number
  cases: {
    names: string[]
    categories: string[]
    popular: { primary: string; aliases: Record<string, string[]> }
    ngc_ic: { primary: string; aliases: Record<string, string[]> }
  }[]
}
const vectors = raw as unknown as NamesVectors

describe('names vectors', () => {
  it('loaded the contract the Python side generated', () => {
    expect(vectors.max_aliases).toBe(MAX_ALIASES)
    expect(vectors.cases.length).toBeGreaterThan(20)
  })
  it('reproduces every category, primary line and alias line at every cap', () => {
    for (const c of vectors.cases) {
      expect(c.names.map(nameCategory), c.names.join(' | ')).toEqual(c.categories)
      for (const preference of ['popular', 'ngc_ic'] as const) {
        expect(primaryName(c.names, preference), `${preference}: ${c.names.join(' | ')}`).toBe(c[preference].primary)
        for (let cap = 0; cap <= vectors.max_aliases; cap++) {
          expect(aliasNames(c.names, preference, cap), `${preference} cap ${cap}: ${c.names.join(' | ')}`).toEqual(
            c[preference].aliases[String(cap)],
          )
        }
      }
    }
  })
})
