import { expect, test } from './fixtures'
import type { Page } from '@playwright/test'
import {
  currentImageId,
  ensureSetUpAndSignedIn,
  ensureSolvedImage,
  fetchAnnotations,
  fetchObjects,
  putAnnotations,
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

/** Zooms in about `point` (page pixels) until the stage scale is at least `minScale`. At the
 *  fitted size a phone shows a label a few pixels tall, so the specs zoom in first, as an owner
 *  would. The wheel does it because it keeps the point under the cursor exactly in place; as many
 *  notches as it takes, since how far one notch zooms depends on the emulated device. */
async function zoomAbout(page: Page, point: { x: number; y: number }, minScale: number): Promise<void> {
  await page.mouse.move(point.x, point.y)
  for (let i = 0; i < 8 && (await stageState(page)).scale < minScale; i++) {
    await page.mouse.wheel(0, -400)
  }
  expect((await stageState(page)).scale).toBeGreaterThanOrEqual(minScale)
  // Off the canvas again: a cursor left resting on an object would hover it.
  await page.mouse.move(0, 0)
}

/** A drawn label with room around it in the fitted view, and the page point of its corner. */
async function labelWithRoom(page: Page, box: Box) {
  const fitted = await stageState(page)
  const target = fitted.labels.find((l) => {
    const x = fitted.x + l.x * fitted.scale
    const y = fitted.y + l.y * fitted.scale
    return x > 90 && y > 90 && x < box.width - 150 && y < box.height - 150
  })
  expect(target, 'no label with room around it').toBeTruthy()
  const corner = { x: box.x + fitted.x + target!.x * fitted.scale, y: box.y + fitted.y + target!.y * fitted.scale }
  return { id: target!.id, corner, fittedScale: fitted.scale }
}

/** A point inside label `id`'s text box, wherever the label and the view are now. */
async function pointOnLabel(page: Page, box: Box, id: number): Promise<{ x: number; y: number }> {
  const s = await stageState(page)
  const l = s.labels.find((x) => x.id === id)!
  return {
    x: box.x + s.x + l.x * s.scale + Math.min(8, (l.w * s.scale) / 2),
    y: box.y + s.y + l.y * s.scale + Math.min(8, (l.h * s.scale) / 2),
  }
}

/** Somewhere off the canvas that is not a control, for a thumb to rest on: the image title in
 *  the top bar. Finger 0, so a finger that joins it on the canvas must carry another id. */
async function restingPoint(page: Page) {
  const title = (await page.locator('.editor-toolbar strong').boundingBox())!
  return { x: title.x + title.width / 2, y: title.y + title.height / 2, id: 0 }
}

const selectedIds = (page: Page) => page.evaluate(() => window.__astrocaptionEditor!.selectedIds())

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
  await touch.path([empty, { x: empty.x - 15, y: empty.y }, { x: empty.x - 45, y: empty.y - 20 }])
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
  //    The fingers land one after the other, as they do in a hand: the first one alone is the
  //    start of a pan, and must stop being one when the second arrives.
  const a = { x: bare.x - 40, y: bare.y, id: 0 }
  const b = { x: bare.x + 40, y: bare.y, id: 1 }
  await touch.start([a])
  await touch.start([a, b])
  await touch.move([
    { ...a, x: a.x - 20 },
    { ...b, x: b.x + 20 },
  ])
  const afterSpread = await stageState(page)
  expect(afterSpread.scale).toBeGreaterThan(fitted.scale)
  await touch.end([b])
  // Two moves: a pan only shows on the move after the one that used up its slack.
  await touch.move([{ ...a, x: a.x, y: a.y + 20 }])
  await touch.move([{ ...a, x: a.x + 20, y: a.y + 40 }])
  await touch.end()
  const afterLift = await stageState(page)
  expect([afterLift.x, afterLift.y, afterLift.scale]).toEqual([afterSpread.x, afterSpread.y, afterSpread.scale])
  expect(await selectedIds(page)).toEqual([])

  // 5. The browser takes a gesture away mid-pan (an incoming call): the next one starts clean.
  await fit.tap()
  const again = await emptyPoint(page, box)
  await touch.start([again])
  await touch.move([{ x: again.x + 30, y: again.y }])
  await touch.cancel()
  const atCancel = await stageState(page)
  await touch.path([again, { x: again.x + 15, y: again.y }, { x: again.x + 35, y: again.y + 10 }])
  const afterCancel = await stageState(page)
  expect(afterCancel.x - atCancel.x).toBeCloseTo(20, 0)
  expect(afterCancel.y - atCancel.y).toBeCloseTo(10, 0)
  await expect(saveStatus).toHaveText('Saved')
  expect(await pageZoom(page)).toEqual(UNZOOMED)

  // 6. A finger resting off the canvas (a thumb on the top bar, holding the device) is not part
  //    of a gesture on the photo: the one finger on the canvas still pans, and nothing zooms.
  const rest = await restingPoint(page)
  const on = { ...(await emptyPoint(page, box)), id: 1 }
  const restFrom = await stageState(page)
  await touch.start([rest])
  await touch.start([rest, on])
  await touch.move([rest, { ...on, x: on.x - 15 }])
  await touch.move([rest, { ...on, x: on.x - 45, y: on.y - 20 }])
  await touch.end()
  const restTo = await stageState(page)
  expect(restTo.scale).toBe(restFrom.scale)
  expect(restTo.x - restFrom.x).toBeCloseTo(-30, 0)
  expect(restTo.y - restFrom.y).toBeCloseTo(-20, 0)
  expect(await pageZoom(page)).toEqual(UNZOOMED)
})

