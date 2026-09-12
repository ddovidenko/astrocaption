import { expect, type Locator, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Shared steps for the e2e specs. The whole run shares one data dir (`make e2e` mints a scratch
// one) and one worker, so whichever spec runs first performs the real first-run setup and the
// real upload; the others find the state already there. Every helper is therefore an "ensure":
// it asserts the end state, and only does the work when the state is not there yet.

export const PASSWORD = 'e2e-password-1'
export const FIXTURE = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'field.jpg')

declare global {
  interface Window {
    /** Published by `EditorCanvas` while the stage is mounted (src/editor/EditorCanvas.tsx). */
    __astrocaptionEditor?: { stage: unknown; imageWidth: number; renderAt(scale: number): string }
  }
}

interface Health {
  setup_required: boolean
  authenticated: boolean
}

/** Leaves the browser signed in on `/`. Asks the API what state the install is in rather than
 *  guessing from the URL: the SPA redirects only after its first health fetch, so reading
 *  `page.url()` straight after a goto would race that redirect. */
export async function ensureSetUpAndSignedIn(page: Page): Promise<void> {
  const res = await page.request.get('/api/health')
  expect(res.status()).toBe(200)
  const health = (await res.json()) as Health

  if (health.setup_required) {
    // The redirect itself is the assertion: the blank-page regression (#11) broke exactly this.
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page).toHaveURL(/\/setup$/)
    await page.getByLabel('Password (at least 8 characters)').fill(PASSWORD)
    await page.getByLabel('Password again').fill(PASSWORD)
    await page.getByLabel('Site title (optional)').fill('E2E sky')
    await page.getByRole('button', { name: 'Finish setup' }).click()
    await expect(page).toHaveURL(/\/login$/)
  }

  if (health.setup_required || !health.authenticated) {
    if (!/\/login$/.test(page.url())) {
      await page.goto('/')
      await expect(page).toHaveURL(/\/login$/)
    }
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
  } else {
    await page.goto('/')
  }
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
}

/** Returns the card for `title`, uploading and solving the fixture first if it is not there.
 *  Assumes the signed-in image list is already open. */
export async function ensureSolvedImage(page: Page, title = 'Orion'): Promise<Locator> {
  const card = page.locator('article.card', { hasText: title })
  if ((await card.count()) === 0) {
    await page.locator('input[type=file]').setInputFiles(FIXTURE)
    await page.getByPlaceholder('Title (optional)').fill(title)
    await page.getByRole('button', { name: 'Upload & solve' }).click()
  }
  await expect(card.locator('.badge')).toHaveText('Solved', { timeout: 60_000 })
  await expect(card.getByText(/[1-9]\d* objects/)).toBeVisible()
  return card
}

/** Exports `card` unless it has an annotated preview already, and returns that preview's URL.
 *  `_page` is unused — it keeps the call shape of the other two helpers. */
export async function ensureExported(_page: Page, card: Locator): Promise<string> {
  const img = card.locator('img[alt$=" annotated"]')
  if ((await img.count()) === 0) {
    await card.getByRole('button', { name: 'Export' }).click()
  }
  await expect(img).toBeVisible({ timeout: 60_000 })
  // toBeVisible() alone passes on a broken image (the alt text still gives it a box); confirm
  // the browser actually decoded pixels.
  await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0)
  // The `src` property, not the attribute: already absolute, so a caller can load it anywhere.
  return img.evaluate((e: HTMLImageElement) => e.src)
}
