import { defineConfig, devices } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Local runs (`make e2e`, E2E_START_APP=1): Playwright starts the fake nova and uvicorn on a
// scratch data dir serving the built frontend. CI starts the Docker image itself and points
// E2E_BASE_URL at it; the fake nova is still started here, on 0.0.0.0 so the container can
// reach it through host.docker.internal.
const startApp = process.env.E2E_START_APP === '1'
// The Vite dev server (and the project that drives it) is opt-in: `make e2e` and the CI step set
// this. An ad-hoc `npx playwright test` then starts no second server and runs the other specs.
const devProxy = process.env.E2E_DEV_PROXY === '1'
const appPort = 8765
const novaPort = process.env.FAKE_NOVA_PORT ?? '8901'
const novaHost = process.env.FAKE_NOVA_HOST ?? '127.0.0.1'
// When this config starts the app, the spec must talk to that app and nothing else: a
// stray E2E_BASE_URL pointing at a dev server would otherwise pass readiness and be driven
// through setup and uploads against real data.
const baseURL = startApp ? `http://127.0.0.1:${appPort}` : process.env.E2E_BASE_URL?.trim() || `http://127.0.0.1:${appPort}`
// The Vite dev server the dev-proxy project drives. Its own port, never 5173: the owner's
// `make dev` may be running, and the suite must never drive (or displace) that one.
const devPort = 5799
const devURL = `http://127.0.0.1:${devPort}`
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

const here = fileURLToPath(new URL('.', import.meta.url))
const backend = resolve(fileURLToPath(new URL('..', import.meta.url)), 'backend')

if (startApp && !existsSync(join(backend, 'static', 'index.html'))) {
  throw new Error('backend/static is missing; run `make e2e` (it builds the frontend first)')
}

/** The app environment the suite runs against (frontend/e2e/app.env), as KEY=VALUE pairs. One
 *  file, so the local uvicorn below and CI's `docker run --env-file` cannot drift apart. */
function appEnv(): string[] {
  return readFileSync(join(here, 'e2e', 'app.env'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
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
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], baseURL }, testIgnore: /\.dev\.spec\.ts$/ },
    // #52: the Vite dev server with its /api proxy, against the same app. Guards the blank-page
    // regression a lost proxy causes; never touches :5173 or :8000. `*.dev.spec.ts` is the
    // convention for "needs the dev server", and only this project runs those.
    ...(devProxy
      ? [
          {
            name: 'dev-proxy',
            use: { ...devices['Desktop Chrome'], baseURL: devURL },
            testMatch: /\.dev\.spec\.ts$/,
          },
        ]
      : []),
  ],
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
              ...appEnv(),
              `${backend}/.venv/bin/uvicorn app.main:app --port ${appPort}`,
            ].join(' '),
            cwd: backend,
            url: `${baseURL}/api/health`,
            reuseExistingServer: false,
            timeout: 30_000,
          },
        ]
      : []),
    ...(devProxy
      ? [
          {
            // CI included: there it proxies to the container at E2E_BASE_URL. Vite needs only
            // node_modules, so this works in the Docker job's Node-only environment. No `npx`:
            // `npm run e2e` already has node_modules/.bin on PATH, like the fake-nova entry.
            command: `vite --port ${devPort} --strictPort --host 127.0.0.1`,
            env: { ASTROCAPTION_DEV_PROXY_TARGET: baseURL },
            url: `${devURL}/`,
            reuseExistingServer: false,
            timeout: 30_000,
            stdout: 'pipe' as const,
          },
        ]
      : []),
  ],
})
