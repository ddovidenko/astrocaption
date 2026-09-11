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
const dataDir = process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'astrocaption-e2e-'))
process.env.E2E_DATA_DIR_CREATED = process.env.E2E_DATA_DIR ? '' : dataDir
process.env.E2E_DATA_DIR = dataDir

const backend = resolve(fileURLToPath(new URL('..', import.meta.url)), 'backend')

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
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