test('touch: a label moves only once it is selected', async ({ page }) => {
  const box = await openEditor(page)
  const imageId = currentImageId(page)
  const touch = await touchDriver(page)
  const saveStatus = page.locator('.save-status')
  const undo = page.getByRole('button', { name: 'Undo', exact: true })
  const toolbar = page.getByRole('toolbar', { name: 'Selected labels' })
  const selected = () => selectedIds(page)
  const view = async () => {
    const s = await stageState(page)
    return [s.x, s.y, s.scale]
  }
  const rest = await restingPoint(page)

  await withAnnotationsRestored(page, imageId, async () => {
    const { id, corner, fittedScale } = await labelWithRoom(page, box)
    await zoomAbout(page, corner, fittedScale * 5)
    const scale = (await stageState(page)).scale
    const labelPoint = () => pointOnLabel(page, box, id)
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
      await touch.path([from, { x: from.x + 15, y: from.y + 10 }, { x: from.x + 75, y: from.y + 50 }])
      const after = await stageState(page)
      expect(after.x - before.x).toBeCloseTo(60, 0)
      expect(after.y - before.y).toBeCloseTo(40, 0)
      expect(await drawn()).toEqual(home)
      expect(await selected()).toEqual([])
      await expect(undo).toBeDisabled()
      await expect(saveStatus).toHaveText('Saved')
      expect(await stored()).toEqual(home)
    }

    // 2. A tap selects it, and a thumb resting on the top bar does not get in the way.
    {
      const at = await labelPoint()
      await touch.start([rest])
      await touch.start([rest, { ...at, id: 1 }])
      await touch.end([{ ...at, id: 1 }])
      await touch.end()
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
      await touch.path([at, { x: at.x + 15, y: at.y + 10 }, { x: at.x + 50, y: at.y + 30 }])
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

    // 4b. A finger landing off the canvas while the label is being dragged changes nothing: the
    //     drag goes on, and the photo does not zoom.
    {
      const at = await labelPoint()
      const before = await view()
      const finger = (dx: number) => ({ x: at.x + dx, y: at.y, id: 1 })
      await touch.start([finger(0)])
      await touch.move([finger(20)])
      await touch.move([finger(40)])
      await touch.start([finger(40), rest])
      await touch.move([finger(70), rest])
      await touch.end()
      expect(await view()).toEqual(before)
      const moved = await drawn()
      expect(moved[0]! - home[0]!).toBeCloseTo(70 / scale, 0)
      expect(moved[1]!).toBeCloseTo(home[1]!, 0)
      await undo.tap()
      await expect.poll(drawn).toEqual(home)
      await expect(undo).toBeDisabled()
    }

    // 4c. The browser takes the gesture away mid-drag: the label stays where it had got to, as
    //     one undo entry (Konva ends the drag, as it does for a mouse released outside the window).
    {
      const at = await labelPoint()
      await touch.start([at])
      await touch.move([{ x: at.x + 20, y: at.y }])
      await touch.move([{ x: at.x + 40, y: at.y }])
      await touch.cancel()
      const moved = await drawn()
      expect(moved[0]! - home[0]!).toBeCloseTo(40 / scale, 0)
      await expect(undo).toBeEnabled()
      await undo.tap()
      await expect.poll(drawn).toEqual(home)
      await expect(undo).toBeDisabled()
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
      await touch.end([second])
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
      await touch.end([other])
      await touch.move([{ ...onLabel, x: onLabel.x + 40, y: onLabel.y + 20 }])
      await touch.end()
      expect((await stageState(page)).scale).toBeGreaterThan(before.scale)
      expect(await drawn()).toEqual(home)
      await expect(undo).toBeDisabled()
    }

    // 6b. The toolbar's colour picker is drawn over the canvas: a finger inside it works it, and
    //     only a touch on the photo closes it.
    {
      await expect.poll(selected).toEqual([id])
      await toolbar.getByRole('button', { name: /Text colour/ }).tap()
      const picker = toolbar.getByRole('dialog')
      await expect(picker).toBeVisible()
      await picker.locator('input').tap()
      await expect(picker).toBeVisible()
      await page.touchscreen.tap(box.x + 20, box.y + box.height - 20)
      await expect(picker).toBeHidden()
      // That touch may have landed on anything; back to the label.
      const at = await labelPoint()
      await page.touchscreen.tap(at.x, at.y)
      await expect.poll(selected).toEqual([id])
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
      // ...but not the finger left over from a pinch, which lifts where it landed without having
      // moved: that is the end of a two-finger gesture, not a tap.
      const stay = { x: bare.x - 30, y: bare.y, id: 0 }
      const go = { x: bare.x + 30, y: bare.y, id: 1 }
      await touch.start([stay, go])
      await touch.move([stay, { ...go, x: go.x + 20 }])
      await touch.end([go])
      await touch.end()
      expect(await selected()).toEqual([id])
      await page.getByRole('button', { name: 'Fit' }).tap()
      const clear = await emptyPoint(page, box)
      await page.touchscreen.tap(clear.x, clear.y)
      await expect.poll(selected).toEqual([])
    }
  })
})

