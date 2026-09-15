import { api } from '../api'
import { DEFAULT_FONT_FILE, loadFonts } from './fonts'
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
  // A stored font the server no longer bundles: GET already swapped in the default and named
  // the stored one (#62); if the list and the style still disagree (#63), do the same here.
  const listed = (file: string) => fonts.some((f) => f.file === file)
  let annotations = raw
  let fontFallback: FontFallback | null = raw.font_fallback
    ? { stored: raw.font_fallback, used: raw.style.font_file }
    : null
  if (!listed(annotations.style.font_file)) {
    if (!listed(DEFAULT_FONT_FILE)) {
      throw new Error(
        `Font ${annotations.style.font_file} is not listed by the server.` +
          ' Open Config and save the label style to pick a bundled font.',
      )
    }
    fontFallback = { stored: annotations.style.font_file, used: DEFAULT_FONT_FILE }
    annotations = { ...annotations, style: { ...annotations.style, font_file: DEFAULT_FONT_FILE } }
  }
  await loadFonts([annotations.style.font_file])
  return { image, objects, annotations, fonts, fontFallback }
}
