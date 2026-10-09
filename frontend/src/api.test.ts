import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  arcsecPerPixel,
  errorMessage,
  formatBytes,
  hasLayout,
  isBusy,
  isSessionLossError,
  pageError,
  parseBody,
  setUnauthorizedHandler,
  statusLabel,
  type ImageOut,
  UPLOAD_TIMEOUT_MS,
  uploadChunked,
  uploadForm,
  api,
} from './api'

/** Enough of XMLHttpRequest for uploadForm: records the request, lets a test drive the events. */
class FakeXHR {
  static last: FakeXHR | null = null
  static all: FakeXHR[] = []
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
    FakeXHR.all.push(this)
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  aborted = false
  send(body: unknown) {
    this.body = body
  }
  abort() {
    this.aborted = true
    this.onabort?.()
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

  it('has a layout once a solve stored one and no solve is running (#173)', () => {
    expect(hasLayout({ solve_status: 'solved', annotations_hash: 'h' })).toBe(true)
    expect(hasLayout({ solve_status: 'failed', annotations_hash: 'h' })).toBe(true) // kept by a failed re-solve
    expect(hasLayout({ solve_status: 'failed', annotations_hash: null })).toBe(false) // never solved
    expect(hasLayout({ solve_status: 'pending', annotations_hash: 'h' })).toBe(false)
    expect(hasLayout({ solve_status: 'solving', annotations_hash: 'h' })).toBe(false)
  })

  it('formats byte counts', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(20480)).toBe('20 KB')
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB')
  })

  it('extracts FastAPI error details', () => {
    expect(errorMessage(409, { detail: 'A solve is already in progress.' })).toBe('A solve is already in progress.')
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

  it('aborts the request when the signal fires and rejects as cancelled (#80)', async () => {
    const controller = new AbortController()
    const p = uploadForm('/api/images', new FormData(), undefined, XHR, controller.signal)
    const xhr = FakeXHR.last!
    controller.abort()
    expect(xhr.aborted).toBe(true)
    await expect(p).rejects.toMatchObject({ message: 'The upload was cancelled.' })
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

describe('uploadChunked (#166)', () => {
  const CHUNK = 1024
  const file = new File([new Uint8Array(2500)], 'wide.png', { type: 'image/png' })
  const image = { id: 'img-9', title: 'Wide' } as unknown as ImageOut
  const calls: Array<{ url: string; method: string; body: unknown }> = []

  /** A fetch that opens the session with 1 KB chunks and answers finish with the image. */
  function stubFetch(finishStatus = 201) {
    calls.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : null })
        if (url === '/api/uploads') {
          return new Response(JSON.stringify({ id: 's1', chunk_bytes: CHUNK, chunks: 3 }), { status: 201 })
        }
        if (url.endsWith('/finish')) {
          return new Response(JSON.stringify(finishStatus === 201 ? image : { detail: 'Not a usable image: nope' }), {
            status: finishStatus,
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
  }
  const chunkRequest = async (n: number, attempt = 1) => {
    const url = `/api/uploads/s1/${n}`
    await vi.waitFor(() => expect(FakeXHR.all.filter((x) => x.url === url)).toHaveLength(attempt))
    return FakeXHR.all.filter((x) => x.url === url)[attempt - 1]!
  }
  afterEach(() => {
    vi.unstubAllGlobals()
    FakeXHR.all = []
  })

  it('sends the file in order, one bar across the chunks, then finishes', async () => {
    stubFetch()
    const seen: Array<[number, number]> = []
    const p = uploadChunked(file, '  Wide ', (s, t) => seen.push([s, t]), undefined, XHR)
    const first = await chunkRequest(0)
    expect(first.method).toBe('PUT')
    expect((first.body as Blob).size).toBe(CHUNK)
    first.upload.onprogress!({ lengthComputable: true, loaded: 512, total: CHUNK })
    first.respond(204, '')
    const second = await chunkRequest(1)
    second.upload.onprogress!({ lengthComputable: true, loaded: 100, total: CHUNK })
    second.respond(204, '')
    const third = await chunkRequest(2)
    expect((third.body as Blob).size).toBe(2500 - 2 * CHUNK)
    third.respond(204, '')
    await expect(p).resolves.toEqual(image)
    expect(seen).toEqual([
      [512, 2500],
      [CHUNK + 100, 2500],
      [2500, 2500],
    ])
    expect(calls[0]).toEqual({ url: '/api/uploads', method: 'POST', body: { name: 'wide.png', size: 2500, title: 'Wide' } })
    expect(calls[1]).toMatchObject({ url: '/api/uploads/s1/finish', method: 'POST' })
  })

  it('sends a dropped chunk again, up to three times, and gives up on a refusal', async () => {
    stubFetch()
    const p = uploadChunked(file, '', undefined, undefined, XHR)
    ;(await chunkRequest(0)).onerror!()
    ;(await chunkRequest(0, 2)).ontimeout!()
    ;(await chunkRequest(0, 3)).respond(503, '')
    await expect(p).rejects.toMatchObject({ status: 503 })
    expect(FakeXHR.all).toHaveLength(3)

    FakeXHR.all = []
    const q = uploadChunked(file, '', undefined, undefined, XHR)
    ;(await chunkRequest(0)).respond(413, JSON.stringify({ detail: 'The upload sent a larger chunk than it declared; start it again.' }))
    await expect(q).rejects.toMatchObject({ status: 413, message: /larger chunk/ })
    expect(FakeXHR.all).toHaveLength(1)
  })

  it('cancel aborts the chunk in flight and drops the session', async () => {
    stubFetch()
    const controller = new AbortController()
    const p = uploadChunked(file, '', undefined, controller.signal, XHR)
    ;(await chunkRequest(0)).respond(204, '')
    const second = await chunkRequest(1)
    controller.abort()
    expect(second.aborted).toBe(true)
    await expect(p).rejects.toMatchObject({ message: 'The upload was cancelled.' })
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/uploads/s1')).toBe(true))
    expect(calls.some((c) => c.url.endsWith('/finish'))).toBe(false)
  })

  it('a cancel between two chunks stops the next one from going out', async () => {
    stubFetch()
    const controller = new AbortController()
    const p = uploadChunked(file, '', undefined, controller.signal, XHR)
    const first = await chunkRequest(0)
    first.respond(204, '')
    controller.abort()
    await expect(p).rejects.toMatchObject({ message: 'The upload was cancelled.' })
    expect(FakeXHR.all.map((x) => x.url)).toEqual(['/api/uploads/s1/0'])
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true))
    expect(calls.some((c) => c.url.endsWith('/finish'))).toBe(false)
  })

  it('surfaces the finish refusal as the server wrote it', async () => {
    stubFetch(415)
    const p = uploadChunked(file, '', undefined, undefined, XHR)
    for (let n = 0; n < 3; n++) (await chunkRequest(n)).respond(204, '')
    await expect(p).rejects.toMatchObject({ status: 415, message: 'Not a usable image: nope' })
  })

  it('api.upload takes the chunked path only for a file larger than one chunk', async () => {
    stubFetch()
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
    const small = new File([new Uint8Array(10)], 'small.jpg')
    void api.upload(small, '', undefined, undefined, 1)
    await vi.waitFor(() => expect(FakeXHR.last?.url).toBe('/api/images'))
    expect(calls).toHaveLength(0)
    const big = new File([new Uint8Array(1024 * 1024 + 1)], 'big.jpg')
    void api.upload(big, '', undefined, undefined, 1).catch(() => undefined)
    await vi.waitFor(() => expect(calls[0]?.url).toBe('/api/uploads'))
    // Without a known chunk size every file goes up in one request.
    void api.upload(big, '', undefined, undefined, null)
    await vi.waitFor(() => expect(FakeXHR.all.filter((x) => x.url === '/api/images')).toHaveLength(2))
  })
})
