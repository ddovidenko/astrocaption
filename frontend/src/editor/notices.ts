// The editor's failure sentences (SPEC § 6.3, #77), kept out of the Konva component so they are
// tested without a browser. Every sentence names a next step; none carries server paths or raw
// exception text.

import type { ApiError } from '../api'

export const CANVAS_SIZE_ERROR = 'The editor could not size its canvas. Reload the page, or widen the window.'

/** A save refused with one of the server's `labels:` sentences: the document no longer matches
 *  the server's objects (a re-solve landed between load and save). Shown in the conflict state
 *  — Reload, since a Retry can never succeed. */
export const STALE_DOCUMENT_MESSAGE = "This image's objects changed; reload the editor."

export function previewErrorSentence(status: number | null): string {
  if (status === 401) return 'Your session has expired. Log in again.'
  return 'The preview could not be loaded. Reload the page; if it keeps failing, re-upload the image.'
}

/** An `<img>` error carries no status, so the failing URL is asked once more with HEAD; null
 *  when even that fails (offline), which reads as the generic sentence. */
export async function probeStatus(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'same-origin' })
    return res.status
  } catch {
    return null
  }
}

export function drawErrorNotice(count: number, firstName: string, firstMessage: string): string {
  const head =
    count === 1
      ? `The label for ${firstName} could not be drawn`
      : `${count} labels could not be drawn (first: ${firstName})`
  return `${head}: ${firstMessage}. The export may differ from this preview.`
}

/** Whether a save's failure means the document no longer matches the server's objects. The
 *  server's three object-id sentences all start with `labels:` (see `images.py`, the constants
 *  above `_check_version`); its other 422s — a bad font file, a malformed body — are ordinary
 *  errors a Retry can still fix. */
export function isStaleDocumentError(err: ApiError): boolean {
  return err.status === 422 && err.message.startsWith('labels:')
}
