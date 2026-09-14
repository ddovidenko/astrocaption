import { expect, test } from '@playwright/test'

// The Vite dev server, not the built bundle: `/api` must reach the backend through the proxy in
// vite.config.ts. Without it Vite answers index.html for /api/health, the shell's JSON parse
// fails, and the page stays blank (#11, #52). State-agnostic: the data dir may or may not be set up.
test('the dev server proxies /api and the app mounts', async ({ page, baseURL }) => {
  const res = await page.request.get(`${baseURL}/api/health`)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toContain('application/json')
  expect(((await res.json()) as { status: string }).status).toBe('ok')

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page).toHaveURL(/\/(setup|login)?$/)
  expect(errors).toEqual([])
})
