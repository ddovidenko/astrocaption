import { describe, expect, it } from 'vitest'
import {
  ApiError,
  arcsecPerPixel,
  errorMessage,
  formatBytes,
  isBusy,
  isSessionLossError,
  pageError,
  parseBody,
  setUnauthorizedHandler,
  statusLabel,
  UPLOAD_TIMEOUT_MS,
  uploadForm,
} from './api'

/** Enough of XMLHttpRequest for uploadForm: records the request, lets a test drive the events. */
class FakeXHR {
  static last: FakeXHR | null = null
  method = ''
  url = ''
  body: unknown = null
  status = 0
  responseText = ''
  timeout = 0
  upload = { onprogress: null as ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  constructor() {
    FakeXHR.last = this
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  send(body: unknown) {
    this.body = body
  }
  respond(status: number, text: string) {
    this.status = status
    this.responseText = text
    this.onload?.()
  }
}
const XHR = FakeXHR as unknown as typeof XMLHttpRequest

describe('api helpers', () => {
  it('labels every solve status', () => {
    expect(statusLabel('pending')).toBe('Queued')
    expect(statusLabel('solving')).toBe('Solving…')
    expect(statusLabel('solved')).toBe('Solved')
    expect(statusLabel('failed')).toBe('Failed')
  })

  it('treats queued and solving as busy', () => {
    expect(isBusy('pending')).toBe(true)
    expect(isBusy('solving')).toBe(true)
    expect(isBusy('solved')).toBe(false)
    expect(isBusy('failed')).toBe(false)
  })

  it('formats byte counts', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(20480)).toBe('20 KB')
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB')
  })

  it('extracts FastAPI error details', () => {
    expect(errorMessage(409, { detail: 'Image is not solved yet.' })).toBe('Image is not solved yet.')
    expect(errorMessage(500, null)).toBe('Request failed (HTTP 500)')
    // The backend's 422 handler always answers with a plain string; a list is not a shape
    // the API produces any more, so it falls through to the generic message.
    expect(errorMessage(422, { detail: [{ msg: 'bad', loc: ['body'] }] })).toBe('Request failed (HTTP 422)')
  })

  it('computes the plate scale hint', () => {
    expect(arcsecPerPixel(400, 3.76)).toBeCloseTo(1.939, 3)
    expect(arcsecPerPixel(0, 3.76)).toBeNull()
  })

  it('rejects a non-JSON success body instead of returning null', () => {
    expect(parseBody(200, true, '[{"id": "a"}]')).toEqual([{ id: 'a' }])
    expect(parseBody(200, true, '')).toBeNull()
    expect(() => parseBody(200, true, '<!doctype html><html></html>')).toThrow(ApiError)
    expect(() => parseBody(409, false, '{"detail": "busy"}')).toThrow('busy')
    expect(() => parseBody(502, false, '<html>bad gateway</html>')).toThrow('HTTP 502')
  })

  it('hides the page-level message only for a lost session', () => {
    expect(pageError(new ApiError(401, 'Sign in to continue.', true))).toBeNull()
    expect(pageError(new ApiError(401, 'Wrong password.'))).toBe('Wrong password.')
    expect(pageError(new Error('network down'))).toBe('network down')
    expect(pageError('?')).toBe('Something went wrong.')
  })

  it('identifies the ApiError a page should not show because the shell is redirecting', () => {
    // The flag is set once, by settle(); the status alone cannot tell a lost session from
    // the 401 that a wrong password on /api/login earns (that call opts out).
    expect(isSessionLossError(new ApiError(401, 'Sign in to continue.', true))).toBe(true)
    expect(isSessionLossError(new ApiError(401, 'Wrong password.'))).toBe(false)
    expect(isSessionLossError(new ApiError(403, 'Forbidden.'))).toBe(false)
    expect(isSessionLossError(new Error('network down'))).toBe(false)
  })

  it('carries the session-loss decision from parseBody into the thrown error', () => {
    expect(() => parseBody(401, false, '{"detail": "Sign in to continue."}', true)).toThrow(
      'Sign in to continue.',
    )
    try {
      parseBody(401, false, '{"detail": "Sign in to continue."}', true)
    } catch (err) {
      expect(isSessionLossError(err)).toBe(true)
    }
    try {
      parseBody(401, false, '{"detail": "Wrong password."}')
    } catch (err) {
      expect(isSessionLossError(err)).toBe(false)
    }
  })
})

