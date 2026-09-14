import { expect, test } from '@playwright/test'
import type { ImageOut } from '../src/api'
import {
  deleteImageIfPresent,
  ensureSetUpAndSignedIn,
  fakeNovaUploads,
  setFakeNovaMode,
  uploadImage,
} from './helpers'

// Runs last (the files are ordered alphabetically): the Orion story is already on the data dir,
// so a fake-nova mode left dirty by a failure here cannot break an earlier spec. This spec owns
// its own scratch image and deletes it again, so a second run on the same data dir starts clean.
//
// The deadline the timeout step waits for is the app's, not Playwright's: uvicorn is started
// with ASTROCAPTION_SOLVE_TIMEOUT_SECONDS=12 (playwright.config.ts; the CI container gets the
// same through `docker run -e`).
const TITLE = 'Doomed'

test('a failed solve, a timed-out re-solve, and Check again back to solved', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await ensureSetUpAndSignedIn(page)
  await deleteImageIfPresent(page, TITLE)
  try {
    // 1. nova reports the job failed: plain language, nova links, no Check again (not resumable).
    await setFakeNovaMode(page, 'failure')
    const card = await uploadImage(page, TITLE)
    await expect(card.locator('.badge')).toHaveText('Failed', { timeout: 60_000 })
    // The card's own action errors use the same class, so take the first: the solve's own
    // sentence is rendered above them.
    const message = card.locator('p.error').first()
    await expect(message).toContainText('could not solve')
    // No server path and no raw exception text reaches the page (CLAUDE.md).
    await expect(message).not.toContainText(/\/home\/|\/app\/|Traceback|Error:/)
    await expect(card.getByRole('link', { name: 'nova status' })).toHaveAttribute('href', /\/status\/\d+$/)
    await expect(card.getByRole('link', { name: 'nova job log' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Check again' })).toHaveCount(0)

    // 2. Re-solve while nova never finishes: the deadline (12 s in this stack) passes → timed out,
    // and that is the one failure the row offers to resume.
    await setFakeNovaMode(page, 'timeout')
    await card.getByRole('button', { name: 'Re-solve' }).click()
    await expect(card.locator('.badge')).toHaveText('Solving…')
    await expect(card.locator('.badge')).toHaveText('Failed', { timeout: 60_000 })
    await expect(message).toContainText('Timed out')
    await expect(message).toContainText('use Check again')
    await expect(card.getByRole('button', { name: 'Check again' })).toBeVisible()
    // Off by default: a throwaway run sets it to capture the timed-out card for a review.
    if (process.env.E2E_TIMEOUT_CARD_SHOT) {
      await card.screenshot({ path: process.env.E2E_TIMEOUT_CARD_SHOT })
    }

    // 3. Check again resumes the stored job without a new upload; nova now answers success.
    await setFakeNovaMode(page, 'success')
    const submissionId = async (): Promise<number | null | undefined> => {
      const res = await page.request.get('/api/images')
      expect(res.status()).toBe(200)
      const images = (await res.json()) as ImageOut[]
      return images.find((i) => i.title === TITLE)?.nova_submission_id
    }
    const before = await submissionId()
    expect(before).toBeTruthy()
    const uploadsBefore = await fakeNovaUploads(page)
    await card.getByRole('button', { name: 'Check again' }).click()
    await expect(card.locator('.badge')).toHaveText('Solved', { timeout: 60_000 })
    await expect(card.getByText(/[1-9]\d* objects/)).toBeVisible()
    // Same submission, and nova saw no second upload: the stored job was resumed, not redone.
    expect(await submissionId()).toBe(before)
    expect(await fakeNovaUploads(page)).toBe(uploadsBefore)
  } finally {
    // The image goes first: a fake-nova hiccup while resetting the mode must not skip the
    // cleanup that lets a second run on the same data dir start clean.
    await deleteImageIfPresent(page, TITLE)
    await setFakeNovaMode(page, 'success')
  }
  expect(errors).toEqual([])
})
