import { expect, test } from './fixtures'
import { currentImageId, ensureSetUpAndSignedIn, ensureSolvedImage, fetchAnnotations, fetchObjects, withAnnotationsRestored } from './helpers'

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
  // The name preference and a label toggle below are flipped and put back through the UI; the
  // wrapper puts them back regardless, so a failure in between stays one failure (#116).
  await withAnnotationsRestored(page, imageId, async () => {
    // Kind chips: the Orion fixture has 8 bright stars, 9 NGC and 3 IC rows from nova, plus the
    // local catalogue's objects in this field (Sharpless, LBN, LDN; #17). The total is read from
    // the server so the spec follows the shipped catalogue rather than hard-coding it. A chip only
    // hides the *disabled* rows of its kind: a star whose label is drawn stays listed with Stars off.
    const rows = page.locator('.object-list .object-row')
    const objects = await fetchObjects(page, imageId)
    const total = objects.length
    expect(total).toBeGreaterThan(20)
    await expect(page.getByText(`${total} of ${total} objects`)).toBeVisible()
    const enabledIds = new Set((await fetchAnnotations(page, imageId)).labels.filter((l) => l.enabled).map((l) => l.object_id))
    const stars = objects.filter((o) => o.kind === 'star').length
    const drawnStars = objects.filter((o) => o.kind === 'star' && enabledIds.has(o.id)).length
    await page.getByRole('button', { name: 'Stars', exact: true }).click()
    await expect(page.getByText(`${total - stars + drawnStars} of ${total} objects`)).toBeVisible()
    await expect(rows.filter({ hasText: 'star' })).toHaveCount(drawnStars)
    await expect(rows.filter({ hasText: 'star' }).locator('input[type=checkbox]:not(:checked)')).toHaveCount(0)
    await page.getByRole('button', { name: 'Stars', exact: true }).click()
    await expect(page.getByText(`${total} of ${total} objects`)).toBeVisible()
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

    // The browser's own undo (the editor leaves Ctrl+Z to a focused text field) only ever shortens
    // what was typed; a controlled input let Chromium replay a stale insertion (#90: "M 312"). The
    // list must agree with whatever the box shows.
    const search = page.getByLabel('Search objects')
    await search.pressSequentially('M 31', { delay: 40 })
    await expect(search).toHaveValue('M 31')
    await search.press('Control+z')
    const undone = await search.inputValue()
    expect('M 31'.startsWith(undone)).toBe(true)
    await expect(page.getByText(`${objects.filter((o) => o.catalog_names.some((n) => n.toLowerCase().includes(undone.toLowerCase()))).length} of ${total} objects`)).toBeVisible()
    await search.fill('')

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
})
