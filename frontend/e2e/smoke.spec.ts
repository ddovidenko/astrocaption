import { expect, test } from '@playwright/test'
import { ensureExported, ensureSetUpAndSignedIn, ensureSolvedImage } from './helpers'

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
  await page.goto('/')

  await page.getByRole('link', { name: 'Config' }).click()
  await expect(page).toHaveURL(/\/config$/)
  await page.getByLabel('Site title').fill('Renamed sky')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Renamed sky')

  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await page.goto('/setup')
  await expect(page.getByText('This site is already set up.')).toBeVisible()

  expect(errors).toEqual([])
})
