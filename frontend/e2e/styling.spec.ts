import { expect, test } from './fixtures'
import type { StyleConfig } from '../src/api'
import { currentImageId, ensureSetUpAndSignedIn, ensureSolvedImage, fetchAnnotations } from './helpers'

// Style tab (SPEC § 6.3): a number field commits its debounced value and autosaves it, Ctrl+Z
// (from outside any input, since the canvas key handler ignores focused fields) takes it back,
// and picking another bundled font commits only once the browser has loaded that face.
test('the Style tab changes the font size live, autosaves it, and Ctrl+Z takes it back', async ({ page }) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page)
  await card.getByRole('link', { name: 'Edit' }).click()
  await expect(page).toHaveURL(/\/images\/[0-9a-f-]+$/)
  // The hook is published once the preview bitmap has loaded (EditorCanvas.tsx).
  await page.waitForFunction(() => window.__astrocaptionEditor?.labelPositions !== undefined)

  const imageId = currentImageId(page)
  const stored = () => fetchAnnotations(page, imageId)
  const before = await stored()

  await page.getByRole('tab', { name: 'Style' }).click()
  const size = page.getByLabel('Font size (px)')
  await expect(size).toHaveValue(String(before.style.font_size))
  // Whichever value the field starts at (a shared data dir may carry a prior test's edit), pick
  // the other of these two so the change is unambiguous either way.
  const target = before.style.font_size === 40 ? 44 : 40
  await size.fill(String(target))
  // fill() dispatches one input event with the whole final value, so exactly one debounced commit
  // is scheduled — no intermediate digit-by-digit commits to wait out.
  await expect.poll(async () => (await stored()).style.font_size, { timeout: 5_000 }).toBe(target)
  await expect(page.locator('.save-status')).toHaveText('Saved')

  // Undo from the canvas: focus must leave the input first, since the key handler ignores it
  // while a field is focused (the debounced commit itself was already proven flushed above).
  await page.locator('.editor-canvas').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await stored()).style.font_size, { timeout: 5_000 }).toBe(before.style.font_size)

  // Picking another bundled font swaps it only after the browser has loaded that face. The select
  // has its own id/htmlFor now (#E), so getByLabel resolves it directly — it used to fold the
  // selected option's own text into the label's accessible name (e.g. "Font" + "Fira Sans Bold"),
  // so plain "Font" never matched; that workaround (locate by field-label text, then the <select>
  // inside the same wrapper) is gone.
  const font = page.getByLabel('Font', { exact: true })
  const optionLabels = await font.locator('option').allTextContents()
  const other = optionLabels.find((t) => t.includes('Roboto') && !t.includes('Condensed'))
  expect(other, `no plain Roboto option among: ${optionLabels.join(', ')}`).toBeTruthy()
  await font.selectOption({ label: other! })
  await expect.poll(async () => (await stored()).style.font_file, { timeout: 10_000 }).toMatch(/^Roboto-/)
  await expect(page.locator('.side-panel .error')).toHaveCount(0)

  // Restore the fixture image's original font: this spec shares the 'Orion' image (and its
  // cached export) with the rest of the suite, so leaving it on Roboto could make a later spec
  // compare a stale export against a canvas drawn in the wrong font (smoke.spec.ts sets the
  // precedent of reverting its own password change for the same reason).
  await font.selectOption(before.style.font_file)
  await expect.poll(async () => (await stored()).style.font_file, { timeout: 10_000 }).toBe(before.style.font_file)
  await expect(page.locator('.save-status')).toHaveText('Saved')

  // Colour override: typing a hex into the picker commits it once the popover closes (Escape),
  // carrying the just-typed value rather than a render-behind draft (#B). react-colorful's hex
  // input strips the leading '#' and normalizeHex lower-cases nothing it is given, so the stored
  // value keeps whatever case the input round-trips — compare case-insensitively.
  await page.getByRole('button', { name: /Text colour/ }).click()
  await page.locator('.popover input').fill('ff8800')
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await stored()).style.text_color, { timeout: 5_000 }).toMatch(/^#ff8800$/i)
  await expect(page.locator('.save-status')).toHaveText('Saved')

  // Reset to site defaults: every field in the stored style matches what the server itself would
  // hand back for a blank override set.
  const defaultStyle = (await (await page.request.get(`/api/images/${imageId}/default-style`)).json()) as StyleConfig
  await page.getByRole('button', { name: 'Reset to site defaults' }).click()
  await expect.poll(async () => (await stored()).style, { timeout: 5_000 }).toEqual(defaultStyle)
  await expect(page.locator('.save-status')).toHaveText('Saved')

  // The reset restores the size-relative defaults on its own; only the font can still differ from
  // the fixture image's original (the site default need not be the same font), and leaving it
  // swapped would affect later specs sharing this image the same way the font-swap above avoids.
  if (defaultStyle.font_file !== before.style.font_file) {
    await font.selectOption(before.style.font_file)
    await expect.poll(async () => (await stored()).style.font_file, { timeout: 10_000 }).toBe(before.style.font_file)
    await expect(page.locator('.save-status')).toHaveText('Saved')
  }
})
