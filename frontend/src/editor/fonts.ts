import { fontFamilyFor } from './metrics'

/** One load per file for the life of the page. Strict on purpose (#62): a font that cannot be
 *  loaded must surface as an error, because `measureText` on an unloaded family silently uses a
 *  fallback and the preview would no longer match the export. */
const loads = new Map<string, Promise<string>>()

export function loadBundledFont(file: string): Promise<string> {
  const pending = loads.get(file)
  if (pending) return pending
  const family = fontFamilyFor(file)
  const promise = (async () => {
    if (typeof FontFace === 'undefined') {
      throw new Error(
        'This browser cannot load the bundled fonts (no FontFace support); the editor needs a current browser.',
      )
    }
    const msg = `Font ${file} could not be loaded.`
    let face: FontFace
    try {
      // The family is taken verbatim (quoting it would register a name *containing* quotes, which
      // no `font:` shorthand can then match); only `src` is parsed as CSS, so only the URL is quoted.
      face = new FontFace(family, `url("/fonts/${encodeURIComponent(file)}")`)
    } catch (err) {
      // The user sees plain language; the cause stays available to whoever is debugging.
      console.error('font load failed', file, err)
      throw new Error(msg, { cause: err })
    }
    try {
      document.fonts.add(await face.load())
    } catch (err) {
      console.error('font load failed', file, err)
      throw new Error(msg, { cause: err })
    }
    return family
  })()
  loads.set(file, promise)
  promise.catch(() => loads.delete(file)) // a later attempt may succeed (the server came back)
  return promise
}

export async function loadFonts(files: Iterable<string>): Promise<void> {
  await Promise.all([...new Set(files)].map(loadBundledFont))
}
