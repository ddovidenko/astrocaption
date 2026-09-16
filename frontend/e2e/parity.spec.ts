import { expect, test } from './fixtures'
import type { Page, TestInfo } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AnnotationsUpdate, Label } from '../src/api'
import {
  ensureExported,
  ensureSetUpAndSignedIn,
  ensureSolvedImage,
  exportImage,
  fetchAnnotations,
  putAnnotations,
} from './helpers'

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
      // Keep in step with `fontFamilyFor` in src/editor/metrics.ts: this closure runs in the
      // browser, so the helper itself cannot be imported here.
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
      // A family nothing ever registered: whatever the browser falls back to for it is what an
      // unregistered bundled family would measure as too.
      ctx.font = '24px "__astrocaption_missing__"'
      const fallback = ctx.measureText(probe).width
      const unloaded = files.filter((file) => {
        ctx.font = `24px "${family(file)}"`
        return ctx.measureText(probe).width === fallback
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
    `these fonts measured exactly like the fallback font, so the family never registered: ${unloaded.join(', ')}`,
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

/** Renders the mounted stage at the preview's scale and diffs it against `previewUrl`; attaches
 *  the diff and the stage PNG when the budget is blown. The editor must be open with the hook
 *  published (`window.__astrocaptionEditor`), and `tag` names this diff in the log and in the
 *  attachment file names, so two documents in one run stay apart. */
async function expectStageMatchesPreview(
  page: Page,
  previewUrl: string,
  testInfo: TestInfo,
  tag: string,
): Promise<void> {
  const result = await page.evaluate(
    async ({ previewUrl, threshold, budget }) => {
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
      const pixelDelta = (i: number) =>
        Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!))
      // Count first: the diff and stage PNGs are only worth building (and shipping back across
      // the evaluate boundary) when the budget is actually blown.
      let differing = 0
      for (let i = 0; i < a.length; i += 4) {
        if (pixelDelta(i) > threshold) differing++
      }
      const fraction = differing / (w * h)
      let diffPng: string | null = null
      if (fraction > budget) {
        const diff = document.createElement('canvas')
        diff.width = w
        diff.height = h
        const g = diff.getContext('2d')!
        const out = g.createImageData(w, h)
        for (let i = 0; i < a.length; i += 4) {
          if (pixelDelta(i) > threshold) {
            out.data[i] = 255
            out.data[i + 3] = 255
          } else {
            out.data[i + 3] = 255
            out.data[i] = out.data[i + 1] = out.data[i + 2] = a[i]! >> 2
          }
        }
        g.putImageData(out, 0, 0)
        diffPng = diff.toDataURL('image/png')
      }
      return {
        w,
        h,
        scale,
        stageWidth: mine.naturalWidth,
        stageHeight: mine.naturalHeight,
        differing,
        fraction,
        diffPng,
        stagePng: fraction > budget ? stagePng : null,
      }
    },
    { previewUrl, threshold: PIXEL_THRESHOLD, budget: PIXEL_FRACTION },
  )
  console.log(
    `[parity ${tag}] pixels: preview ${result.w}x${result.h}, stage ${result.stageWidth}x${result.stageHeight} ` +
      `at scale ${result.scale.toFixed(6)}; ${result.differing} of ${result.w * result.h} differ by more than ` +
      `${PIXEL_THRESHOLD}/255 = ${(result.fraction * 100).toFixed(3)} % (budget ${PIXEL_FRACTION * 100} %)`,
  )
  if (result.fraction > PIXEL_FRACTION) {
    for (const [name, url] of [
      [`${tag}-diff.png`, result.diffPng!],
      [`${tag}-stage.png`, result.stagePng!],
    ] as const) {
      const path = testInfo.outputPath(name)
      writeFileSync(path, Buffer.from(url.split(',')[1]!, 'base64'))
      await testInfo.attach(name, { path, contentType: 'image/png' })
    }
  }
  expect(
    result.fraction,
    `${tag}: ${result.differing} of ${result.w * result.h} pixels differ by more than ${PIXEL_THRESHOLD}`,
  ).toBeLessThanOrEqual(PIXEL_FRACTION)
}

