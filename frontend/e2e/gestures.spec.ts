import { expect, test } from './fixtures'
import type { Page } from '@playwright/test'
import { currentImageId, ensureSetUpAndSignedIn, ensureSolvedImage, fetchAnnotations, fetchObjects } from './helpers'

// The canvas gestures that must never move a label (SPEC § 6.2, #87): a Space-drag and a
// middle-button drag pan the view wherever they start, a label included; the click Konva fires
// after a moved gesture is neither a marker toggle nor a deselect; a plain click on the empty
// canvas deselects. `smoke.spec.ts` drives the left-drag that does move a label.

/** The stage transform and the drawn labels, read through the editor's test hook. */
function readStage(page: Page) {
  return page.evaluate(() => {
    const hook = window.__astrocaptionEditor!
    return { x: hook.stage.x(), y: hook.stage.y(), scale: hook.stage.scaleX(), labels: hook.labelPositions() }
  })
}

test('Space-pan, middle-button pan, and clicks after a moved gesture leave the labels alone', async ({ page }) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page)
  await card.getByRole('link', { name: 'Edit' }).click()
  await page.waitForFunction(() => window.__astrocaptionEditor?.labelPositions !== undefined)
  const imageId = currentImageId(page)
  const canvasBox = (await page.locator('.editor-canvas').boundingBox())!
  expect(canvasBox).toBeTruthy()
  /** Page coordinates of an original-image point under the current stage transform. */
  const toPage = async (wx: number, wy: number) => {
    const s = await readStage(page)
    return { x: canvasBox.x + s.x + wx * s.scale, y: canvasBox.y + s.y + wy * s.scale }
  }
  const storedLabel = async (id: number) => (await fetchAnnotations(page, imageId)).labels.find((l) => l.object_id === id)!
  const selected = () => page.evaluate(() => window.__astrocaptionEditor!.selectedIds())
  const saveStatus = page.locator('.save-status')
  await expect(saveStatus).toHaveText('Saved')

  const first = (await readStage(page)).labels[0]
  expect(first, 'no label drawn').toBeTruthy()
  const storedBefore = await storedLabel(first!.id)
  /** A few screen px inside the label's top-left corner (its hit rect), as smoke.spec.ts does. */
  const labelPoint = async () => {
    const p = await toPage(first!.x, first!.y)
    return { x: p.x + 6, y: p.y + 6 }
  }

  /** Runs `gesture` from the label and checks it panned the stage by (dx, dy) and moved nothing. */
  const panFromLabel = async (dx: number, dy: number, gesture: (from: { x: number; y: number }) => Promise<void>) => {
    const before = await readStage(page)
    await gesture(await labelPoint())
    const after = await readStage(page)
    expect(after.x - before.x).toBeCloseTo(dx, 0)
    expect(after.y - before.y).toBeCloseTo(dy, 0)
    const drawn = after.labels.find((l) => l.id === first!.id)!
    expect([drawn.x, drawn.y]).toEqual([first!.x, first!.y])
    // Nothing was committed: no autosave ran, and the server still holds the same position.
    await expect(saveStatus).toHaveText('Saved')
    const stored = await storedLabel(first!.id)
    expect([stored.x, stored.y]).toEqual([storedBefore.x, storedBefore.y])
  }

  // 1. Space held: the press lands on the label, and the drag pans.
  await panFromLabel(60, 40, async (from) => {
    await page.keyboard.down('Space')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 60, from.y + 40, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.up('Space')
  })

  // 2. The middle button pans from anywhere too, no key held.
  await panFromLabel(-50, 30, async (from) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(from.x - 50, from.y + 30, { steps: 5 })
    await page.mouse.up({ button: 'middle' })
  })

  // 3. A Space-drag that begins on an enabled object's marker ends with a click on that marker;
  //    a moved gesture is not a toggle, so the label stays drawn and stored enabled.
  const objects = await fetchObjects(page, imageId)
  const marker = objects.find((o) => o.id === first!.id)!
  const labelCount = () => page.evaluate(() => window.__astrocaptionEditor!.labelCount)
  const drawnBefore = await labelCount()
  const enabledBefore = (await fetchAnnotations(page, imageId)).labels.filter((l) => l.enabled).length
  {
    const from = await toPage(marker.x, marker.y)
    await page.keyboard.down('Space')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 40, from.y + 40, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.up('Space')
  }
  expect(await labelCount()).toBe(drawnBefore)
  await expect(saveStatus).toHaveText('Saved')
  expect((await fetchAnnotations(page, imageId)).labels.filter((l) => l.enabled).length).toBe(enabledBefore)

  // 4. Empty canvas: a left-drag there pans and keeps the selection (a moved gesture is not a
  //    click); a plain click there deselects. "Empty" is just past the image bitmap's right or
  //    bottom edge, whichever the fitted view leaves inside the canvas: the bitmap layer does
  //    not listen, but a marker or a label could sit anywhere over it.
  const { x: lx, y: ly } = await labelPoint()
  await page.mouse.click(lx, ly)
  await expect.poll(selected).toEqual([first!.id])
  const empty = await (async () => {
    const s = await readStage(page)
    const { imageWidth, imageHeight } = await page.evaluate(() => {
      const h = window.__astrocaptionEditor!
      return { imageWidth: h.imageWidth, imageHeight: h.imageHeight }
    })
    const right = { x: s.x + imageWidth * s.scale + 12, y: s.y + (imageHeight * s.scale) / 2 }
    const below = { x: s.x + (imageWidth * s.scale) / 2, y: s.y + imageHeight * s.scale + 12 }
    const inside = (p: { x: number; y: number }) => p.x > 0 && p.y > 0 && p.x < canvasBox.width - 12 && p.y < canvasBox.height - 12
    const pick = inside(right) ? right : inside(below) ? below : null
    expect(pick, 'the fitted view leaves no empty canvas beside the image').toBeTruthy()
    return { x: canvasBox.x + pick!.x, y: canvasBox.y + pick!.y }
  })()
  const beforeDrag = await readStage(page)
  await page.mouse.move(empty.x, empty.y)
  await page.mouse.down()
  await page.mouse.move(empty.x - 30, empty.y - 20, { steps: 5 })
  await page.mouse.up()
  const afterDrag = await readStage(page)
  expect(afterDrag.x - beforeDrag.x).toBeCloseTo(-30, 0)
  expect(afterDrag.y - beforeDrag.y).toBeCloseTo(-20, 0)
  expect(await selected()).toEqual([first!.id])
  // The pan moved the empty point with the view; click where it is now.
  await page.mouse.click(empty.x - 30, empty.y - 20)
  await expect.poll(selected).toEqual([])
  await expect(saveStatus).toHaveText('Saved')
})
