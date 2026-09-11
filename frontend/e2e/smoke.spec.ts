import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PASSWORD = 'e2e-password-1'
const FIXTURE = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'field.jpg')

// One story, in order: a fresh install is set up, an image is solved and exported, the
// config page changes the title, and signing out closes the door. Every step is one the
// blank-page regression (#11) would have broken.
test.describe.configure({ mode: 'serial' })

test('first run: setup, sign in, solve, export, config, sign out', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/setup$/)
  await page.getByLabel('Password (at least 8 characters)').fill(PASSWORD)
  await page.getByLabel('Password again').fill(PASSWORD)
  await page.getByLabel('Site title (optional)').fill('E2E sky')
  await page.getByRole('button', { name: 'Finish setup' }).click()
  await expect(page).toHaveURL(/\/login$/)

  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('E2E sky')

  await page.locator('input[type=file]').setInputFiles(FIXTURE)
  await page.getByPlaceholder('Title (optional)').fill('Orion')
  await page.getByRole('button', { name: 'Upload & solve' }).click()
  const card = page.locator('article.card', { hasText: 'Orion' })
  await expect(card.locator('.badge')).toHaveText('Solved', { timeout: 60_000 })
  await expect(card.getByText(/\d+ objects/)).toBeVisible()

  await card.getByRole('button', { name: 'Export' }).click()
  await expect(card.locator('img[alt="Orion annotated"]')).toBeVisible({ timeout: 60_000 })
  await expect(card.getByRole('link', { name: 'Download full-resolution export' })).toBeVisible()

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
})
