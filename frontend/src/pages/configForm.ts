import type { ConfigOut, ConfigUpdate, NamePreference, StyleOverrides } from '../api'

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

/** Everything the config page lets the owner edit, as the form holds it. */
export interface ConfigForm {
  siteTitle: string
  uploadMb: string
  novaKey: string
  style: StyleForm
}

/** The partial update for a save: only what changed, never a locked field, and
 *  default_style as the whole override set (the server replaces it) only when it differs.
 *  A blank upload limit means "unchanged"; removing the key is a separate action. */
export function buildUpdate(form: ConfigForm, config: ConfigOut): ConfigUpdate {
  const locked = (field: string) => config.locked.includes(field)
  const body: ConfigUpdate = {}
  // The saved font travels with the set even when the font list did not load: dropping it
  // would silently unset the owner's font. A font that is no longer bundled earns a 422.
  const next = overridesFromStyleForm(form.style)
  if (!sameOverrides(next, config.default_style)) body.default_style = next
  const title = form.siteTitle.trim()
  if (!locked('site_title') && title !== config.site_title) body.site_title = title
  const mb = form.uploadMb.trim()
  if (!locked('max_upload_mb') && mb !== '' && mb !== String(config.max_upload_mb)) {
    body.max_upload_mb = Number(mb)
  }
  if (!locked('nova_api_key') && form.novaKey.trim()) body.nova_api_key = form.novaKey.trim()
  return body
}

/** The six-digit form the server accepts: `#abc` becomes `#aabbcc`, a missing `#` is added, case is
 *  kept so a stored value round-trips unchanged; anything else is returned as typed for the server. */
export function normalizeHex(value: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (!m) return value
  const digits = m[1] ?? ''
  return `#${digits.length === 3 ? [...digits].map((c) => c + c).join('') : digits}`
}
