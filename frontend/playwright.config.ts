import { defineConfig, devices } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Local runs (`make e2e`, E2E_START_APP=1): Playwright starts the fake nova and uvicorn on a
// scratch data dir serving the built frontend. CI starts the Docker image itself and points
// E2E_BASE_URL at it; the fake nova is still started here, on 0.0.0.0 so the container can
// reach it through host.docker.internal.
const startApp = process.env.E2E_START_APP === '1'
const appPort = 8765
const novaPort = process.env.FAKE_NOVA_PORT ?? '8901'
const novaHost = process.env.FAKE_NOVA_HOST ?? '127.0.0.1'
// When this config starts the app, the spec must talk to that app and nothing else: a
// stray E2E_BASE_URL pointing at a dev server would otherwise pass readiness and be driven
// through setup and uploads against real data.
const baseURL = startApp ? `http://127.0.0.1:${appPort}` : process.env.E2E_BASE_URL?.trim() || `http://127.0.0.1:${appPort}`
// Only mint a scratch data dir when this config is the one starting the app: CI supplies
// E2E_BASE_URL for an already-running container and never touches E2E_DATA_DIR, so creating
// one here (e.g. for `--list`) would just leak a directory nothing ever cleans up.
const suppliedDataDir = process.env.E2E_DATA_DIR?.trim()
const dataDir = startApp ? suppliedDataDir || mkdtempSync(join(tmpdir(), 'astrocaption-e2e-')) : ''
if (startApp) {
  process.env.E2E_DATA_DIR = dataDir
  // Only the process that minted this dir cleans it up. An exit hook (rather than Playwright's
  // globalTeardown) also runs when a webServer fails to start: busy port, missing venv.
  if (!suppliedDataDir) {
    process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }))
  }
}

const backend = resolve(fileURLToPath(new URL('..', import.meta.url)), 'backend')
if (startApp && !existsSync(join(backend, 'static', 'index.html'))) {
  throw new Error('backend/static is missing; run `make e2e` (it builds the frontend first)')
}

export default defineConfig({
  testDir: 'e2e',
  // The run is one stateful story on one data dir: two workers would both attempt first-run
  // setup, and a parallel file would upload a second copy of the fixture image.
  fullyParallel: false,
  workers: 1,
  // A full solve plus a full-resolution Pillow render on a shared runner: bigger than the
  // two 60s step budgets the spec waits on, so it never clips a step that is merely slow.
  timeout: 240_000,
  expect: { timeout: 15_000 },
  // The run is stateful (first-run setup happens once per data dir): a retry finds that setup
  // already done and the helpers are idempotent about it, so attempt 2 would not fail at the
  // /setup redirect — it would just silently rerun against the state attempt 1 left behind and
  // could hide a real flake. Retries stay 0 so a failure is reported, not buried.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/fake-nova.mjs',
      url: `http://127.0.0.1:${novaPort}/`,
      env: { FAKE_NOVA_PORT: novaPort, FAKE_NOVA_HOST: novaHost },
      reuseExistingServer: false,
      timeout: 15_000,
      stdout: 'pipe',
    },
    ...(startApp
      ? [
          {
            // Playwright always merges the developer's shell into a webServer's env, and any
            // ASTROCAPTION_* / TRUST_PROXY / API-key variable there would lock a field the spec
            // edits or change the first-run flow, so uvicorn gets a closed environment instead.
            command: [
              'env -i',
              `PATH="${process.env.PATH}"`,
              `HOME="${process.env.HOME}"`,
              `ASTROCAPTION_DATA_DIR="${dataDir}"`,
              `ASTROCAPTION_STATIC_DIR="${backend}/static"`,
              `NOVA_BASE_URL=http://127.0.0.1:${novaPort}`,
              'NOVA_API_KEY=fixture',
              `${backend}/.venv/bin/uvicorn app.main:app --port ${appPort}`,
            ].join(' '),
            cwd: backend,
            url: `${baseURL}/api/health`,
            reuseExistingServer: false,
            timeout: 30_000,
          },
        ]
      : []),
  ],
})
