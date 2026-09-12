import { expect, test } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureExported, ensureSetUpAndSignedIn, ensureSolvedImage } from './helpers'

// Preview/export parity (SPEC § 9), the half that needs a browser: Konva and the canvas text
// metrics only exist there, so this cannot live in pytest next to test_render_parity.py.

const VECTORS = resolve(fileURLToPath(new URL('../..', import.meta.url)), 'tests', 'fixtures', 'render', 'vectors.json')
const WIDTH_TOLERANCE_PX = 0.5 // SPEC § 9
const PIXEL_THRESHOLD = 48 // per channel, of 255
const PIXEL_FRACTION = 0.01 // of all pixels
const PROBE = 'NGC 1981 Upper Sword'

interface Vectors {
  texts: [string, number, string, number][]
}

test('the canvas measures every vector string within 0.5 px of Pillow', async ({ page }) => {
  await ensureSetUpAndSignedIn(page)
  const { texts } = JSON.parse(readFileSync(VECTORS, 'utf8')) as Vectors
  const files = [...new Set(texts.map(([file]) => file))]
  const { unloaded, widths } = await page.evaluate(
    async ({ files, texts, probe }) => {
      const family = (file: string) => file.replace(/\.ttf$/i, '')
      for (const file of files) {
        // The family is taken verbatim, exactly as src/editor/fonts.ts does: quoting it here
        // would register a name *containing* quotes that no `font:` shorthand can match.
        const face = new FontFace(family(file), `url("/fonts/${encodeURIComponent(file)}")`)
        document.fonts.add(await face.load())
      }
      const ctx = document.createElement('canvas').getContext('2d')!
      ctx.textRendering = 'geometricPrecision'
      // A wrongly registered family falls back silently and `document.fonts.check()` cannot see
      // it (it returns true for a name nothing registered), so compare against the fallback.
      ctx.font = '24px serif'
      const serif = ctx.measureText(probe).width
      const unloaded = files.filter((file) => {
        ctx.font = `24px "${family(file)}"`
        return ctx.measureText(probe).width === serif
      })
      const widths = texts.map(([file, size, text]) => {
        ctx.font = `${size}px "${family(file)}"`
        return ctx.measureText(text).width
      })
      return { unloaded, widths }
    },
    { files, texts, probe: PROBE },
  )
  expect(
    unloaded,
    `these fonts measured exactly like the serif fallback, so the family never registered: ${unloaded.join(', ')}`,
  ).toEqual([])

  const deltas = texts.map(([file, size, text, pillow], i) => ({
    file,
    size,
    text,
    pillow,
    canvas: widths[i]!,
    delta: Math.abs(widths[i]! - pillow),
  }))
  const worst = deltas.reduce((a, b) => (b.delta > a.delta ? b : a))
  console.log(
    `[parity] widths: ${deltas.length} vectors, ${files.length} fonts, largest delta ${worst.delta.toFixed(4)} px ` +
      `(${worst.file} ${worst.size}px "${worst.text}": canvas ${worst.canvas}, pillow ${worst.pillow})`,
  )
  const bad = deltas.filter((t) => t.delta > WIDTH_TOLERANCE_PX)
  expect(bad, JSON.stringify(bad.slice(0, 10), null, 1)).toEqual([])
})

test('the editor stage matches the annotated preview within the pixel budget', async ({ page }, testInfo) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page)
  const previewUrl = await ensureExported(page, card)
  await card.getByRole('link', { name: 'Edit' }).click()
  await expect(page.locator('canvas').first()).toBeVisible()
  await page.waitForFunction(() => Boolean(window.__astrocaptionEditor))
  const result = await page.evaluate(
    async ({ previewUrl, threshold }) => {
      const hook = window.__astrocaptionEditor!
      const load = (src: string, what: string) =>
        new Promise<HTMLImageElement>((ok, err) => {
          const im = new Image()
          im.onload = () => ok(im)
          im.onerror = () => err(new Error(what))
          im.src = src
        })
      const server = await load(previewUrl, 'preview')
      const scale = server.naturalWidth / hook.imageWidth
      const stagePng = hook.renderAt(scale)
      const mine = await load(stagePng, 'stage')
      const w = server.naturalWidth
      const h = server.naturalHeight
      const draw = (im: HTMLImageElement) => {
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const g = c.getContext('2d')!
        g.drawImage(im, 0, 0, w, h)
        return g.getImageData(0, 0, w, h).data
      }
      const a = draw(server)
      const b = draw(mine)
      const diff = document.createElement('canvas')
      diff.width = w
      diff.height = h
      const g = diff.getContext('2d')!
      const out = g.createImageData(w, h)
      let differing = 0
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(
          Math.abs(a[i]! - b[i]!),
          Math.abs(a[i + 1]! - b[i + 1]!),
          Math.abs(a[i + 2]! - b[i + 2]!),
        )
        if (d > threshold) {
          differing++
          out.data[i] = 255
          out.data[i + 3] = 255
        } else {
          out.data[i + 3] = 255
          out.data[i] = out.data[i + 1] = out.data[i + 2] = a[i]! >> 2
        }
      }
      g.putImageData(out, 0, 0)
      return {
        w,
        h,
        scale,
        stageWidth: mine.naturalWidth,
        stageHeight: mine.naturalHeight,
        differing,
        fraction: differing / (w * h),
        diffPng: diff.toDataURL('image/png'),
        stagePng,
      }
    },
    { previewUrl, threshold: PIXEL_THRESHOLD },
  )
  console.log(
    `[parity] pixels: preview ${result.w}x${result.h}, stage ${result.stageWidth}x${result.stageHeight} ` +
      `at scale ${result.scale.toFixed(6)}; ${result.differing} of ${result.w * result.h} differ by more than ` +
      `${PIXEL_THRESHOLD}/255 = ${(result.fraction * 100).toFixed(3)} % (budget ${PIXEL_FRACTION * 100} %)`,
  )
  if (result.fraction > PIXEL_FRACTION) {
    for (const [name, url] of [
      ['diff.png', result.diffPng],
      ['stage.png', result.stagePng],
    ] as const) {
      const path = testInfo.outputPath(name)
      writeFileSync(path, Buffer.from(url.split(',')[1]!, 'base64'))
      await testInfo.attach(name, { path, contentType: 'image/png' })
    }
  }
  expect(
    result.fraction,
    `${result.differing} of ${result.w * result.h} pixels differ by more than ${PIXEL_THRESHOLD}`,
  ).toBeLessThanOrEqual(PIXEL_FRACTION)
})