test('touch: two taps toggle an object; fields are finger-sized; the mouse still works', async ({ page }) => {
  const box = await openEditor(page)
  const imageId = currentImageId(page)
  const saveStatus = page.locator('.save-status')
  const tooltip = page.locator('.editor-tooltip')
  const undo = page.getByRole('button', { name: 'Undo', exact: true })
  const fit = page.getByRole('button', { name: 'Fit' })
  const labelCount = () => page.evaluate(() => window.__astrocaptionEditor!.labelCount)
  const selected = () => selectedIds(page)

  await withAnnotationsRestored(page, imageId, async (doc) => {
    // An object with a small marker and nothing else within reach of a fingertip: no other
    // object's hit circle, and no other label's text box (labels sit above the hit circles and
    // would take the tap). Its own label is switched off first if it is on: the specs share one
    // data dir, and which labels are enabled depends on what ran before.
    const fitted = await stageState(page)
    // Three times the fitted size: enough to aim at one object, and the smallest markers
    // (`marker_min_radius`) are still only a few pixels across on screen.
    const zoom = fitted.scale * 3
    const objects = await fetchObjects(page, imageId)
    const radius = (o: { radius: number }) => Math.max(o.radius, doc.style.marker_min_radius)
    const reach = 60 / zoom
    const object = objects.find((o) => {
      if (radius(o) * zoom >= 6) return false
      const x = fitted.x + o.x * fitted.scale
      const y = fitted.y + o.y * fitted.scale
      if (!(x > 60 && y > 60 && x < box.width - 60 && y < box.height - 60)) return false
      if (objects.some((p) => p.id !== o.id && Math.hypot(p.x - o.x, p.y - o.y) < radius(p) + reach)) return false
      return !fitted.labels.some(
        (l) =>
          l.id !== o.id && o.x > l.x - reach && o.x < l.x + l.w + reach && o.y > l.y - reach && o.y < l.y + l.h + reach,
      )
    })
    expect(object, 'no isolated, small object in the fixture').toBeTruthy()
    if (doc.labels.some((l) => l.object_id === object!.id && l.enabled)) {
      await putAnnotations(page, imageId, {
        style: doc.style,
        labels: doc.labels.map((l) => (l.object_id === object!.id ? { ...l, enabled: false } : l)),
        version: doc.version,
      })
      await page.reload()
      await page.waitForFunction(() => window.__astrocaptionEditor?.labelPositions !== undefined)
      await expect(saveStatus).toHaveText('Saved')
    }
    const { id } = object!
    const centre = { x: box.x + fitted.x + object!.x * fitted.scale, y: box.y + fitted.y + object!.y * fitted.scale }
    await zoomAbout(page, centre, zoom)
    const storedEnabled = async () =>
      (await fetchAnnotations(page, imageId)).labels.find((l) => l.object_id === id)?.enabled ?? false
    const before = await labelCount()
    // A tap beside the marker: inside the 16 px floor a compact editor gives every object's hit
    // circle, outside what a mouse gets (the marker itself, or 8 px), halfway between the two.
    const mouseReach = Math.max(radius(object!) * (await stageState(page)).scale, 8)
    expect(mouseReach, 'the marker is too big on screen for the floor to matter').toBeLessThan(14)
    const aside = (mouseReach + 16) / 2
    const near = { x: centre.x - aside, y: centre.y }

    // 1. The first tap only says what is there: the ring and the name, as hovering does.
    await expect(tooltip).toBeHidden()
    await page.touchscreen.tap(near.x, near.y)
    await expect(tooltip).toBeVisible()
    await expect(tooltip).not.toBeEmpty()
    expect(await labelCount()).toBe(before)
    await expect(saveStatus).toHaveText('Saved')
    expect(await storedEnabled()).toBe(false)

    // 2. The second tap on the same object switches its label on.
    await page.touchscreen.tap(near.x, near.y)
    await expect.poll(labelCount).toBe(before + 1)
    await expect.poll(storedEnabled).toBe(true)

    // 3. The hover stayed on it, so a third tap switches it off again. The new label was placed
    //    beside the marker; tap on whichever side of the centre it is not.
    const placed = (await stageState(page)).labels.find((l) => l.id === id)!
    const s = await stageState(page)
    const inLabel = (p: { x: number; y: number }) => {
      const wx = (p.x - box.x - s.x) / s.scale
      const wy = (p.y - box.y - s.y) / s.scale
      const pad = 4 / s.scale
      return wx > placed.x - pad && wx < placed.x + placed.w + pad && wy > placed.y - pad && wy < placed.y + placed.h + pad
    }
    const off = [
      { x: centre.x - aside, y: centre.y },
      { x: centre.x + aside, y: centre.y },
      { x: centre.x, y: centre.y - aside },
      { x: centre.x, y: centre.y + aside },
    ].find((p) => !inLabel(p))
    expect(off, 'the new label covers every side of its marker').toBeTruthy()
    await page.touchscreen.tap(off!.x, off!.y)
    await expect.poll(labelCount).toBe(before)
    await expect.poll(storedEnabled).toBe(false)

    // 4. A tap on bare canvas puts the name away.
    await expect(tooltip).toBeVisible()
    await fit.tap()
    const bare = await emptyPoint(page, box)
    await page.touchscreen.tap(bare.x, bare.y)
    await expect(tooltip).toBeHidden()

    // 5. No field on the editor screen is under 16 px with a coarse pointer: iOS zooms the whole
    //    page when a smaller one takes the focus. The floating toolbar (a label selected) and the
    //    side panel (open) are both on screen for the count.
    const label = await labelWithRoom(page, box)
    await zoomAbout(page, label.corner, label.fittedScale * 5)
    const onLabel = await pointOnLabel(page, box, label.id)
    await page.touchscreen.tap(onLabel.x, onLabel.y)
    await expect.poll(selected).toEqual([label.id])
    await expect(page.getByRole('toolbar', { name: 'Selected labels' }).getByRole('spinbutton', { name: 'Font size' })).toBeAttached()
    await page.getByRole('button', { name: 'Expand panel' }).tap()
    const fields = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, select, textarea'), (el) => ({
        name: el.getAttribute('aria-label') ?? el.getAttribute('name') ?? el.tagName,
        size: parseFloat(getComputedStyle(el).fontSize),
      })),
    )
    expect(fields.length).toBeGreaterThan(3)
    expect(fields.filter((f) => f.size < 16)).toEqual([])
    await page.getByRole('button', { name: 'Collapse panel' }).tap()

    // 6. A mouse on the same page after all that (a touch-screen laptop): the wheel still zooms
    //    and a drag still moves a label, by the distance dragged and as one undo entry.
    const at = await pointOnLabel(page, box, label.id)
    const wheelFrom = (await stageState(page)).scale
    await page.mouse.move(at.x, at.y)
    await page.mouse.wheel(0, -200)
    await expect.poll(async () => (await stageState(page)).scale).toBeGreaterThan(wheelFrom)
    const from = await pointOnLabel(page, box, label.id)
    const start = await stageState(page)
    const home = start.labels.find((l) => l.id === label.id)!
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 30, from.y + 20, { steps: 5 })
    await page.mouse.up()
    const moved = (await stageState(page)).labels.find((l) => l.id === label.id)!
    expect(moved.x - home.x).toBeCloseTo(30 / start.scale, 0)
    expect(moved.y - home.y).toBeCloseTo(20 / start.scale, 0)
    // One entry: a single Undo puts it back (the toggles above left entries of their own).
    await undo.tap()
    await expect
      .poll(async () => {
        const l = (await stageState(page)).labels.find((x) => x.id === label.id)!
        return [l.x, l.y]
      })
      .toEqual([home.x, home.y])
  })
})
