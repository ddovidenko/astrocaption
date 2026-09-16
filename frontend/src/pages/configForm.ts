import type { ConfigOut, ConfigUpdate, StyleOverrides } from '../api'
import { overridesFromStyleForm, type StyleForm } from '../style/styleForm'

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
