import { api } from '../api'
import { getMeasurer } from './editing'
import { loadFonts } from './fonts'
import { MEASUREMENT_TOLERANCE, measurementDrift } from './metrics'
import type { FontFallback, LoadedDocument } from './store'

/** Everything the editor needs before its first draw (design § 3 "Data on load"). Any failure
 *  rejects with a plain message and the page shows it instead of a canvas. */
export async function loadEditor(id: string): Promise<LoadedDocument> {
  const [image, objects, raw, fonts] = await Promise.all([
    api.image(id),
    api.objects(id),
    api.annotations(id),
    api.fonts(),
  ])
  // A stored font the server no longer bundles was already swapped for the default by GET
  // (#62), which names the stored one in `font_fallback`; GET and /fonts share one predicate
  // (#63), so a served font missing from the list means the bundle itself is broken.
  const annotations = raw
  if (!fonts.some((f) => f.file === annotations.style.font_file)) {
    throw new Error(
      `Font ${annotations.style.font_file} is not listed by the server.` +
        ' Restore the bundled fonts and restart, then reload the editor.',
    )
  }
  const fontFallback: FontFallback | null = raw.font_fallback
    ? { stored: raw.font_fallback, used: raw.style.font_file }
    : null
  await loadFonts([annotations.style.font_file])
  // Rejecting from here lands in this page's error state; a throw during render would blank the
  // app via the root ErrorBoundary instead.
  assertMeasuresLikeExport(annotations.style.font_file)
  return { image, objects, annotations, fonts, fontFallback }
}

/** The #72 gate: throws, in plain language, when this browser's canvas widths for `file` drift
 *  from Pillow's by more than `MEASUREMENT_TOLERANCE`, since boxes and leaders placed from them
 *  would land elsewhere in the export. Behavioural rather than a feature sniff: Safari has no
 *  canvas `textRendering` yet measures within 0.25 px, while a hinted canvas drifts along a long
 *  string. Run once the font is loaded (an unloaded family measures a fallback face) and for
 *  every font the document comes to use: the one it opens with, and each one the Style tab
 *  switches to, since fonts carry their own hinting instructions. */
export function assertMeasuresLikeExport(file: string): void {
  const drift = measurementDrift(getMeasurer(), file)
  if (Number.isFinite(drift) && drift <= MEASUREMENT_TOLERANCE) return
  // NaN compares false against anything, so it is named rather than let through.
  const detail = Number.isFinite(drift) ? `widths off by up to ${drift.toFixed(2)} px` : 'text widths could not be measured'
  throw new Error(
    `This browser does not measure text the way the export does (${detail}); ` +
      'the editor needs a current browser such as Chrome, Edge, Firefox or Safari.',
  )
}
