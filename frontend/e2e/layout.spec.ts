import { expect, test } from './fixtures'
import type { Page, Route } from '@playwright/test'
import { deleteImageIfPresent, ensureExported, ensureSetUpAndSignedIn, ensureSolvedImage, imagesTitled } from './helpers'

// A title with no spaces (the filename stem is the default title, #175) must wrap or truncate,
// never widen the page. Checked wherever a title is a heading: the owner's card, the editor
// toolbar and the public image view.
const LONG = 'M16_M17_IC4703_NGC6605_IC4707_IC4706_NGC6596_IC4701_NGC6561_OSC_ALPT_Siril_master_aligned_stretched_GraXpert_Photoshop_Lightroom_v002_small'

async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(widths.scroll, `${where}: page scroll width vs viewport`).toBeLessThanOrEqual(widths.client)
}

/** Makes every autosave fail until it is taken off again, so the toolbar shows a save problem (a
 *  sentence and a Retry button) for as long as a spec wants to look at it. */
const ANNOTATIONS = '**/api/images/*/annotations'
async function failSaves(route: Route): Promise<void> {
  if (route.request().method() !== 'PUT') return route.fallback()
  await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Internal error' }) })
}

test('a long unbroken title never widens the page', async ({ page, browser }) => {
  await ensureSetUpAndSignedIn(page)
  await deleteImageIfPresent(page.request, LONG, page)
  const card = await ensureSolvedImage(page, LONG)
  const [image] = await imagesTitled(page.request, LONG)
  expect(image).toBeTruthy()
  try {
    await expectNoHorizontalOverflow(page, 'images page')
    await expect(card.getByRole('heading', { level: 3 })).toBeInViewport({ ratio: 1 })
    // The delete confirmation quotes the title and must wrap as well.
    await card.getByRole('button', { name: 'Delete' }).click()
    await expect(card.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await expectNoHorizontalOverflow(page, 'images page, delete confirmation')
    await card.getByRole('button', { name: 'Cancel' }).click()

    await card.getByRole('link', { name: 'Edit' }).click()
    await expect(page).toHaveURL(new RegExp(`/images/${image!.id}$`))
    await expect(page.getByRole('button', { name: 'Fit' })).toBeVisible()
    await expectNoHorizontalOverflow(page, 'editor')
    await expect(page.getByRole('button', { name: 'Fit' })).toBeInViewport({ ratio: 1 })
    // On a desktop the editor keeps the site header and the whole toolbar (the phone block below
    // is where they are slimmed down).
    await expect(page.locator('#root > header')).toBeVisible()
    await expect(page.getByRole('button', { name: '100 %' })).toBeVisible()
    await expect(page.locator('.editor-toolbar .zoom-readout')).toBeVisible()
    // The toolbar is one row, and only the title gives way when it is short of room: a window
    // that is narrow but not a phone's, a long title, and the save state at its longest. Nothing
    // else may be squeezed (a squeezed "100 %" drops its % sign to a second line), and nothing may
    // move when the state changes from "Saved" to "Unsaved changes" and back.
    await page.setViewportSize({ width: 900, height: 800 })
    const height = async (selector: string) => (await page.locator(selector).boundingBox())!.height
    const fit = page.getByRole('button', { name: 'Fit' })
    const actual = page.getByRole('button', { name: '100 %' })
    const status = page.locator('.editor-toolbar .save-status')
    await expect(status).toHaveText('Saved')
    const fitBefore = (await fit.boundingBox())!
    // Written into the page, not waited for: the real state lasts as long as the autosave debounce.
    await status.evaluate((el) => (el.textContent = 'Unsaved changes'))
    const fitAfter = (await fit.boundingBox())!
    expect((await actual.boundingBox())!.height, '"100 %" wrapped').toBe(fitAfter.height)
    expect(await height('.editor-toolbar .zoom-readout'), 'the zoom readout wrapped').toBeLessThan(24)
    expect(await height('.editor-toolbar .save-status'), 'the save state wrapped').toBeLessThan(24)
    expect(fitAfter.x, 'the buttons moved when the save state changed').toBe(fitBefore.x)
    expect((await page.locator('.editor-toolbar').boundingBox())!.height).toBeLessThanOrEqual(60)
    await expectNoHorizontalOverflow(page, 'editor, narrow desktop window')
    await status.evaluate((el) => (el.textContent = 'Saved'))
    // A save problem is a sentence and a button. The title gives way to it first: the sentence is
    // not squeezed into a column while the title keeps its room, and the button stays inside it.
    await page.route(ANNOTATIONS, failSaves)
    const anObject = page.getByRole('checkbox', { name: /^Show / }).first()
    await anObject.click()
    const problem = page.locator('.editor-toolbar .save-status.error')
    await expect(problem).toBeVisible()
    const retry = problem.getByRole('button')
    await expect(retry).toBeInViewport({ ratio: 1 })
    const bar = (await page.locator('.editor-toolbar').boundingBox())!
    const problemBox = (await problem.boundingBox())!
    const retryBox = (await retry.boundingBox())!
    // There is room for the sentence on one line once the title has given way; squeezed, it
    // breaks into a column of words.
    const lines = await problem.evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el.firstChild!)
      return new Set(Array.from(range.getClientRects(), (r) => Math.round(r.top))).size
    })
    expect(lines, 'the save problem was squeezed').toBe(1)
    expect(retryBox.x + retryBox.width, 'the button spilled out of the save problem').toBeLessThanOrEqual(problemBox.x + problemBox.width + 0.5)
    expect(problemBox.x + problemBox.width).toBeLessThanOrEqual(bar.x + bar.width)
    expect((await actual.boundingBox())!.height, '"100 %" wrapped beside a save problem').toBe(fitAfter.height)
    await expectNoHorizontalOverflow(page, 'editor, save problem')
    await page.unroute(ANNOTATIONS, failSaves)
    await retry.click()
    await expect(status).toHaveText('Saved')
    await anObject.click()
    await expect(status).toHaveText('Saved')
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.getByRole('link', { name: '← Images' }).click()

    const cardAgain = page.locator('article.card', { hasText: LONG })
    await ensureExported(cardAgain, LONG)
    await cardAgain.getByRole('button', { name: 'Publish' }).click()
    await expect(cardAgain.getByText('Published')).toBeVisible()

    const visitor = await browser.newContext()
    const pub = await visitor.newPage()
    try {
      await pub.goto(`/gallery/${image!.id}`)
      await expect(pub.getByRole('heading', { level: 2 })).toHaveText(LONG)
      await expectNoHorizontalOverflow(pub, 'public image view')
      await pub.goto('/')
      await expectNoHorizontalOverflow(pub, 'public gallery')
    } finally {
      await visitor.close()
    }
  } finally {
    await deleteImageIfPresent(page.request, LONG)
  }
})

