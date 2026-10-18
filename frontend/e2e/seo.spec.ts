import { expect, test } from './fixtures'
import { ensureExported, ensureSetUpAndSignedIn, ensureSolvedImage, imagesTitled } from './helpers'

// What a crawler or a link-preview bot gets without running the app (#187): the built shell
// carries the title, description and preview-card image of a published image, the sitemap
// lists it, and an unpublished image is a 404 shell. Runs against the built bundle (`make e2e`).
test('the shell carries head tags for a published image and the sitemap lists it', async ({ page }) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page, 'Orion')
  await ensureExported(card, 'Orion')
  const [image] = await imagesTitled(page.request, 'Orion')
  expect(image).toBeTruthy()

  try {
    await card.getByRole('button', { name: 'Publish' }).click()
    await expect(card.getByRole('button', { name: 'Unpublish' })).toBeVisible()

    // `page.request` carries the owner's cookie; the public routes do not care.
    const res = await page.request.get(`/gallery/${image!.id}`)
    expect(res.status()).toBe(200)
    const origin = new URL(res.url()).origin
    const html = await res.text()
    expect(html).toContain('<title>Orion · ')
    expect(html).toMatch(/<meta name="description" content="[^"]*M 42[^"]*Annotated astrophoto, uploaded \d{1,2} \w{3} \d{4}\." \/>/)
    expect(html).toContain(`<meta property="og:image" content="${origin}/api/gallery/${image!.id}/files/annotated-preview?v=`)
    expect(html).toContain(`<link rel="canonical" href="${origin}/gallery/${image!.id}" />`)

    const gallery = await (await page.request.get('/gallery?q=orion')).text()
    expect(gallery).toContain(`<link rel="canonical" href="${origin}/gallery" />`)

    const sitemap = await page.request.get('/sitemap.xml')
    expect(sitemap.headers()['content-type']).toContain('application/xml')
    expect(await sitemap.text()).toContain(`${origin}/gallery/${image!.id}</loc>`)
    expect(await (await page.request.get('/robots.txt')).text()).toContain(`Sitemap: ${origin}/sitemap.xml`)

    // The app still loads on a direct hit and keeps the same title once it runs.
    await page.goto(`/gallery/${image!.id}`)
    await expect(page.getByRole('link', { name: /^Download annotated image/ })).toBeVisible()
    await expect(page).toHaveTitle(/^Orion · /)
  } finally {
    // Leave the shared data dir as it was found, whatever failed above (#116).
    await page.request.put(`/api/images/${image!.id}/published`, { data: { published: false } })
  }

  const gone = await page.request.get(`/gallery/${image!.id}`)
  expect(gone.status()).toBe(404)
  expect(await gone.text()).not.toContain('og:image')
  expect(await (await page.request.get('/sitemap.xml')).text()).not.toContain(`/gallery/${image!.id}</loc>`)
})
