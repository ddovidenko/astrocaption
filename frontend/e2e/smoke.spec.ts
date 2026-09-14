import { expect, test } from '@playwright/test'
import { ensureExported, ensureSetUpAndSignedIn, ensureSolvedImage, PASSWORD } from './helpers'

// This runs against the built frontend bundle served by uvicorn (`make e2e`) or the Docker
// image (CI) — never the Vite dev server, so it does not guard `make dev`'s /api proxy.

// One story, in order: a fresh install is set up, an image is solved and exported, the editor
// opens on it, the config page changes the title, and signing out closes the door. Every step is
// one the blank-page regression (#11) would have broken.
test('first run: setup, sign in, solve, export, edit, config, sign out', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await ensureSetUpAndSignedIn(page)
  // A second pass on the same data dir finds the title already renamed by the first pass's
  // Config step below.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^(E2E sky|Renamed sky)$/)

  const card = await ensureSolvedImage(page, 'Orion')
  await ensureExported(card, 'Orion')

  const downloadLink = card.getByRole('link', { name: 'Download full-resolution export' })
  await expect(downloadLink).toBeVisible()
  const href = await downloadLink.getAttribute('href')
  expect(href).toBeTruthy()
  const res = await page.request.get(href!)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toContain('image/jpeg')

  await card.getByRole('link', { name: 'Edit' }).click()
  await expect(page).toHaveURL(/\/images\/[0-9a-f-]+$/)
  await expect(page.locator('canvas').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Fit' })).toBeVisible()
  // The hook is published once the preview bitmap has loaded (EditorCanvas.tsx); everything below
  // needs it, whether to read a label's position or just to know the stage has something drawn.
  await page.waitForFunction(() => window.__astrocaptionEditor?.labelPositions !== undefined)

  const imageId = /\/images\/([^/?#]+)/.exec(page.url())?.[1]
  expect(imageId, `no image id in ${page.url()}`).toBeTruthy()
  const annotationsUrl = `/api/images/${imageId}/annotations`
  interface StoredLabel {
    object_id: number
    enabled: boolean
    x: number
    y: number
  }
  // What the server has stored, which is what every assertion below is about: the autosave has to
  // have landed, not just the canvas to have moved.
  const stored = async (): Promise<{ version: number; labels: StoredLabel[] }> => {
    const res = await page.request.get(annotationsUrl)
    expect(res.status()).toBe(200)
    return (await res.json()) as { version: number; labels: StoredLabel[] }
  }
  const enabledCount = async (): Promise<number> =>
    (await stored()).labels.filter((l) => l.enabled).length
  const storedLabel = async (objectId: number): Promise<StoredLabel | undefined> =>
    (await stored()).labels.find((l) => l.object_id === objectId)

  // Objects tab: toggling a row's checkbox is `toggleWithPlacement` (SPEC § 6.1), autosaved.
  await page.getByRole('tab', { name: 'Objects' }).click()
  const rows = page.locator('.object-list input[type=checkbox]')
  await expect(rows.first()).toBeVisible()
  // NGC 1924 is disabled by default in the Orion fixture (SPEC § 5.2 step 5); pick any other
  // disabled row if the fixture ever changes, and fall back to an enabled one otherwise.
  const unchecked = page.locator('.object-list input[type=checkbox]:not(:checked)').first()
  const enabling = (await unchecked.count()) > 0
  const target = enabling ? unchecked : page.locator('.object-list input[type=checkbox]:checked').first()
  const before = await enabledCount()
  await target.click()
  await expect.poll(enabledCount, { timeout: 3_000 }).toBe(enabling ? before + 1 : before - 1)

  // Drag the first drawn label 40 px right: locate it in screen space via the hook's stage
  // transform (all label geometry is stored in original-image pixels, CLAUDE.md "Coordinates").
  const canvasBox = await page.locator('.editor-canvas').boundingBox()
  expect(canvasBox).toBeTruthy()
  const label = await page.evaluate(() => window.__astrocaptionEditor!.labelPositions()[0])
  expect(label, 'no label drawn to drag').toBeTruthy()
  const start = await page.evaluate((l) => {
    const { stage } = window.__astrocaptionEditor!
    const scale = stage.scaleX()
    // A few SCREEN px in from the label's top-left corner (its box's own origin), safely inside
    // the group's hit rect (LabelTextShape.tsx) rather than right on the edge. The offset is
    // added after scaling: 6 original pixels can be well under one screen pixel when the image is
    // fitted into the window.
    return { x: stage.x() + l!.x * scale + 6, y: stage.y() + l!.y * scale + 6 }
  }, label)
  const startX = canvasBox!.x + start.x
  const startY = canvasBox!.y + start.y
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 40, startY, { steps: 5 })
  await page.mouse.up()
  await expect
    .poll(async () => (await storedLabel(label!.id))?.x ?? Number.NEGATIVE_INFINITY, { timeout: 3_000 })
    .toBeGreaterThan(label!.x)
  // A horizontal drag moves nothing else: a pan or a re-place would have shifted y too.
  expect((await storedLabel(label!.id))!.y).toBeCloseTo(label!.y, 0)

  // Layout tab: Auto-arrange flushes the pending drag save, re-places every enabled label, and the
  // result is itself autosaved back to "Saved" — a new stored version is the proof it ran.
  const versionBeforeArrange = (await stored()).version
  await page.getByRole('tab', { name: 'Layout' }).click()
  await page.getByRole('button', { name: 'Auto-arrange' }).click()
  await expect.poll(async () => (await stored()).version, { timeout: 10_000 }).toBeGreaterThan(versionBeforeArrange)
  await expect(page.locator('.save-status')).toHaveText('Saved')

  // Image tab: Export renders the current document and offers the download link.
  await page.getByRole('tab', { name: 'Image' }).click()
  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByRole('link', { name: 'Download full-resolution export' })).toBeVisible()

  // None of the three tabs reported a failure along the way.
  await expect(page.locator('.side-panel .error')).toHaveCount(0)

  await page.goto('/')

  await page.getByRole('link', { name: 'Config' }).click()
  await expect(page).toHaveURL(/\/config$/)
  await page.getByLabel('Site title').fill('Renamed sky')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Renamed sky')

  // Password change (#43): the changing session stays signed in, and the change is reverted so
  // the next run of this suite on the same data dir can still sign in.
  const changePassword = async (from: string, to: string) => {
    await page.getByLabel('Current password').fill(from)
    await page.getByLabel('New password', { exact: true }).fill(to)
    await page.getByLabel('New password again').fill(to)
    await page.getByRole('button', { name: 'Change password' }).click()
    await expect(page.getByText('Password changed.')).toBeVisible()
  }
  await changePassword(PASSWORD, `${PASSWORD}-2`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible() // still signed in, still on the page
  await changePassword(`${PASSWORD}-2`, PASSWORD)

  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  // The restored password still signs in: the round trip above really put it back.
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await page.goto('/setup')
  await expect(page.getByText('This site is already set up.')).toBeVisible()

  expect(errors).toEqual([])
})
