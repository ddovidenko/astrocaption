import type { NamePreference, StyleOverrides } from '../api'

export type Tri = '' | 'on' | 'off'

/** Form state for the default style. '' everywhere means "use the default". */
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
  name_preference: '' | NamePreference
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
    name_preference: o.name_preference ?? '',
  }
}

/** Blank, or anything that is not a finite number, means "unset": the server keeps its default. */
const num = (v: string): number | undefined => {
  const n = Number(v)
  return v.trim() === '' || !Number.isFinite(n) ? undefined : n
}
const bool = (v: Tri): boolean | undefined => (v === '' ? undefined : v === 'on')
const text = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim())

/** Blank fields are dropped so the server keeps its size-relative defaults for them. */
export function overridesFromStyleForm(f: StyleForm): StyleOverrides {
  const o: StyleOverrides = {
    font_file: text(f.font_file),
    font_size: num(f.font_size),
    text_color: text(f.text_color),
    marker_color: text(f.marker_color),
    leader_color: text(f.leader_color),
    halo: bool(f.halo),
    halo_color: text(f.halo_color),
    halo_width: num(f.halo_width),
    marker_width: num(f.marker_width),
    marker_min_radius: num(f.marker_min_radius),
    show_aliases: bool(f.show_aliases),
    name_preference: f.name_preference === '' ? undefined : f.name_preference,
  }
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as StyleOverrides
}

/** True when two override sets carry the same fields and values, whatever their key order.
 *  Values are primitives (string, number, boolean), so one level of comparison is enough. */
export function sameOverrides(a: StyleOverrides, b: StyleOverrides): boolean {
  const set = (o: StyleOverrides) => Object.entries(o).filter(([, v]) => v !== undefined)
  const ea = set(a)
  const eb = new Map(set(b))
  return ea.length === eb.size && ea.every(([k, v]) => eb.has(k) && eb.get(k) === v)
}
