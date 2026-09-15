// Catalogue-name classification, primary-name ranking and the alias line (SPEC § 6.2, design
// spec § B). Line-by-line port of backend/app/models.py (name_category, primary_name,
// alias_names): both renderers must build the same two lines from the same catalog_names, and
// tests/fixtures/names/vectors.json (make names-vectors) pins this module to the Python original.
// Faithful for ASCII and Greek catalogue names; Python's `\d`, `\s` and IGNORECASE are Unicode-wider,
// which no name from nova or OpenNGC exercises.

import type { NamePreference } from '../api'

export type Category =
  | 'messier'
  | 'caldwell'
  | 'sharpless'
  | 'barnard'
  | 'ngc'
  | 'ic'
  | 'catalogue'
  | 'designation'
  | 'common'
  | 'bayer'
  | 'flamsteed'
  | 'star'

/** StyleConfig.max_aliases upper bound (models.MAX_ALIASES). */
export const MAX_ALIASES = 5

const STAR_CATALOGUES = new Set([
  'HD', 'HIP', 'SAO', 'TYC', 'HR', 'BD', 'CD', 'CPD', 'GSC', 'GAIA', 'UCAC', 'TIC', 'PPM', 'GJ', 'GL',
  'WDS', 'ADS', 'HIC',
])
const DSO_CATALOGUES = new Set([
  'CR', 'COLLINDER', 'MEL', 'MELOTTE', 'TR', 'TRUMPLER', 'STOCK', 'KING', 'BERKELEY', 'BE', 'RU',
  'RUPRECHT', 'LDN', 'LBN', 'VDB', 'CED', 'CEDERBLAD', 'RCW', 'GUM', 'ARP', 'HCG', 'HICKSON', 'MRK',
  'PK', 'PNG', 'MINKOWSKI', 'JONES', 'KOHOUTEK', 'UGC', 'PGC', 'ESO', 'MCG', 'DDO', 'HOLMBERG', 'SNR',
  'CTB', 'DWB', 'VV', 'AM', 'PAL', 'PALOMAR', 'TERZAN', 'PISMIS', 'WESTERLUND', 'BASEL', 'HAFFNER',
  'BOCHUM', 'CZERNIK', 'DOLIDZE', 'ROSLUND', 'HARVARD', 'ABELL',
])
// Python's re.fullmatch(..., IGNORECASE) is ^…$ with the i flag.
const NAME_PATTERNS: [Category, RegExp][] = [
  ['messier', /^(?:M|Messier)\s?\d+[a-z]?$/i],
  ['caldwell', /^(?:C|Caldwell)\s?\d+$/i],
  ['sharpless', /^(?:Sh\s?2|Sharpless)\s?-?\s?\d+[a-z]?$/i],
  ['barnard', /^(?:B|Barnard)\s?\d+[a-z]?$/i],
  ['ngc', /^NGC\s?\d+[a-z]?$/i],
  ['ic', /^IC\s?\d+[a-z]?$/i],
]
// Python's re.match anchors at the start only.
const DESIGNATION = /^([A-Za-z]+)\s?-?\s?[+-]?\d/
// "ι Ori", "θ1 Ori C", "c Ori": one Greek or Latin letter, optional index, constellation, component
const BAYER = /^[A-Za-zͰ-Ͽ]\d?\s[A-Z][A-Za-z]{2}(?:\s[A-Z])?$/
// "44 Ori", "41 Ori A"
const FLAMSTEED = /^\d{1,3}\s[A-Z][A-Za-z]{2}(?:\s[A-Z])?$/

const RANKING: Record<NamePreference, Category[]> = {
  popular: [
    'messier',
    'caldwell',
    'sharpless',
    'barnard',
    'ngc',
    'ic',
    'catalogue',
    'designation',
    'common',
    'bayer',
    'flamsteed',
    'star',
  ],
  ngc_ic: [
    'ngc',
    'ic',
    'messier',
    'caldwell',
    'sharpless',
    'barnard',
    'catalogue',
    'designation',
    'common',
    'bayer',
    'flamsteed',
    'star',
  ],
}

/** Classify a catalogue name (models.name_category). */
export function nameCategory(name: string): Category {
  const n = name.trim()
  for (const [category, pattern] of NAME_PATTERNS) if (pattern.test(n)) return category
  if (FLAMSTEED.test(n)) return 'flamsteed'
  if (BAYER.test(n)) return 'bayer'
  const m = DESIGNATION.exec(n)
  if (m) {
    const prefix = m[1]!.toUpperCase()
    if (STAR_CATALOGUES.has(prefix)) return 'star'
    if (DSO_CATALOGUES.has(prefix)) return 'catalogue'
    return 'designation'
  }
  return 'common'
}

/** Names with their nova index, sorted by `key` and then by index (Python's tuple sort). */
function ranked(names: string[], key: (name: string) => number): string[] {
  return names
    .map((name, index) => ({ name, index, rank: key(name) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((r) => r.name)
}

/** The label's primary line; ties keep nova's original order (models.primary_name). */
export function primaryName(names: string[], preference: NamePreference): string {
  if (names.length === 0) throw new Error('primaryName needs at least one catalogue name')
  const order = RANKING[preference]
  const [first] = ranked(names, (n) => order.indexOf(nameCategory(n)))
  if (first === undefined) throw new Error('primaryName needs at least one catalogue name')
  return first
}

/** The alias line, in order and capped (models.alias_names, design spec § B):
 *  1. the primary is dropped;
 *  2. star-catalogue ids and unknown abbreviations are dropped when a better alias exists;
 *  3. a common name contained in another common name of the same object is dropped;
 *  4. common names first in nova's order, then the rest in the primary ranking order;
 *  5. the first `maxAliases` survive. */
export function aliasNames(
  names: string[],
  preference: NamePreference,
  maxAliases: number,
): string[] {
  const primary = primaryName(names, preference)
  let rest = names.filter((n) => n !== primary)
  const category = new Map(rest.map((n) => [n, nameCategory(n)]))
  const weak = (n: string) => category.get(n) === 'star' || category.get(n) === 'designation'
  if (rest.some((n) => !weak(n))) rest = rest.filter((n) => !weak(n))
  const commons = rest.filter((n) => category.get(n) === 'common')
  const nested = (n: string) =>
    category.get(n) === 'common' &&
    commons.some((o) => o !== n && o.toLowerCase().includes(n.toLowerCase()))
  rest = rest.filter((n) => !nested(n))
  const order = RANKING[preference]
  const key = (n: string) => (category.get(n) === 'common' ? 0 : 1 + order.indexOf(category.get(n)!))
  return ranked(rest, key).slice(0, maxAliases)
}
