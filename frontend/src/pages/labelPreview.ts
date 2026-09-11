import type { NamePreference, StyleDefaults } from '../api'
import type { StyleForm } from './configForm'

/** The preview draws at a fixed text size; every other length keeps its ratio to the font size. */
export const PREVIEW_SIZE = 22
/** Mirrors the export renderer (backend/app/render.py): alias line at 0.7 × size, lines 1.2 × size apart. */
export const ALIAS_SCALE = 0.7
export const LINE_HEIGHT = 1.2
/** StyleConfig.font_size: what an unset size means for the ratios below. */
export const ASSUMED_FONT_SIZE = 24

/** One object, two ways round: the primary line follows the name preference (SPEC § 6.3). */
const LINES: Record<NamePreference, { primary: string; aliases: string }> = {
  popular: { primary: 'M 42', aliases: 'NGC 1976 · Orion Nebula' },
  ngc_ic: { primary: 'NGC 1976', aliases: 'M 42 · Orion Nebula' },
}

export function previewLines(preference: '' | NamePreference, fallback: NamePreference) {
  return LINES[preference || fallback]
}

/** The CSS family name for a bundled font file: its stem, so browser and export name the same file. */
export function fontFamilyFor(file: string): string {
  return file.replace(/\.ttf$/i, '')
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
