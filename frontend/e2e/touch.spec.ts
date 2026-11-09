import { expect, test } from './fixtures'
import type { Page } from '@playwright/test'
import { ensureSetUpAndSignedIn, ensureSolvedImage, stageState, touchDriver } from './helpers'

// The editor under a finger (SPEC § 6.5, #57), at the size of an iPhone with touch input. Two
// fingers zoom and pan the photo, one finger pans it, and the page itself never zooms or
// scrolls. Chromium only: drags and pinches are dispatched through the DevTools protocol. What
// this cannot show is iOS Safari itself (its focus zoom, its own page pinch); the spec pins the
// causes instead: the page's visual viewport stays at scale 1 under a pinch.
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })

type Box = { x: number; y: number; width: number; height: number }

/** Opens the Orion image's editor and returns the canvas's box on the page. */
async function openEditor(page: Page): Promise<Box> {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page)
  await card.getByRole('link', { name: 'Edit' }).click()
  await page.waitForFunction(() => window.__astrocaptionEditor?.labelPositions !== undefined)
  const box = await page.locator('.editor-canvas').boundingBox()
  expect(box, 'no editor canvas').toBeTruthy()
  await expect(page.locator('.save-status')).toHaveText('Saved')
  return box!
}

/** A page point over bare canvas: beside the image, where no marker or label can be, and far
 *  enough from the canvas edge that a short drag from it stays inside. */
async function emptyPoint(page: Page, box: Box): Promise<{ x: number; y: number }> {
  const s = await stageState(page)
  const midX = s.x + (s.imageWidth * s.scale) / 2
  const midY = s.y + (s.imageHeight * s.scale) / 2
  const candidates = [
    { x: midX, y: s.y + s.imageHeight * s.scale + 70 },
    { x: midX, y: s.y - 70 },
    { x: s.x + s.imageWidth * s.scale + 70, y: midY },
    { x: s.x - 70, y: midY },
  ]
  const pick = candidates.find((p) => p.x > 60 && p.y > 60 && p.x < box.width - 60 && p.y < box.height - 60)
  expect(pick, 'the view leaves no empty canvas beside the image').toBeTruthy()
  return { x: box.x + pick!.x, y: box.y + pick!.y }
}

const pageZoom = (page: Page) =>
  page.evaluate(() => ({ scale: window.visualViewport!.scale, scrollX: window.scrollX, scrollY: window.scrollY }))
const UNZOOMED = { scale: 1, scrollX: 0, scrollY: 0 }

test('touch: pinch and pan move the photo, never the page', async ({ page }) => {
  const box = await openEditor(page)
  const touch = await touchDriver(page)
  const saveStatus = page.locator('.save-status')
  const percent = page.locator('.editor-toolbar .meta').first()

  // 1. Two fingers spreading on the canvas: the photo zooms about the point between them. Bare
  //    canvas, so that no finger rests on a label (the label test covers that).
  const start = await emptyPoint(page, box)
  const centre = { x: start.x - box.x, y: start.y - box.y }
  const before = await stageState(page)
  const percentBefore = await percent.textContent()
  const under = { x: (centre.x - before.x) / before.scale, y: (centre.y - before.y) / before.scale }
  await touch.pinch({ x: box.x + centre.x, y: box.y + centre.y }, 80, 160)
  const zoomed = await stageState(page)
  expect(zoomed.scale / before.scale).toBeCloseTo(2, 1)
  expect(under.x * zoomed.scale + zoomed.x).toBeCloseTo(centre.x, 0)
  expect(under.y * zoomed.scale + zoomed.y).toBeCloseTo(centre.y, 0)
  await expect(percent).not.toHaveText(percentBefore!)
  expect(await pageZoom(page)).toEqual(UNZOOMED)

  // 2. The same on the top bar does nothing at all: not the photo, not the page.
  const bar = (await page.locator('.editor-toolbar').boundingBox())!
  await touch.pinch({ x: bar.x + bar.width / 2, y: bar.y + bar.height / 2 }, 80, 160)
  const afterBar = await stageState(page)
  expect([afterBar.x, afterBar.y, afterBar.scale]).toEqual([zoomed.x, zoomed.y, zoomed.scale])
  expect(await pageZoom(page)).toEqual(UNZOOMED)

  // 3. One finger on bare canvas pans. The first 10 px are slack (a tap may wander that far),
  //    and the photo then follows the finger from where the slack ran out, without a jump.
  //    Fit first: at twice the fitted size the photo fills the canvas and leaves no bare canvas.
  const fit = page.getByRole('button', { name: 'Fit' })
  await fit.tap()
  const empty = await emptyPoint(page, box)
  const panFrom = await stageState(page)
  await touch.start([empty])
  await touch.move([{ x: empty.x - 15, y: empty.y }])
  await touch.move([{ x: empty.x - 45, y: empty.y - 20 }])
  await touch.end()
  const panned = await stageState(page)
  expect(panned.x - panFrom.x).toBeCloseTo(-30, 0)
  expect(panned.y - panFrom.y).toBeCloseTo(-20, 0)
  expect(panned.scale).toBe(panFrom.scale)
  await expect(saveStatus).toHaveText('Saved')

  // 4. Fingers lifting one at a time after a pinch: the one still down neither pans nor taps.
  //    On bare canvas here; a finger that rests on a label is the label test's business.
  await fit.tap()
  const bare = await emptyPoint(page, box)
  const fitted = await stageState(page)
  const a = { x: bare.x - 40, y: bare.y, id: 0 }
  const b = { x: bare.x + 40, y: bare.y, id: 1 }
  await touch.start([a, b])
  await touch.move([
    { ...a, x: a.x - 20 },
    { ...b, x: b.x + 20 },
  ])
  const afterSpread = await stageState(page)
  expect(afterSpread.scale).toBeGreaterThan(fitted.scale)
  await touch.end([{ ...a, x: a.x - 20 }])
  await touch.move([{ ...a, x: a.x + 20, y: a.y + 40 }])
  await touch.end()
  const afterLift = await stageState(page)
  expect([afterLift.x, afterLift.y, afterLift.scale]).toEqual([afterSpread.x, afterSpread.y, afterSpread.scale])
  expect(await page.evaluate(() => window.__astrocaptionEditor!.selectedIds())).toEqual([])

  // 5. The browser takes a gesture away mid-pan (an incoming call): the next one starts clean.
  await fit.tap()
  const again = await emptyPoint(page, box)
  await touch.start([again])
  await touch.move([{ x: again.x + 30, y: again.y }])
  await touch.cancel()
  const atCancel = await stageState(page)
  await touch.start([again])
  await touch.move([{ x: again.x + 15, y: again.y }])
  await touch.move([{ x: again.x + 35, y: again.y + 10 }])
  await touch.end()
  const afterCancel = await stageState(page)
  expect(afterCancel.x - atCancel.x).toBeCloseTo(20, 0)
  expect(afterCancel.y - atCancel.y).toBeCloseTo(10, 0)
  await expect(saveStatus).toHaveText('Saved')
  expect(await pageZoom(page)).toEqual(UNZOOMED)
})