// A phone (#169): the owner's pages, the editor and the visitor's pages at 390 px, the width of
// most iPhones in portrait. Nothing may need a horizontal scroll.
test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })

  test('no page needs a horizontal scroll', async ({ page, browser }) => {
    await ensureSetUpAndSignedIn(page)
    const card = await ensureSolvedImage(page, 'Orion')
    await ensureExported(card, 'Orion')
    const [image] = await imagesTitled(page.request, 'Orion')
    expect(image).toBeTruthy()
    await page.request.put(`/api/images/${image!.id}/published`, { data: { published: true } })
    try {
      await page.goto('/')
      await expect(page.locator('article.card', { hasText: 'Orion' })).toBeVisible()
      await expectNoHorizontalOverflow(page, 'images page')
      await expect(page.getByRole('button', { name: 'Log out' })).toBeInViewport({ ratio: 1 })
      // The filter groups collapse behind a Filters button on a phone (#229); the search box stays.
      await expect(page.getByRole('searchbox', { name: 'Search images' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Nebulae' })).toBeHidden()
      await page.getByRole('button', { name: 'Filters' }).click()
      await expect(page.getByRole('button', { name: 'Nebulae' })).toBeVisible()
      await expectNoHorizontalOverflow(page, 'images page, filters open')
      await page.getByRole('button', { name: 'Filters' }).click()
      await expect(page.getByRole('button', { name: 'Nebulae' })).toBeHidden()
      const phoneCard = page.locator('article.card', { hasText: 'Orion' })
      // With the groups collapsed there is room for the card's upload day again.
      await expect(phoneCard.locator('.upload-day')).toBeVisible()
      await expect(phoneCard.getByRole('button', { name: 'Delete' })).toBeInViewport({ ratio: 1 })
      await phoneCard.getByRole('button', { name: 'Delete' }).click()
      await expect(phoneCard.getByRole('button', { name: 'Cancel' })).toBeInViewport({ ratio: 1 })
      await expectNoHorizontalOverflow(page, 'images page, delete confirmation')
      await phoneCard.getByRole('button', { name: 'Cancel' }).click()

      await page.goto('/config')
      await expect(page.getByLabel('Site title')).toBeVisible()
      await expectNoHorizontalOverflow(page, 'config page')

      await page.goto(`/images/${image!.id}`)
      await expect(page.getByRole('button', { name: 'Fit' })).toBeVisible()
      await expectNoHorizontalOverflow(page, 'editor')
      await expect(page.getByText('Saved')).toBeInViewport({ ratio: 1 })
      // The side panel starts closed on a phone, so the canvas has the width.
      await expect(page.locator('.side-panel.collapsed')).toBeVisible()
      await expect(page.locator('.editor-canvas')).toHaveJSProperty('clientWidth', 390 - 32)
      // ...and the height (#57, SPEC § 6.5): in a compact editor the site header is put away and
      // the toolbar is one row of finger-sized controls, so the photo starts near the top of the
      // screen instead of 330 px down it.
      await expect(page.locator('#root > header')).toBeHidden()
      const toolbar = (await page.locator('.editor-toolbar').boundingBox())!
      expect(toolbar.y).toBe(0)
      expect(toolbar.height).toBeLessThanOrEqual(60)
      // The canvas pane starts right under it; inside the pane only a notice (a sentence about
      // this image, when there is one) sits above the photo.
      expect((await page.locator('.editor-body').boundingBox())!.y).toBeLessThanOrEqual(64)
      const back = page.getByRole('link', { name: '← Images' })
      const controls = [back, ...['Fit', 'Undo', 'Redo'].map((name) => page.getByRole('button', { name, exact: true }))]
      for (const control of controls) {
        await expect(control).toBeInViewport({ ratio: 1 })
        const box = (await control.boundingBox())!
        expect(Math.min(box.width, box.height), `${await control.getAttribute('class')} is too small for a finger`).toBeGreaterThanOrEqual(44)
      }
      await expect(page.getByRole('button', { name: '100 %' })).toBeHidden()
      await expect(page.locator('.editor-toolbar .zoom-readout')).toBeHidden()
      // The title still shows, cut short, and names the image.
      await expect(page.locator('.editor-toolbar strong')).toBeInViewport({ ratio: 1 })
      expect((await page.locator('.editor-toolbar strong').boundingBox())!.width).toBeGreaterThan(40)
      // The save state at its longest moves no control (they are under a finger) and adds no row.
      const before = await Promise.all(controls.map(async (c) => (await c.boundingBox())!.x))
      const status = page.locator('.editor-toolbar .save-status')
      await status.evaluate((el) => (el.textContent = 'Unsaved changes'))
      expect(await Promise.all(controls.map(async (c) => (await c.boundingBox())!.x))).toEqual(before)
      expect((await page.locator('.editor-toolbar').boundingBox())!.height).toBeLessThanOrEqual(60)
      await expect(status).toBeInViewport({ ratio: 1 })
      await expectNoHorizontalOverflow(page, 'editor, unsaved')
      await status.evaluate((el) => (el.textContent = 'Saved'))
      // A save problem takes a row of its own under the controls, with a finger-sized button.
      await page.route(ANNOTATIONS, failSaves)
      await page.getByRole('button', { name: 'Expand panel' }).click()
      const anObject = page.getByRole('checkbox', { name: /^Show / }).first()
      await anObject.click()
      await page.getByRole('button', { name: 'Collapse panel' }).click()
      const problem = page.locator('.editor-toolbar .save-status.error')
      await expect(problem).toBeVisible()
      const fitBox = (await page.getByRole('button', { name: 'Fit' }).boundingBox())!
      expect((await problem.boundingBox())!.y, 'the save problem is not on its own row').toBeGreaterThanOrEqual(fitBox.y + fitBox.height)
      const retry = problem.getByRole('button')
      await expect(retry).toBeInViewport({ ratio: 1 })
      expect((await retry.boundingBox())!.height, 'Retry is too small for a finger').toBeGreaterThanOrEqual(44)
      expect(await Promise.all(controls.map(async (c) => (await c.boundingBox())!.x))).toEqual(before)
      await expectNoHorizontalOverflow(page, 'editor, save problem')
      await page.unroute(ANNOTATIONS, failSaves)
      await retry.click()
      await expect(status).toHaveText('Saved')
      await page.getByRole('button', { name: 'Expand panel' }).click()
      await anObject.click()
      await page.getByRole('button', { name: 'Collapse panel' }).click()
      await expect(status).toHaveText('Saved')

      const visitor = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
      const pub = await visitor.newPage()
      try {
        await pub.goto('/')
        await expect(pub.locator('.gallery-card', { hasText: 'Orion' })).toBeVisible()
        await expectNoHorizontalOverflow(pub, 'public gallery')
        await pub.goto(`/gallery/${image!.id}`)
        await expect(pub.getByRole('heading', { level: 2 })).toHaveText('Orion')
        await expectNoHorizontalOverflow(pub, 'public image view')
        await expect(pub.getByRole('link', { name: 'Back to the gallery' })).toBeInViewport({ ratio: 1 })
        await pub.goto('/login')
        await expect(pub.getByLabel('Password')).toBeVisible()
        await expectNoHorizontalOverflow(pub, 'login page')
      } finally {
        await visitor.close()
      }
    } finally {
      await page.request.put(`/api/images/${image!.id}/published`, { data: { published: false } })
    }
  })
})
