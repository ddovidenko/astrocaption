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
