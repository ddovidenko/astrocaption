import { api } from '../api'
import { loadFonts } from './fonts'
import type { LoadedDocument } from './store'

/** Everything the editor needs before its first draw (design § 3 "Data on load"). Any failure
 *  rejects with a plain message and the page shows it instead of a canvas. */
export async function loadEditor(id: string): Promise<LoadedDocument> {
  const [image, objects, annotations, fonts] = await Promise.all([
    api.image(id),
    api.objects(id),
    api.annotations(id),
    api.fonts(),
  ])
  if (!fonts.some((f) => f.file === annotations.style.font_file)) {
    throw new Error(`Font ${annotations.style.font_file} is not listed by the server.`) // #63
  }
  await loadFonts([annotations.style.font_file])
  return { image, objects, annotations, fonts }
}
