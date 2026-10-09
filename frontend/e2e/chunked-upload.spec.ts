import { randomFillSync } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { expect, test } from './fixtures'
import { deleteImageIfPresent, ensureSetUpAndSignedIn, imagesTitled } from './helpers'

// #166: a file larger than one chunk (app.env sets the chunk to 1 MB) goes up as a session of
// PUTs and a finish, and ends in the same image row as a single-shot upload. The PNG is built
// here: incompressible pixels under a stored (level 0) deflate, so the size is what it says.
const WIDTH = 1200
const HEIGHT = 600
const TITLE = 'Chunked'

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

function noisePng(): Buffer {
  const row = WIDTH * 3 + 1 // filter byte, then RGB
  const raw = Buffer.alloc(row * HEIGHT)
  randomFillSync(raw)
  for (let y = 0; y < HEIGHT; y++) raw[y * row] = 0
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(WIDTH, 0)
  ihdr.writeUInt32BE(HEIGHT, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

test('a file larger than one chunk goes up in pieces and lands as one image', async ({ page }) => {
  await ensureSetUpAndSignedIn(page)
  await deleteImageIfPresent(page.request, TITLE, page)
  const png = noisePng()
  expect(png.length).toBeGreaterThan(2 * 1024 * 1024)

  const chunkPuts: string[] = []
  let finished = false
  page.on('request', (req) => {
    if (req.method() === 'PUT' && /\/api\/uploads\/[^/]+\/\d+$/.test(req.url())) chunkPuts.push(req.url())
    if (req.method() === 'POST' && req.url().endsWith('/finish')) finished = true
  })
  try {
    await page.locator('input[type=file]').setInputFiles({ name: 'noise.png', mimeType: 'image/png', buffer: png })
    await page.getByPlaceholder('Title (optional)').fill(TITLE)
    await page.getByRole('button', { name: 'Upload & solve' }).click()
    const card = page.locator('article.card', { hasText: TITLE })
    await expect(card).toBeVisible()
    expect(chunkPuts.length).toBeGreaterThanOrEqual(3)
    expect(new Set(chunkPuts).size).toBe(chunkPuts.length) // in order, each chunk once
    expect(finished).toBe(true)

    const [image] = await imagesTitled(page.request, TITLE)
    expect(image).toBeTruthy()
    expect([image!.width, image!.height]).toEqual([WIDTH, HEIGHT])
    const original = await page.request.get(image!.original_url)
    expect(original.status()).toBe(200)
    expect(original.headers()['content-type']).toBe('image/png')
    expect((await original.body()).equals(png)).toBe(true)
  } finally {
    await deleteImageIfPresent(page.request, TITLE)
  }
})
