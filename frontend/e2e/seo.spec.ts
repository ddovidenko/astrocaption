import { expect, test } from './fixtures'
import { ensureExported, ensureSetUpAndSignedIn, ensureSolvedImage, imagesTitled } from './helpers'

// What a crawler or a link-preview bot gets without running the app (#187): the real built
// shell carries the title, description, canonical link and preview-card image of a published
// image, and the app keeps that title once it runs. The sitemap, robots and the 404 shell are
// pinned in backend/tests/test_seo.py; they run no frontend code. Built bundle (`make e2e`).
test('the built shell carries head tags for a published image', async ({ page }) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page, 'Orion')
  await ensureExported(card, 'Orion')
  const [image] = await imagesTitled(page.request, 'Orion')
  expect(image).toBeTruthy()
  const id = image!.id

  try {
    await card.getByRole('button', { name: 'Publish' }).click()
    await expect(card.getByRole('button', { name: 'Unpublish' })).toBeVisible()

    // `page.request` carries the owner's cookie; the public routes do not care.
    const res = await page.request.get(`/gallery/${id}`)
    expect(res.status()).toBe(200)
    const origin = new URL(res.url()).origin
    const html = await res.text()
    expect(html).toContain('<title>Orion · ')
    expect(html).toMatch(/<meta name="description" content="[^"]*M 42[^"]*uploaded \d{1,2} \w{3} \d{4}\." \/>/)
    expect(html).toContain(`<meta property="og:image" content="${origin}/api/gallery/${id}/files/annotated-preview?v=`)
    expect(html).toContain(`<link rel="canonical" href="${origin}/gallery/${id}" />`)
    expect(html).not.toContain('<!--app-head-->')

    // The app still loads on a direct hit and keeps the same title once it runs.
    await page.goto(`/gallery/${id}`)
    await expect(page.getByRole('link', { name: /^Download annotated image/ })).toBeVisible()
    await expect(page).toHaveTitle(/^Orion · /)
  } finally {
    // Leave the shared data dir as it was found, whatever failed above (#116).
    await page.request.put(`/api/images/${id}/published`, { data: { published: false } })
  }
})
