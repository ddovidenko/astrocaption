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
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${appPort}`
// Only mint a scratch data dir when this config is the one starting the app: CI supplies
// E2E_BASE_URL for an already-running container and never touches E2E_DATA_DIR, so creating
// one here (e.g. for `--list`) would just leak a directory nothing ever cleans up.
const suppliedDataDir = process.env.E2E_DATA_DIR?.trim()
const dataDir = startApp ? suppliedDataDir || mkdtempSync(join(tmpdir(), 'astrocaption-e2e-')) : ''
if (startApp) {
  process.env.E2E_DATA_DIR = dataDir
  // Only the process that minted this dir cleans it up. Playwright registers webServer setup
  // before globalTeardown, so a webServer that fails to start (busy port, missing venv) would
  // leave the dir behind under that mechanism; an exit hook covers that path too.
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
  // A full solve plus a full-resolution Pillow render on a shared runner: bigger than the
  // two 60s step budgets the spec waits on, so it never clips a step that is merely slow.
  timeout: 240_000,
  expect: { timeout: 15_000 },
  // The run is stateful (first-run setup happens once per data dir), so a retry cannot
  // recreate it: attempt 2 would deterministically fail at the /setup redirect and bury
  // whatever actually broke in attempt 1.
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
            command: `${backend}/.venv/bin/uvicorn app.main:app --port ${appPort}`,
            cwd: backend,
            url: `${baseURL}/api/health`,
            env: {
              ASTROCAPTION_DATA_DIR: dataDir,
              ASTROCAPTION_STATIC_DIR: `${backend}/static`,
              NOVA_BASE_URL: `http://127.0.0.1:${novaPort}`,
              NOVA_API_KEY: 'fixture',
              // The app inherits the developer's environment; pin these empty so none of them
              // locks the field the spec edits (empty is treated as unset, see _from_env in
              // backend/app/config.py).
              ASTROCAPTION_SITE_TITLE: '',
              ASTROCAPTION_MAX_UPLOAD_MB: '',
              ASTROMETRY_API_KEY: '',
            },
            reuseExistingServer: false,
            timeout: 30_000,
          },
        ]
      : []),
  ],
})
