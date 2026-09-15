import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures'
import { deleteImageIfPresent, ensureSetUpAndSignedIn, imagesTitled, uploadImage } from './helpers'

// Runs last (the files are ordered alphabetically): the Orion story is already on the data dir,
// so the upload counts below are the only ones this spec has to reason about. Mode leakage is no
// longer part of that order — fixtures.ts resets the fake nova after every test.
//
// The deadline the timeout step waits for is the app's, not Playwright's: uvicorn and the CI
// container both read it from frontend/e2e/app.env.
const TITLE = 'Doomed'

/** This card's own solve error. The card's action errors use the same class, so take the first:
 *  the solve's own sentence is rendered above them. */
const solveError = (card: Locator): Locator => card.locator('p.error').first()

// Independent of what the test itself did, and reported alongside a failure rather than instead
// of it: a second run on the same data dir has to start clean. Resetting the fake nova's mode is
// the fixture's job, not this hook's.
test.afterEach(async ({ page }) => {
  await deleteImageIfPresent(page.request, TITLE)
})

test('a failed solve, a timed-out re-solve, and Check again back to solved', async ({ page, fakeNova }) => {
  await ensureSetUpAndSignedIn(page)
  await deleteImageIfPresent(page.request, TITLE, page)

  const card = await test.step('nova reports failure', async () => {
    // Plain language, nova links, and no Check again: a failed job is not resumable.
    await fakeNova.setMode('failure')
    const card = await uploadImage(page, TITLE)
    await expect(card.locator('.badge')).toHaveText('Failed', { timeout: 60_000 })
    await expect(solveError(card)).toContainText('could not solve')
    // No server path and no raw exception text reaches the page (CLAUDE.md).
    await expect(solveError(card)).not.toContainText(/\/home\/|\/app\/|Traceback|Error:/)
    await expect(card.getByRole('link', { name: 'nova status' })).toHaveAttribute('href', /\/status\/\d+$/)
    await expect(card.getByRole('link', { name: 'nova job log' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Check again' })).toHaveCount(0)
    return card
  })

  await test.step('re-solve times out', async () => {
    // The app's deadline passes while nova is still "solving" → timed out, and that is the one
    // failure the row offers to resume.
    await fakeNova.setMode('timeout')
    await card.getByRole('button', { name: 'Re-solve' }).click()
    await expect(card.locator('.badge')).toHaveText(/Queued|Solving…/)
    await expect(card.locator('.badge')).toHaveText('Failed', { timeout: 60_000 })
    await expect(solveError(card)).toContainText('Timed out')
    await expect(solveError(card)).toContainText('use Check again')
    await expect(solveError(card)).not.toContainText(/\/home\/|\/app\/|Traceback|Error:/)
    await expect(card.getByRole('button', { name: 'Check again' })).toBeVisible()
  })

  await test.step('Check again resumes', async () => {
    // The stored job is polled again; nova now answers success, and nothing is uploaded.
    await fakeNova.setMode('success')
    const submissionId = async (): Promise<number | null | undefined> =>
      (await imagesTitled(page.request, TITLE))[0]?.nova_submission_id
    const before = await submissionId()
    expect(before).toBeTruthy()
    const uploadsBefore = (await fakeNova.state()).uploads
    // This spec's own two solves (the upload above and the Re-solve); earlier specs may have
    // added one for Orion on a fresh data dir, so the baseline is a floor, not an equality.
    expect(uploadsBefore, 'uploads before Check again').toBeGreaterThanOrEqual(2)
    await card.getByRole('button', { name: 'Check again' }).click()
    await expect(card.locator('.badge')).toHaveText('Solved', { timeout: 60_000 })
    await expect(card.getByText(/[1-9]\d* objects/)).toBeVisible()
    // Same submission, and nova saw no second upload: the stored job was resumed, not redone.
    expect(await submissionId()).toBe(before)
    expect((await fakeNova.state()).uploads).toBe(uploadsBefore)
  })
})
