import type { NamePreference, StyleConfig, StyleOverrides } from '../api'
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from '../editor/metrics'
import { MAX_ALIASES } from '../editor/names'

export type Tri = '' | 'on' | 'off'

/** Form state for a style. '' everywhere means "use the default" (overrides mode) or is never
 *  produced (values mode: `styleFormFromConfig` always fills every field). */
export interface StyleForm {
  font_file: string
  font_size: string
  text_color: string
  marker_color: string
  leader_color: string
  halo: Tri
  halo_color: string
  halo_width: string
  marker_width: string
  marker_min_radius: string
  show_aliases: Tri
  max_aliases: string
  name_preference: '' | NamePreference
}

export type NumberKey = 'font_size' | 'halo_width' | 'marker_width' | 'marker_min_radius' | 'max_aliases'
export type ColorKey = 'text_color' | 'marker_color' | 'leader_color' | 'halo_color'
export type TriKey = 'halo' | 'show_aliases'

/** The API's bounds (models.py), so the form never offers a value the server refuses. */
export const NUMBER_BOUNDS: Record<NumberKey, [number, number]> = {
  font_size: [MIN_FONT_SIZE, MAX_FONT_SIZE],
  halo_width: [0, 40],
  marker_width: [1, 40],
  marker_min_radius: [1, 400],
  max_aliases: [0, MAX_ALIASES],
}

/** An integer inside the field's bounds, or null while the text is not one. */
export function parseNumberField(key: NumberKey, raw: string): number | null {
  if (raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n)) return null
  const [lo, hi] = NUMBER_BOUNDS[key]
  return n >= lo && n <= hi ? n : null
}

const tri = (v: boolean | undefined): Tri => (v === undefined ? '' : v ? 'on' : 'off')
const str = (v: string | number | undefined): string => (v === undefined ? '' : String(v))

export function styleFormFromOverrides(o: StyleOverrides): StyleForm {
  return {
    font_file: str(o.font_file),
    font_size: str(o.font_size),
    text_color: str(o.text_color),
    marker_color: str(o.marker_color),
    leader_color: str(o.leader_color),
    halo: tri(o.halo),
    halo_color: str(o.halo_color),
    halo_width: str(o.halo_width),
    marker_width: str(o.marker_width),
    marker_min_radius: str(o.marker_min_radius),
    show_aliases: tri(o.show_aliases),
    max_aliases: str(o.max_aliases),
    name_preference: o.name_preference ?? '',
  }
}

/** A concrete style as the form holds it (the editor's Style tab). */
export function styleFormFromConfig(c: StyleConfig): StyleForm {
  return {
    font_file: c.font_file,
    font_size: str(c.font_size),
    text_color: c.text_color,
    marker_color: c.marker_color,
    leader_color: c.leader_color,
    halo: tri(c.halo),
    halo_color: c.halo_color,
    halo_width: str(c.halo_width),
    marker_width: str(c.marker_width),
    marker_min_radius: str(c.marker_min_radius),
    show_aliases: tri(c.show_aliases),
    name_preference: c.name_preference,
    max_aliases: str(c.max_aliases),
  }
}

/** Blank, or anything that is not a finite number, means "unset": the server keeps its default. */
const num = (v: string): number | undefined => {
  const n = Number(v)
  return v.trim() === '' || !Number.isFinite(n) ? undefined : n
}
const bool = (v: Tri): boolean | undefined => (v === '' ? undefined : v === 'on')
const text = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim())
const hex = (v: string): string | undefined => (v.trim() === '' ? undefined : normalizeHex(v))

/** Blank fields are dropped so the server keeps its size-relative defaults for them. */
export function overridesFromStyleForm(f: StyleForm): StyleOverrides {
  const o: StyleOverrides = {
    font_file: text(f.font_file),
    font_size: num(f.font_size),
    text_color: hex(f.text_color),
    marker_color: hex(f.marker_color),
    leader_color: hex(f.leader_color),
    halo: bool(f.halo),
    halo_color: hex(f.halo_color),
    halo_width: num(f.halo_width),
    marker_width: num(f.marker_width),
    marker_min_radius: num(f.marker_min_radius),
    show_aliases: bool(f.show_aliases),
    max_aliases: num(f.max_aliases),
    name_preference: f.name_preference === '' ? undefined : f.name_preference,
  }
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as StyleOverrides
}

/** The dropdown wording for each name preference (SPEC § 6.3). */
export const PREFERENCE_LABELS: Record<NamePreference, string> = {
  popular: 'Messier, Caldwell, Sharpless, Barnard first',
  ngc_ic: 'NGC and IC first',
}

/** The one value that differs from `p`: the only explicit choice the config page offers (#73). */
export function otherPreference(p: NamePreference): NamePreference {
  return p === 'popular' ? 'ngc_ic' : 'popular'
}

/** The six-digit form the server accepts: `#abc` becomes `#aabbcc`, a missing `#` is added, case is
 *  kept so a stored value round-trips unchanged; anything else is returned as typed for the server. */
export function normalizeHex(value: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (!m) return value
  const digits = m[1] ?? ''
  return `#${digits.length === 3 ? [...digits].map((c) => c + c).join('') : digits}`
}