describe('uploadForm', () => {
  it('posts the form, forwards progress and parses the body', async () => {
    const form = new FormData()
    const seen: Array<[number, number]> = []
    const p = uploadForm<{ id: string }>('/api/images', form, (s, t) => seen.push([s, t]), XHR)
    const xhr = FakeXHR.last!
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe('/api/images')
    expect(xhr.body).toBe(form)
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 5, total: 10 })
    xhr.upload.onprogress!({ lengthComputable: false, loaded: 0, total: 0 })
    xhr.respond(201, JSON.stringify({ id: 'img' }))
    await expect(p).resolves.toEqual({ id: 'img' })
    expect(seen).toEqual([[5, 10]])
  })

  it('turns an error status into an ApiError with the server sentence', async () => {
    const p = uploadForm('/api/images', new FormData(), undefined, XHR)
    FakeXHR.last!.respond(413, JSON.stringify({ detail: 'The file is larger than 60 MB.' }))
    await expect(p).rejects.toMatchObject({ status: 413, message: 'The file is larger than 60 MB.' })
  })

  it('reports a lost session on 401 like request() does', async () => {
    let called = 0
    setUnauthorizedHandler(() => {
      called++
    })
    try {
      const p = uploadForm('/api/images', new FormData(), undefined, XHR)
      FakeXHR.last!.respond(401, JSON.stringify({ detail: 'Not signed in.' }))
      await expect(p).rejects.toBeInstanceOf(ApiError)
      await expect(p).rejects.toMatchObject({ sessionLost: true })
      expect(called).toBe(1)
    } finally {
      // Whatever this test does, the next one must not inherit a handler that counts into it.
      setUnauthorizedHandler(null)
    }
  })

  it('replaces the generic sentence when a proxy answers 413 with its own HTML page', async () => {
    const p = uploadForm('/api/images', new FormData(), undefined, XHR)
    FakeXHR.last!.respond(413, '<html><body>413 Request Entity Too Large</body></html>')
    await expect(p).rejects.toMatchObject({
      status: 413,
      message: 'The file is larger than the upload limit; the server or a reverse proxy refused it.',
    })
  })

  it('keeps the API sentence when the API itself answered the 413', async () => {
    const p = uploadForm('/api/images', new FormData(), undefined, XHR)
    FakeXHR.last!.respond(413, JSON.stringify({ detail: 'File is larger than the 60 MB upload limit.' }))
    await expect(p).rejects.toMatchObject({ message: 'File is larger than the 60 MB upload limit.' })
  })

  it('explains a gateway timeout in plain language', async () => {
    const p = uploadForm('/api/images', new FormData(), undefined, XHR)
    FakeXHR.last!.respond(504, '<html>gateway timeout</html>')
    await expect(p).rejects.toThrow('The server did not answer the upload in time. Try again.')
  })

  it('gives up after the upload timeout rather than hanging forever', async () => {
    const p = uploadForm('/api/images', new FormData(), undefined, XHR)
    expect(FakeXHR.last!.timeout).toBe(UPLOAD_TIMEOUT_MS)
    FakeXHR.last!.ontimeout!()
    await expect(p).rejects.toThrow('The upload timed out. Check the connection and try again.')
  })

  it('fails in plain language when the connection drops or the body is refused', async () => {
    const p = uploadForm('/api/images', new FormData(), undefined, XHR)
    FakeXHR.last!.onerror!()
    await expect(p).rejects.toThrow(
      'The upload did not finish: the connection dropped, or the server refused the file before it was fully sent (check the size against the upload limit).',
    )
  })

  it('says so plainly when the upload is aborted', async () => {
    const p = uploadForm('/api/images', new FormData(), undefined, XHR)
    FakeXHR.last!.onabort!()
    await expect(p).rejects.toThrow('The upload was cancelled.')
  })
})
