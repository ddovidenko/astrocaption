import { expect, test } from './fixtures'
import type { Page, TestInfo } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Annotations, AnnotationsUpdate, Label, ObjectOut, StyleConfig } from '../src/api'
import { leaderSegment, markerRadius, scaleUnit } from '../src/editor/metrics'
import { PAD_FACTOR } from '../src/editor/placement'
import {
  currentImageId,
  ensureExported,
  ensureSetUpAndSignedIn,
  ensureSolvedImage,
  exportImage,
  fetchAnnotations,
  fetchObjects,
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
  const imageId = currentImageId(page)
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

/** A position for label `c` whose nearest-point leader would run straight through another
 *  object's marker (#14): the box corner facing c's marker sits at twice the vector from c's marker
 *  to the blocker's, so the blocker's centre is the segment's midpoint. Only pairs for which the
 *  shared geometry (metrics.ts, pinned to render.py by the render vectors) finds a clear candidate
 *  qualify — a box thrown into the M 42 core has every candidate cut some ring and falls back to
 *  the nearest point on both renderers, proving nothing — and the widest box wins. The box has to
 *  stay inside the frame. Every enabled object's ring counts, as on the canvas, but only
 *  `candidates` are moved. Returns the box's top-left and that nearest corner. */
function behindAnotherMarker(
  candidates: Label[],
  enabled: Label[],
  objects: ObjectOut[],
  style: StyleConfig,
  boxes: { id: number; w: number; h: number }[],
  frame: { width: number; height: number },
): { label: Label; x: number; y: number; nearest: [number, number]; blocker: ObjectOut } {
  const byId = new Map(objects.map((o) => [o.id, o]))
  const sizes = new Map(boxes.map((b) => [b.id, b]))
  const pad = PAD_FACTOR * scaleUnit(frame.width, frame.height)
  let best: ReturnType<typeof behindAnotherMarker> | null = null
  for (const label of candidates) {
    const c = byId.get(label.object_id)
    const size = sizes.get(label.object_id)
    if (!c || !size) continue
    const rings = enabled
      .filter((l) => l.object_id !== c.id)
      .flatMap((l) => {
        const o = byId.get(l.object_id)
        return o ? [{ x: o.x, y: o.y, r: markerRadius(o, style) }] : []
      })
    for (const other of enabled) {
      const d = byId.get(other.object_id)
      if (!d || d.id === c.id) continue
      const dx = d.x - c.x
      const dy = d.y - c.y
      const dist = Math.hypot(dx, dy)
      if (dist < 100 || dist > 600) continue
      const nearest: [number, number] = [c.x + 2 * dx, c.y + 2 * dy]
      const x = dx > 0 ? nearest[0] : nearest[0] - size.w
      const y = dy > 0 ? nearest[1] : nearest[1] - size.h
      if (x < 0 || y < 0 || x + size.w > frame.width || y + size.h > frame.height) continue
      const box = { left: x, top: y, right: x + size.w, bottom: y + size.h }
      const seg = leaderSegment(c.x, c.y, markerRadius(c, style), box, rings, pad)
      if (!seg || Math.hypot(seg.to[0] - nearest[0], seg.to[1] - nearest[1]) <= 1) continue
      if (best && sizes.get(best.label.object_id)!.w >= size.w) continue
      best = { label, x, y, nearest, blocker: d }
    }
  }
  expect(best, 'no enabled label can be put behind another marker with a clear leader candidate').not.toBeNull()
  return best!
}

test('the stage matches the preview for a document with per-label overrides and a pinned label', async ({
  page,
}, testInfo) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page)
  await card.getByRole('link', { name: 'Edit' }).click()
  await page.waitForFunction(() => window.__astrocaptionEditor?.labelCount !== undefined)
  const imageId = currentImageId(page)
  const original = await fetchAnnotations(page, imageId)
  const objects = await fetchObjects(page, imageId)
  const enabled = original.labels.filter((l) => l.enabled)
  expect(enabled.length).toBeGreaterThanOrEqual(3)
  const [a, b] = enabled as [Label, Label]
  const drawn = await page.evaluate(() => {
    const hook = window.__astrocaptionEditor!
    return { boxes: hook.labelPositions(), frame: { width: hook.imageWidth, height: hook.imageHeight } }
  })
  const moved = behindAnotherMarker(
    enabled.filter((l) => l !== a && l !== b),
    enabled,
    objects,
    original.style,
    drawn.boxes,
    drawn.frame,
  )
  const c = moved.label
  // A size and colour override, a text override with the alias line forced on, a pinned label
  // with its leader forced on and moved behind another marker, so the leader has to route
  // around that marker's ring (#14). (A stored font that is no longer bundled cannot be created
  // through the API — PUT refuses it with a 422 — and the app here runs on a scratch data dir
  // this spec cannot write to, so that half of the font fallback is pinned by pytest alone:
  // backend/tests/test_render.py and test_fonts.py.)
  const overridden: AnnotationsUpdate = {
    style: original.style,
    version: original.version,
    labels: original.labels.map((l) => {
      if (l.object_id === a.object_id) return { ...l, font_size: original.style.font_size * 2, color: '#ff8800' }
      if (l.object_id === b.object_id) return { ...l, text_override: 'Overridden name', show_aliases: true }
      if (l.object_id === c.object_id) return { ...l, pinned: true, leader: 'on' as const, x: moved.x, y: moved.y }
      return l
    }),
  }
  // Everything that can leave the shared document overridden happens inside the try — the PUT
  // itself included — so the restore below always runs, whatever fails.
  let stored: Annotations | null = null
  let failed: unknown = null
  try {
    stored = await putAnnotations(page, imageId, overridden)
    // The overrides have to be in the document the server renders from, or the diff below would
    // be comparing two plain documents and would pass without testing anything.
    const byId = new Map(stored.labels.map((l) => [l.object_id, l]))
    expect(byId.get(a.object_id)).toMatchObject({ font_size: original.style.font_size * 2, color: '#ff8800' })
    expect(byId.get(b.object_id)).toMatchObject({ text_override: 'Overridden name', show_aliases: true })
    expect(byId.get(c.object_id)).toMatchObject({ pinned: true, leader: 'on', x: moved.x, y: moved.y })
    const previewUrl = await exportImage(page, imageId)
    // Reload so the editor draws the stored document, then diff.
    await page.reload()
    await page.waitForFunction(() => window.__astrocaptionEditor?.labelCount !== undefined)
    // The pixel budget below is too loose to notice one thin line drawn to the wrong corner, so
    // the routed leader is checked outright: it must not end at the nearest point (the blocker's
    // marker sits on that segment) and it must be drawn (the leader is forced on).
    const leader = await page.evaluate(
      (id) => window.__astrocaptionEditor!.leaders().find((l) => l.id === id) ?? null,
      c.object_id,
    )
    expect(leader, `label ${c.object_id} has no leader on the stage`).not.toBeNull()
    const [tx, ty] = leader!.to
    expect(
      Math.hypot(tx - moved.nearest[0], ty - moved.nearest[1]),
      `the leader of label ${c.object_id} still ends at the nearest point, through ${moved.blocker.primary_name}'s ring`,
    ).toBeGreaterThan(1)
    console.log(
      `[parity overrides] leader of label ${c.object_id} routed around ${moved.blocker.primary_name}: ` +
        `nearest (${moved.nearest.map((v) => v.toFixed(1)).join(', ')}) → (${tx.toFixed(1)}, ${ty.toFixed(1)})`,
    )
    await expectStageMatchesPreview(page, previewUrl, testInfo, 'overrides')
  } catch (e) {
    failed = e
  }
  // Put the shared fixture image back the way it was (and re-export it) so the other specs, and a
  // re-run on the same data dir, compare against a matching export: a blown budget (or any
  // failure above) must not leave the shared document overridden behind it. Hence the catch above
  // rather than a plain throw — and hence this restore, not a `finally` (ESLint's
  // `no-unsafe-finally` forbids the rethrow one would need). A restore that fails on its own is
  // the real failure; one that fails after the body already threw is only logged, so the original
  // failure is what the report shows.
  try {
    await putAnnotations(page, imageId, {
      style: original.style,
      labels: original.labels,
      version: stored?.version ?? original.version,
    })
    await exportImage(page, imageId)
  } catch (e) {
    if (!failed) throw e
    console.error(`[parity] restore failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (failed) throw failed
})
