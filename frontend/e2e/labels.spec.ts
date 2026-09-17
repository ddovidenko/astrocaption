import { expect, test } from './fixtures'
import type { Page } from '@playwright/test'
import type { Label } from '../src/api'
import { currentImageId, ensureSetUpAndSignedIn, ensureSolvedImage, fetchAnnotations } from './helpers'

// Per-label editing (SPEC § 6.2, milestone 4 PR 4): click / shift-click selection with the
// floating toolbar, wheel-to-resize while the button is held, double-click text edit, pinning
// by drag and unpinning by Reset position. Every change is checked in the stored document.

/** Screen coordinates (page space) a few px inside the top-left of the n-th drawn label. */
async function labelPoint(page: Page, n: number) {
  const canvasBox = await page.locator('.editor-canvas').boundingBox()
  expect(canvasBox).toBeTruthy()
  const at = await page.evaluate((i) => {
    const hook = window.__astrocaptionEditor!
    const l = hook.labelPositions()[i]!
    const { stage } = hook
    const scale = stage.scaleX()
    return { id: l.id, x: stage.x() + l.x * scale + 6, y: stage.y() + l.y * scale + 6, wx: l.x, wy: l.y }
  }, n)
  return { ...at, x: canvasBox!.x + at.x, y: canvasBox!.y + at.y }
}

test('toolbar, wheel, double-click and pins edit the selected labels', async ({ page }) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page)
  await card.getByRole('link', { name: 'Edit' }).click()
  await page.waitForFunction(() => window.__astrocaptionEditor?.labelPositions !== undefined)
  const imageId = currentImageId(page)
  const storedLabel = async (id: number) => (await fetchAnnotations(page, imageId)).labels.find((l) => l.object_id === id)!
  // Every assertion below is about the *stored* document: the edit has to have reached the server
  // through the autosave, not merely the canvas — hence a poll rather than a straight read.
  const pollField = <K extends keyof Label>(id: number, field: K, expected: Label[K]) =>
    expect.poll(async () => (await storedLabel(id))[field], { timeout: 5_000 }).toBe(expected)
  const selected = () => page.evaluate(() => window.__astrocaptionEditor!.selectedIds())

  // Click selects one; the toolbar appears above it.
  const first = await labelPoint(page, 0)
  await page.mouse.click(first.x, first.y)
  await expect.poll(selected).toEqual([first.id])
  const toolbar = page.getByRole('toolbar', { name: 'Selected labels' })
  await expect(toolbar).toBeVisible()

  // Font size from the toolbar, autosaved.
  const size = toolbar.getByLabel('Font size')
  await size.fill('31')
  await size.press('Enter')
  await pollField(first.id, 'font_size', 31)

  // Wheel with the button held: one notch up = +1, committed on the mouseup (EditorCanvas.tsx),
  // then autosaved — so poll the stored document rather than assert straight away.
  //
  // The wheel goes out over raw CDP rather than through `page.mouse.wheel`, which dispatches
  // `Input.dispatchMouseEvent` with x/y/modifiers/deltas and no `buttons` field at all
  // (playwright-core's RawMouseImpl.wheel). The page would then see `WheelEvent.buttons === 0`
  // even with the button down, and `onWheel` would zoom instead of resizing — its `buttons & 1`
  // guard is what a real browser reports while the button is held. Chromium-only, like this
  // project in playwright.config.ts.
  const cdp = await page.context().newCDPSession(page)
  await page.mouse.move(first.x, first.y)
  await page.mouse.down()
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: first.x,
    y: first.y,
    buttons: 1,
    deltaX: 0,
    deltaY: -100,
  })
  await page.mouse.up()
  await cdp.detach()
  await pollField(first.id, 'font_size', 32)

  // Double-click: inline text edit, Enter commits.
  await page.mouse.dblclick(first.x, first.y)
  const editor = page.getByRole('textbox', { name: 'Label text' })
  await expect(editor).toBeVisible()
  await editor.fill('Renamed by test')
  await editor.press('Enter')
  await pollField(first.id, 'text_override', 'Renamed by test')

  // Shift-click adds a second label; a mixed size shows blank; Clear overrides clears both.
  const second = await labelPoint(page, 1)
  // `page.mouse.click` has no `modifiers` option (that is `locator.click`), so Shift is held
  // around it: Playwright carries its own modifier state into the dispatched mouse events, which
  // is what `onLabelPress` reads as `e.evt.shiftKey`.
  await page.keyboard.down('Shift')
  await page.mouse.click(second.x, second.y)
  await page.keyboard.up('Shift')
  await expect.poll(async () => (await selected()).sort()).toEqual([first.id, second.id].sort())
  await expect(size).toHaveValue('')

  // A plain click on a label of that group narrows the selection to it (SPEC § 6.2): the press
  // keeps the group (so a group drag works), the click that follows is what narrows.
  await page.mouse.click(first.x, first.y)
  await expect.poll(selected).toEqual([first.id])
  // Both again, for the Clear overrides step below.
  await page.keyboard.down('Shift')
  await page.mouse.click(second.x, second.y)
  await page.keyboard.up('Shift')
  await expect.poll(async () => (await selected()).sort()).toEqual([first.id, second.id].sort())

  await toolbar.getByRole('button', { name: 'Clear overrides' }).click()
  await pollField(first.id, 'font_size', null)
  expect((await storedLabel(first.id)).text_override).toBeNull()

  // Escape clears the selection.
  await page.keyboard.press('Escape')
  await expect.poll(selected).toEqual([])

  // A drag pins; Reset position unpins and moves the label back to a placed slot.
  await page.mouse.click(first.x, first.y)
  await page.mouse.move(first.x, first.y)
  await page.mouse.down()
  await page.mouse.move(first.x + 40, first.y + 30, { steps: 5 })
  await page.mouse.up()
  await pollField(first.id, 'pinned', true)
  const dragged = await storedLabel(first.id)
  expect([dragged.x, dragged.y]).not.toEqual([first.wx, first.wy]) // the drag really moved it
  await toolbar.getByRole('button', { name: 'Reset position' }).click()
  await pollField(first.id, 'pinned', false)
  // Unpinning is only half of it: the placer has to have put the label somewhere else again.
  const replaced = await storedLabel(first.id)
  expect([replaced.x, replaced.y]).not.toEqual([dragged.x, dragged.y])
  await expect(page.locator('.save-status')).toHaveText('Saved')
})
