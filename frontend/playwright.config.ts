import { defineConfig, devices } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
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
const dataDir = startApp ? (process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'astrocaption-e2e-'))) : ''
process.env.E2E_DATA_DIR_CREATED = startApp && !process.env.E2E_DATA_DIR ? dataDir : ''
if (startApp) process.env.E2E_DATA_DIR = dataDir

const backend = resolve(fileURLToPath(new URL('..', import.meta.url)), 'backend')

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
  globalTeardown: './e2e/global-teardown.ts',
  webServer: [
    {
      command: 'node e2e/fake-nova.mjs',
      url: `http://127.0.0.1:${novaPort}/`,
      env: { FAKE_NOVA_PORT: novaPort, FAKE_NOVA_HOST: novaHost },
      reuseExistingServer: false,
      timeout: 15_000,
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
            },
            reuseExistingServer: false,
            timeout: 30_000,
          },
        ]
      : []),
  ],
})
