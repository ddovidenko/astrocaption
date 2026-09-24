import type { HealthOut } from '../src/api'
import { expect, test } from './fixtures'

// The Vite dev server, not the built bundle: `/api` and `/fonts` must reach the backend through
// the proxy in vite.config.ts. Without it Vite answers index.html for /api/health, the shell's
// JSON parse fails, and the page stays blank (#11, #52). State-agnostic: the data dir may or may
// not be set up. `.dev.spec.ts` keeps it out of the `chromium` project (playwright.config.ts).
test('the dev server proxies /api and /fonts, and the app mounts', async ({ page, baseURL }) => {
  // Every URL below is only meaningful against the Vite server this project's baseURL points at.
  expect(test.info().project.name).toBe('dev-proxy')

  // Vite itself is answering, not the bundle uvicorn serves: this module exists only in dev.
  const client = await page.request.get(`${baseURL}/@vite/client`)
  expect(client.status(), 'GET /@vite/client').toBe(200)
  expect(client.headers()['content-type']).toContain('javascript')

  const health = await page.request.get(`${baseURL}/api/health`)
  expect(health.status(), 'GET /api/health through the proxy').toBe(200)
  expect(health.headers()['content-type']).toContain('application/json')
  const body = (await health.json()) as HealthOut
  expect(body.status).toBe('ok')

  // /fonts is the second proxied prefix, and the editor is unusable without it.
  const font = await page.request.get(`${baseURL}/fonts/Inter-Regular.ttf`)
  expect(font.status(), 'GET /fonts/Inter-Regular.ttf through the proxy').toBe(200)
  expect(font.headers()['content-type']).toContain('font/ttf')

  // Where the shell sends a fresh browser, given what health just said: /setup until the site is
  // set up, otherwise `/` whether signed in (Images) or not (the public gallery).
  const landing = body.setup_required ? /\/setup$/ : /\/$/
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page).toHaveURL(landing)
})
