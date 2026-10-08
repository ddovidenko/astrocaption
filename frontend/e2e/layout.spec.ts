import { expect, test } from './fixtures'
import type { Page } from '@playwright/test'
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
      const phoneCard = page.locator('article.card', { hasText: 'Orion' })
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
