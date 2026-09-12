import { api } from '../api'
import { loadFonts } from './fonts'
import type { LoadedDocument } from './store'

/** Everything the editor needs before its first draw (design § 3 "Data on load"). Any failure
 *  rejects with a plain message and the page shows it instead of a canvas. */
export async function loadEditor(id: string): Promise<LoadedDocument> {
  // Checked before the fetches, not just inside `canvasMeasurer`'s useMemo: that throw happens
  // during render, which bypasses this page's error state and blanks the whole app through the
  // root ErrorBoundary instead (Firefox lacks `textRendering`). The measurer keeps its own throw
  // as a backstop.
  if (!('textRendering' in CanvasRenderingContext2D.prototype)) {
    throw new Error(
      'This browser cannot measure text the way the export does (no canvas textRendering support); ' +
        'the editor needs a current browser such as Chrome, Edge or Safari.',
    )
  }
  const [image, objects, annotations, fonts] = await Promise.all([
    api.image(id),
    api.objects(id),
    api.annotations(id),
    api.fonts(),
  ])
  if (!fonts.some((f) => f.file === annotations.style.font_file)) {
    throw new Error(
      `Font ${annotations.style.font_file} is not listed by the server.` +
        ' Open Config and save the label style to pick a bundled font.',
    ) // #63
  }
  await loadFonts([annotations.style.font_file])
  return { image, objects, annotations, fonts }
}