test('the editor stage matches the annotated preview within the pixel budget', async ({ page }, testInfo) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page)
  const previewUrl = await ensureExported(card)
  await card.getByRole('link', { name: 'Edit' }).click()
  await expect(page.locator('canvas').first()).toBeVisible()
  // The hook appears only once the preview bitmap has loaded, so this also waits for the drawn
  // stage rather than for an empty one.
  await page.waitForFunction(() => window.__astrocaptionEditor?.labelCount !== undefined)

  // Every enabled label must be on the stage: an empty or half-drawn canvas would otherwise
  // diff clean against a preview whose annotations happen to be faint.
  const imageId = /\/images\/([^/?#]+)/.exec(page.url())?.[1]
  expect(imageId, `no image id in ${page.url()}`).toBeTruthy()
  const annotations = await page.request.get(`/api/images/${imageId}/annotations`)
  expect(annotations.status()).toBe(200)
  const { labels } = (await annotations.json()) as { labels: { enabled: boolean }[] }
  const expected = labels.filter((l) => l.enabled).length
  const labelCount = await page.evaluate(() => window.__astrocaptionEditor!.labelCount)
  console.log(`[parity] labels: the canvas drew ${labelCount} of ${labels.length} stored labels`)
  expect(expected).toBeGreaterThan(0)
  expect(labelCount).toBe(expected)
  await expectStageMatchesPreview(page, previewUrl, testInfo, 'plain')
})

test('the stage matches the preview for a document with per-label overrides and a pinned label', async ({
  page,
}, testInfo) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page)
  await card.getByRole('link', { name: 'Edit' }).click()
  await page.waitForFunction(() => window.__astrocaptionEditor?.labelCount !== undefined)
  const imageId = /\/images\/([^/?#]+)/.exec(page.url())?.[1]
  expect(imageId, `no image id in ${page.url()}`).toBeTruthy()
  const original = await fetchAnnotations(page, imageId!)
  const enabled = original.labels.filter((l) => l.enabled)
  expect(enabled.length).toBeGreaterThanOrEqual(3)
  const [a, b, c] = enabled as [Label, Label, Label]
  // A size and colour override, a text override with the alias line forced on, a pinned label
  // with its leader forced on. (A stored font that is no longer bundled cannot be created
  // through the API — PUT refuses it with a 422 — and the app here runs on a scratch data dir
  // this spec cannot write to, so that half of the font fallback is pinned by pytest alone:
  // backend/tests/test_render.py and test_fonts.py.)
  const overridden: AnnotationsUpdate = {
    style: original.style,
    version: original.version,
    labels: original.labels.map((l) => {
      if (l.object_id === a.object_id) return { ...l, font_size: original.style.font_size * 2, color: '#ff8800' }
      if (l.object_id === b.object_id) return { ...l, text_override: 'Overridden name', show_aliases: true }
      if (l.object_id === c.object_id) return { ...l, pinned: true, leader: 'on' as const, x: l.x + 60, y: l.y + 40 }
      return l
    }),
  }
  const stored = await putAnnotations(page, imageId!, overridden)
  const previewUrl = await exportImage(page, imageId!)
  try {
    // Reload so the editor draws the stored document, then diff.
    await page.reload()
    await page.waitForFunction(() => window.__astrocaptionEditor?.labelCount !== undefined)
    await expectStageMatchesPreview(page, previewUrl, testInfo, 'overrides')
  } finally {
    // Put the shared fixture image back the way it was (and re-export it) so the other specs, and
    // a re-run on the same data dir, compare against a matching export. In a `finally`: a blown
    // budget (or any failure above) must not leave the shared document overridden behind it.
    await putAnnotations(page, imageId!, { style: original.style, labels: original.labels, version: stored.version })
    await exportImage(page, imageId!)
  }
})
