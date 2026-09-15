import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HealthOut, ImageOut } from '../src/api'
import type { EditorTestHook } from '../src/editor/EditorCanvas'

// Shared steps for the e2e specs. The whole run shares one data dir (`make e2e` mints a scratch
// one) and one worker, so whichever spec runs first performs the real first-run setup and the
// real upload; the others find the state already there. Every helper is therefore an "ensure":
// it asserts the end state, and only does the work when the state is not there yet.

export const PASSWORD = 'e2e-password-1'
export const FIXTURE = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'field.jpg')
// The fake nova is reached directly, not through the app: in CI it listens on 0.0.0.0 (so the
// container can call it through host.docker.internal) and 127.0.0.1 still reaches it there.
export const FAKE_NOVA_URL = `http://127.0.0.1:${process.env.FAKE_NOVA_PORT ?? '8901'}`

export type FakeNovaMode = 'success' | 'failure' | 'timeout'

declare global {
  interface Window {
    /** Published by `EditorCanvas` once the preview bitmap has loaded. */
    __astrocaptionEditor?: EditorTestHook
  }
}

/** Leaves the browser signed in on `/`. Asks the API what state the install is in rather than
 *  guessing from the URL: the SPA redirects only after its first health fetch, so reading
 *  `page.url()` straight after a goto would race that redirect. */
export async function ensureSetUpAndSignedIn(page: Page): Promise<void> {
  const res = await page.request.get('/api/health')
  expect(res.status()).toBe(200)
  const health = (await res.json()) as HealthOut

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

export interface FakeNovaState {
  job: FakeNovaMode
  /** POST /api/upload count since the fake started. Check again must not add one. */
  uploads: number
}

/** The fake nova's own control surface (`/_fake/…` in fake-nova.mjs), reached directly rather
 *  than through the app. Built on an APIRequestContext, so a fixture or a cleanup hook can drive
 *  it without a page (see fixtures.ts, which resets the mode after every test). */
export class FakeNova {
  constructor(private readonly request: APIRequestContext) {}

  /** Switches how the fake answers job polls, for every solve from now on. */
  async setMode(mode: FakeNovaMode): Promise<void> {
    const res = await this.request.post(`${FAKE_NOVA_URL}/_fake/mode`, { data: { job: mode } })
    expect(res.status(), `fake nova mode ${mode}`).toBe(200)
  }

  /** The mode in force and the upload count. */
  async state(): Promise<FakeNovaState> {
    const res = await this.request.get(`${FAKE_NOVA_URL}/_fake/state`)
    expect(res.status(), 'fake nova state').toBe(200)
    const body = (await res.json()) as FakeNovaState
    // A shape check, not a formality: a renamed field would otherwise read as `undefined` and
    // quietly turn every upload-count assertion into a comparison of two undefineds.
    expect(typeof body.uploads, `fake nova upload count in ${JSON.stringify(body)}`).toBe('number')
    return body
  }
}

/** Uploads the fixture under `title` and returns its card, without waiting for a solve status. */
export async function uploadImage(page: Page, title: string): Promise<Locator> {
  await page.locator('input[type=file]').setInputFiles(FIXTURE)
  await page.getByPlaceholder('Title (optional)').fill(title)
  await page.getByRole('button', { name: 'Upload & solve' }).click()
  const card = page.locator('article.card', { hasText: title })
  await expect(card).toBeVisible()
  return card
}

/** Every image the API lists under `title` (the one question three helpers below ask). */
export async function imagesTitled(request: APIRequestContext, title: string): Promise<ImageOut[]> {
  const res = await request.get('/api/images')
  expect(res.status(), 'GET /api/images').toBe(200)
  return ((await res.json()) as ImageOut[]).filter((i) => i.title === title)
}

/** Removes every image titled `title` through the API, so a re-run on the same data dir starts
 *  clean. With a `page`, the list on screen is reloaded to agree (a stale card would still match
 *  a selector) — only when something was actually deleted, so a cleanup hook on a clean install
 *  costs nothing. */
export async function deleteImageIfPresent(
  request: APIRequestContext,
  title: string,
  page?: Page
): Promise<void> {
  const images = await imagesTitled(request, title)
  for (const img of images) {
    expect((await request.delete(`/api/images/${img.id}`)).status(), `DELETE ${title}`).toBe(204)
  }
  if (images.length > 0 && page) {
    await page.reload()
    await expect(page.locator('article.card', { hasText: title })).toHaveCount(0)
  }
}

/** Returns the card for `title`, uploading and solving the fixture first if it is not there.
 *  Assumes the signed-in image list is already open. Asks the API whether the image exists: a
 *  card count of 0 is also what a list that has not rendered yet looks like, and that would
 *  upload a second copy. */
export async function ensureSolvedImage(page: Page, title = 'Orion'): Promise<Locator> {
  const card =
    (await imagesTitled(page.request, title)).length > 0
      ? page.locator('article.card', { hasText: title })
      : await uploadImage(page, title)
  await expect(card.locator('.badge')).toHaveText('Solved', { timeout: 60_000 })
  await expect(card.getByText(/[1-9]\d* objects/)).toBeVisible()
  return card
}

/** Exports `card` unless it has an annotated preview already, and returns that preview's URL.
 *  `title` must be the same one passed to `ensureSolvedImage` for this card, so the selector
 *  matches this card's own annotated image and not another card's. */
export async function ensureExported(card: Locator, title = 'Orion'): Promise<string> {
  const img = card.locator(`img[alt="${title} annotated"]`)
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
