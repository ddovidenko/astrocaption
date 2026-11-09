import { expect, test } from './fixtures'
import type { Page } from '@playwright/test'
import {
  currentImageId,
  ensureSetUpAndSignedIn,
  ensureSolvedImage,
  fetchAnnotations,
  stageState,
  touchDriver,
  withAnnotationsRestored,
} from './helpers'

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

test('touch: a label moves only once it is selected', async ({ page }) => {
  const box = await openEditor(page)
  const imageId = currentImageId(page)
  const touch = await touchDriver(page)
  const saveStatus = page.locator('.save-status')
  const undo = page.getByRole('button', { name: 'Undo', exact: true })
  const toolbar = page.getByRole('toolbar', { name: 'Selected labels' })
  const selected = () => page.evaluate(() => window.__astrocaptionEditor!.selectedIds())
  const view = async () => {
    const s = await stageState(page)
    return [s.x, s.y, s.scale]
  }

  await withAnnotationsRestored(page, imageId, async () => {
    // A label with room around it. At the fitted size a label is a few pixels tall, so the view
    // is zoomed in about the label first, as an owner would; the wheel does it here because it
    // keeps the point under the cursor in place, which makes the label easy to find afterwards.
    const fitted = await stageState(page)
    const target = fitted.labels.find((l) => {
      const x = fitted.x + l.x * fitted.scale
      const y = fitted.y + l.y * fitted.scale
      return x > 90 && y > 90 && x < box.width - 150 && y < box.height - 150
    })
    expect(target, 'no label with room around it').toBeTruthy()
    const id = target!.id
    const corner = { x: box.x + fitted.x + target!.x * fitted.scale, y: box.y + fitted.y + target!.y * fitted.scale }
    await page.mouse.move(corner.x, corner.y)
    // As many notches as it takes: how far one wheel event zooms depends on the emulated device.
    for (let i = 0; i < 8 && (await stageState(page)).scale < fitted.scale * 5; i++) {
      await page.mouse.wheel(0, -400)
    }
    expect((await stageState(page)).scale).toBeGreaterThanOrEqual(fitted.scale * 5)
    const zoomed = await stageState(page)
    const scale = zoomed.scale
    /** A point inside the label's text box, wherever the label and the view are now. */
    const labelPoint = async () => {
      const s = await stageState(page)
      const l = s.labels.find((x) => x.id === id)!
      return {
        x: box.x + s.x + l.x * s.scale + Math.min(8, (l.w * s.scale) / 2),
        y: box.y + s.y + l.y * s.scale + Math.min(8, (l.h * s.scale) / 2),
      }
    }
    const drawn = async () => {
      const l = (await stageState(page)).labels.find((x) => x.id === id)!
      return [l.x, l.y]
    }
    const stored = async () => {
      const l = (await fetchAnnotations(page, imageId)).labels.find((x) => x.object_id === id)!
      return [l.x, l.y]
    }
    const home = await stored()
    expect(await drawn()).toEqual(home)
    await expect(undo).toBeDisabled()

    // 1. A drag that starts on an unselected label pans the photo and leaves the label alone.
    {
      const from = await labelPoint()
      const before = await stageState(page)
      await touch.start([from])
      await touch.move([{ x: from.x + 15, y: from.y + 10 }])
      await touch.move([{ x: from.x + 75, y: from.y + 50 }])
      await touch.end()
      const after = await stageState(page)
      expect(after.x - before.x).toBeCloseTo(60, 0)
      expect(after.y - before.y).toBeCloseTo(40, 0)
      expect(await drawn()).toEqual(home)
      expect(await selected()).toEqual([])
      await expect(undo).toBeDisabled()
      await expect(saveStatus).toHaveText('Saved')
      expect(await stored()).toEqual(home)
    }

    // 2. A tap selects it.
    {
      const at = await labelPoint()
      await page.touchscreen.tap(at.x, at.y)
      await expect.poll(selected).toEqual([id])
      await expect(toolbar).toBeVisible()
    }

    // 3. A finger that wobbles while tapping the selected label (more than the mouse's 3 px of
    //    slack, less than touch's 10) does not move it.
    {
      const at = await labelPoint()
      await touch.start([at])
      await touch.move([{ x: at.x + 6, y: at.y }])
      await touch.end()
      expect(await drawn()).toEqual(home)
      expect(await selected()).toEqual([id])
      await expect(undo).toBeDisabled()
    }

    // 4. Dragging the selected label moves it with the finger, as one undo entry; the photo
    //    stays where it is.
    {
      const at = await labelPoint()
      const before = await view()
      await touch.start([at])
      await touch.move([{ x: at.x + 15, y: at.y + 10 }])
      await touch.move([{ x: at.x + 50, y: at.y + 30 }])
      await touch.end()
      expect(await view()).toEqual(before)
      const moved = await drawn()
      expect(moved[0]! - home[0]!).toBeCloseTo(50 / scale, 0)
      expect(moved[1]! - home[1]!).toBeCloseTo(30 / scale, 0)
      await expect.poll(stored).toEqual(moved)
      await expect(undo).toBeEnabled()
      await undo.tap()
      await expect.poll(drawn).toEqual(home)
      await expect(undo).toBeDisabled()
      await expect.poll(stored).toEqual(home)
    }

    // 5. A second finger landing mid-drag: the label stays where it had got to (one undo entry)
    //    and the two fingers zoom the photo. Neither finger drags anything after that.
    {
      await expect.poll(selected).toEqual([id])
      const at = await labelPoint()
      const first = { x: at.x + 40, y: at.y, id: 0 }
      const second = { x: at.x + 40, y: at.y + 120, id: 1 }
      await touch.start([{ ...at, id: 0 }])
      await touch.move([{ x: at.x + 20, y: at.y, id: 0 }])
      await touch.move([first])
      await touch.start([first, second])
      await touch.move([{ ...first, y: first.y - 30 }, { ...second, y: second.y + 30 }])
      await touch.end([{ ...first, y: first.y - 30 }])
      await touch.move([{ ...first, x: first.x + 40, y: first.y + 10 }])
      await touch.end()
      const after = await stageState(page)
      expect(after.scale).toBeGreaterThan(scale)
      const moved = await drawn()
      expect(moved[0]! - home[0]!).toBeCloseTo(40 / scale, 0)
      expect(moved[1]!).toBeCloseTo(home[1]!, 0)
      await expect(undo).toBeEnabled()
      await undo.tap()
      await expect.poll(drawn).toEqual(home)
      await expect(undo).toBeDisabled()
    }

    // 6. Two fingers landing together, one of them on the selected label: a pinch, never a drag,
    //    even when the other finger lifts first.
    {
      await expect.poll(selected).toEqual([id])
      const at = await labelPoint()
      const onLabel = { ...at, id: 0 }
      const other = { x: at.x, y: at.y + 120, id: 1 }
      const before = await stageState(page)
      await touch.start([onLabel, other])
      await touch.move([{ ...onLabel, y: onLabel.y - 20 }, { ...other, y: other.y + 20 }])
      await touch.end([{ ...onLabel, y: onLabel.y - 20 }])
      await touch.move([{ ...onLabel, x: onLabel.x + 40, y: onLabel.y + 20 }])
      await touch.end()
      expect((await stageState(page)).scale).toBeGreaterThan(before.scale)
      expect(await drawn()).toEqual(home)
      await expect(undo).toBeDisabled()
    }

    // 7. Touching the photo ends an edit in progress: a size typed in the toolbar, with no Enter,
    //    is kept when the next touch lands on the canvas.
    {
      await expect.poll(selected).toEqual([id])
      const size = toolbar.getByRole('spinbutton', { name: 'Font size' })
      await size.tap()
      await size.fill('41')
      await page.touchscreen.tap(box.x + 20, box.y + box.height - 20)
      await expect
        .poll(async () => (await fetchAnnotations(page, imageId)).labels.find((x) => x.object_id === id)!.font_size)
        .toBe(41)
    }

    // 8. A tap on bare canvas clears the selection.
    {
      const at = await labelPoint()
      await page.touchscreen.tap(at.x, at.y)
      await expect.poll(selected).toEqual([id])
      await page.getByRole('button', { name: 'Fit' }).tap()
      const bare = await emptyPoint(page, box)
      await page.touchscreen.tap(bare.x, bare.y)
      await expect.poll(selected).toEqual([])
    }
  })
})
