import { expect, test } from './fixtures'
import { ensureExported, ensureSetUpAndSignedIn, ensureSolvedImage, imagesTitled } from './helpers'

// The visitor's side of SPEC § 5.5: an exported image is published from its card, a signed-out
// browser finds it on `/`, hovering swaps to the annotated preview, the full view downloads the
// export, and an unpublished image is a plain 404 page. Runs against the built bundle (`make e2e`).
test('publish, gallery hover, full view download, unpublish', async ({ page, browser }) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page, 'Orion')
  await ensureExported(card, 'Orion')
  const [image] = await imagesTitled(page.request, 'Orion')
  expect(image).toBeTruthy()

  try {
    await card.getByRole('button', { name: 'Publish' }).click()
    await expect(card.getByText('Published')).toBeVisible()
    await expect(card.getByRole('button', { name: 'Unpublish' })).toBeVisible()

    // A second, cookie-less browser context is the visitor.
    const visitor = await browser.newContext()
    const pub = await visitor.newPage()
    try {
      await pub.goto('/')
      await expect(pub).toHaveURL(/\/$/)
      await expect(pub.getByRole('link', { name: 'Log in' })).toBeVisible()
      const galleryCard = pub.locator('.gallery-card', { hasText: 'Orion' })
      await expect(galleryCard).toBeVisible()

      const overlay = galleryCard.locator('img.overlay')
      await expect(overlay).toHaveCSS('opacity', '0')
      await galleryCard.hover()
      await expect(overlay).toHaveCSS('opacity', '1')
      await expect(overlay).toHaveAttribute('src', /\/api\/gallery\/.*\/files\/annotated-preview\?v=/)
      await expect.poll(() => overlay.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0)

      await galleryCard.click()
      await expect(pub).toHaveURL(new RegExp(`/gallery/${image.id}$`))
      const download = pub.getByRole('link', { name: /^Download annotated image/ })
      const href = await download.getAttribute('href')
      expect(href).toBeTruthy()
      const res = await pub.request.get(href!)
      expect(res.status()).toBe(200)
      expect(res.headers()['content-type']).toContain('image/jpeg')
      expect(res.headers()['content-disposition']).toContain('Orion-annotated.jpg')

      // The owner-only files stay closed to the visitor.
      expect((await pub.request.get(`/api/images/${image.id}/files/original`)).status()).toBe(401)
      expect((await pub.request.get('/api/images')).status()).toBe(401)

      // Unpublish from the owner's tab; the visitor's next load says so.
      await card.getByRole('button', { name: 'Unpublish' }).click()
      await expect(card.getByRole('button', { name: 'Publish' })).toBeVisible()
      await pub.reload()
      await expect(pub.getByText('This image is not published.')).toBeVisible()
      await pub.getByRole('link', { name: 'Back to the gallery' }).click()
      await expect(pub.getByText('Nothing published yet.')).toBeVisible()
    } finally {
      await visitor.close()
    }
  } finally {
    // Leave the shared data dir as it was found, whatever failed above (#116).
    await page.request.put(`/api/images/${image.id}/published`, { data: { published: false } })
  }
})
