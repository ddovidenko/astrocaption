// The editor's failure sentences (SPEC § 6.3, #77), kept out of the Konva component so they are
// tested without a browser. Every sentence names a next step; none carries server paths or raw
// exception text.

export const CANVAS_SIZE_ERROR = 'The editor could not size its canvas. Reload the page, or widen the window.'

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

/** A leader drawn through another marker's ring because no endpoint on the label's facing sides
 *  cleared every ring (#119): the export matches, so the owner is told rather than warned. */
export function blockedLeaderNotice(count: number, firstName: string): string {
  const head = count === 1 ? `The leader for ${firstName} crosses another marker` : `${count} leaders cross other markers (first: ${firstName})`
  return `${head}; drag the label somewhere with a clear line to it.`
}

