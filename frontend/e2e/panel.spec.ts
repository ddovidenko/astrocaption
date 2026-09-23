import { expect, test } from './fixtures'
import { currentImageId, ensureSetUpAndSignedIn, ensureSolvedImage, fetchAnnotations, fetchObjects } from './helpers'

// Side panel (SPEC § 6.3): the Objects tab filters by kind with the HD toggle, its names follow
// the Style tab's preference without a reload (#94), the tablist works from the keyboard and a
// visited tab keeps its state across a switch (#76).
test('the side panel: kind chips, keyboard tabs, kept state, names follow the preference', async ({ page }) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page)
  await card.getByRole('link', { name: 'Edit' }).click()
  await expect(page).toHaveURL(/\/images\/[0-9a-f-]+$/)
  await page.waitForFunction(() => window.__astrocaptionEditor?.labelPositions !== undefined)
  const imageId = currentImageId(page)

  // Kind chips: the Orion fixture has 8 bright stars, 9 NGC and 3 IC rows. A chip only hides the
  // *disabled* rows of its kind: a star whose label is drawn stays listed with Stars off.
  const rows = page.locator('.object-list .object-row')
  await expect(page.getByText('20 of 20 objects')).toBeVisible()
  const objects = await fetchObjects(page, imageId)
  const enabledIds = new Set((await fetchAnnotations(page, imageId)).labels.filter((l) => l.enabled).map((l) => l.object_id))
  const drawnStars = objects.filter((o) => o.kind === 'star' && enabledIds.has(o.id)).length
  await page.getByRole('button', { name: 'Stars', exact: true }).click()
  await expect(page.getByText(`${12 + drawnStars} of 20 objects`)).toBeVisible()
  await expect(rows.filter({ hasText: 'star' })).toHaveCount(drawnStars)
  await expect(rows.filter({ hasText: 'star' }).locator('input[type=checkbox]:not(:checked)')).toHaveCount(0)
  await page.getByRole('button', { name: 'Stars', exact: true }).click()
  await expect(page.getByText('20 of 20 objects')).toBeVisible()
  // No hd rows in this field: the toggle changes nothing but stays pressable.
  await page.getByRole('button', { name: 'HD stars' }).click()
  await expect(page.getByRole('button', { name: 'HD stars' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'HD stars' }).click()

  // A search typed here survives a visit to another tab.
  await page.getByLabel('Search objects').fill('M 4')
  await page.getByRole('tab', { name: 'Image' }).click()
  await expect(page.getByRole('button', { name: 'Export' })).toBeVisible()
  await page.getByRole('tab', { name: 'Objects' }).click()
  await expect(page.getByLabel('Search objects')).toHaveValue('M 4')
  await page.getByLabel('Search objects').fill('')

  // Keyboard: ArrowRight selects and focuses the next tab.
  await page.getByRole('tab', { name: 'Objects' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Style' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Style' })).toBeFocused()

  // Names follow the preference: M 42 ↔ NGC 1976, then put the stored preference back (the data
  // dir is shared with the rest of the suite).
  const before = (await fetchAnnotations(page, imageId)).style.name_preference
  const other = before === 'popular' ? 'ngc_ic' : 'popular'
  const select = page.getByLabel('Primary name')
  await select.selectOption(other)
  await expect.poll(async () => (await fetchAnnotations(page, imageId)).style.name_preference, { timeout: 5_000 }).toBe(other)
  await page.getByRole('tab', { name: 'Objects' }).click()
  const expectName = other === 'ngc_ic' ? 'NGC 1976' : 'M 42'
  await expect(page.getByRole('button', { name: expectName, exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Style' }).click()
  await select.selectOption(before)
  await expect.poll(async () => (await fetchAnnotations(page, imageId)).style.name_preference, { timeout: 5_000 }).toBe(before)

  // A clicked checkbox keeps the keyboard focus; Ctrl+Z must still undo (a checkbox is not a
  // text field the key handler has to leave alone).
  await page.getByRole('tab', { name: 'Objects' }).click()
  const enabledCount = async () => (await fetchAnnotations(page, imageId)).labels.filter((l) => l.enabled).length
  const wasEnabled = await enabledCount()
  const box = page.locator('.object-list input[type=checkbox]').first()
  const checked = await box.isChecked()
  await box.click()
  await expect.poll(enabledCount, { timeout: 5_000 }).toBe(checked ? wasEnabled - 1 : wasEnabled + 1)
  await expect(box).toBeFocused()
  await page.keyboard.press('Control+z')
  await expect.poll(enabledCount, { timeout: 5_000 }).toBe(wasEnabled)
})
