import { api } from '../api'
import { loadFonts } from './fonts'
import type { FontFallback, LoadedDocument } from './store'

/** Everything the editor needs before its first draw (design § 3 "Data on load"). Any failure
 *  rejects with a plain message and the page shows it instead of a canvas. */
export async function loadEditor(id: string): Promise<LoadedDocument> {
  // Checked before the fetches, not just inside `getMeasurer()`: that throw happens
  // during render, which bypasses this page's error state and blanks the whole app through the
  // root ErrorBoundary instead (Firefox lacks `textRendering`). The measurer keeps its own throw
  // as a backstop.
  if (!('textRendering' in CanvasRenderingContext2D.prototype)) {
    throw new Error(
      'This browser cannot measure text the way the export does (no canvas textRendering support); ' +
        'the editor needs a current browser such as Chrome, Edge or Safari.',
    )
  }
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
  return { image, objects, annotations, fonts, fontFallback }
}
