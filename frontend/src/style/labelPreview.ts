import type { NamePreference, StyleDefaults } from '../api'
import { MAX_ALIASES, aliasNames, primaryName } from '../editor/names'
import { ALIAS_SCALE, ALIAS_SEP, LINE_HEIGHT } from '../editor/metrics'
import type { StyleForm } from './styleForm'

/** The preview draws at a fixed text size; every other length keeps its ratio to the font size. */
export const PREVIEW_SIZE = 22
/** StyleConfig.font_size: what an unset size means for the ratios below. */
export const ASSUMED_FONT_SIZE = 24

/** One object, both ways round: M 42's real name list through the same ranking and alias
 *  policy the renderers use, so the sample tracks the rules (SPEC § 6.2). */
const SAMPLE = ['NGC 1976', 'M 42', 'LBN 974', 'Great Orion Nebula', 'Orion Nebula']

export function previewLines(preference: '' | NamePreference, fallback: NamePreference, maxAliases: number) {
  const p = preference || fallback
  return { primary: primaryName(SAMPLE, p), aliases: aliasNames(SAMPLE, p, maxAliases).join(ALIAS_SEP) }
}

/** Clamp the raw max-aliases field to what the API accepts: blank or unparseable falls back to
 *  `fallback`, everything else is truncated and clamped to 0..MAX_ALIASES. */
export function previewCap(raw: string, fallback: number): number {
  if (raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_ALIASES, Math.max(0, Math.trunc(n)))
}

export interface PreviewGeometry {
  haloWidth: number
  markerWidth: number
  aliasSize: number
  aliasOffset: number
}

/** Stroke widths for the strip. Pillow's stroke_width dilates outward by N; an SVG stroke is centred,
 *  so 2N painted under the fill (paint-order: stroke) gives the same outward N. */
export function previewGeometry(style: StyleForm, defaults: StyleDefaults): PreviewGeometry {
  const fontSize = Number(style.font_size) || ASSUMED_FONT_SIZE
  const scale = PREVIEW_SIZE / fontSize
  const px = (v: string, fallback: number) => Math.max(0.5, (Number(v) || fallback) * scale)
  const haloOn = style.halo === '' ? defaults.halo : style.halo === 'on'
  return {
    haloWidth: haloOn ? px(style.halo_width, 2) * 2 : 0,
    markerWidth: px(style.marker_width, 2),
    aliasSize: PREVIEW_SIZE * ALIAS_SCALE,
    aliasOffset: PREVIEW_SIZE * LINE_HEIGHT,
  }
}
