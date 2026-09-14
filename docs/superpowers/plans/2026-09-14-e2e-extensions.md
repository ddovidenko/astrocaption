# E2E Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Milestone 3, PR 8 of 8: the Playwright suite covers the solve-failure path and the Check-again resume with a switchable fake nova (#53), and a second Playwright project drives the Vite dev server through its `/api` proxy so the blank-page regression cannot ship unnoticed (#52).

**Architecture:** The fake nova gains a tiny control endpoint (`POST /_fake/mode`) that switches how `/api/jobs/{id}` answers — success (today), failure (`job_failure.json`), or timeout (never finishes) — so one spec drives a fresh upload to Failed, a Re-solve to a timeout, and Check again back to Solved, all in the browser. The app reads two optional environment knobs (`ASTROCAPTION_SOLVE_TIMEOUT_SECONDS`, `ASTROCAPTION_SOLVE_POLL_SECONDS`) so the e2e stack can time out in seconds rather than 15 minutes. For #52 the proxy target in `vite.config.ts` becomes overridable (`ASTROCAPTION_API_URL`, default unchanged), Playwright starts `vite` on a scratch port pointed at whatever app is under test (the local uvicorn, or the CI container), and a one-file `dev-proxy` project asserts the app mounts and `/api/health` comes back as JSON through the proxy.

**Tech Stack:** Playwright (chromium), the Node fake nova (`frontend/e2e/fake-nova.mjs`, standard library only), FastAPI worker knobs in `backend/app/main.py`, Vite dev server.

**Spec:** `docs/superpowers/specs/2026-09-11-editor-v1-design.md` § 6 (e2e bullets) and § 8 (PR 8); issues #52 and #53 (incl. the 2026-09-14 comment on #53: the fake must fail at the job stage, and a timeout mode is what exercises Check again, since `check_available` gates it to timed-out rows).

## Global Constraints

- CLAUDE.md: never call nova during tests — the fake replays recorded fixtures only; failures reach the page in plain language with the nova status URL, never a server path or raw exception text (the failure spec asserts this in the browser). Ask before adding a dependency (none here).
- Never use ports 8000 or 5173 (the owner's `astrocaption-dev` unit) and never touch `./data`: the e2e stack keeps 8765 (uvicorn), 8901 (fake nova) and adds 5799 (vite dev). Subagents run the e2e stack only via `E2E_START_APP=1` with a scratch `E2E_DATA_DIR` or `make e2e`.
- The run is one stateful story on one data dir, one worker, retries 0; every helper is an "ensure" (idempotent on a re-used data dir). New specs must leave the fake nova in `success` mode and the data dir without their scratch image, even on failure (`try/finally`).
- File order matters: Playwright runs spec files alphabetically — `dev-proxy`, `parity`, `smoke`, `solve-failure`. The failure spec runs last so the Orion image already exists and a mode left dirty cannot break an earlier spec. Do not rename existing specs.
- CI (`.github/workflows/ci.yml` docker job) runs the suite against the Docker image with `E2E_BASE_URL` and no backend venv; everything added must work there too (the dev-proxy project proxies to `E2E_BASE_URL`; the container gets the two timeout env vars).
- TypeScript strict for the specs; `frontend/tsconfig.json` includes only `src` and `vite.config.ts` (#51 tracks tsc for e2e), so keep the specs type-clean by eye and rely on `npx playwright test --list` (which transpiles them).
- Dev servers run as the `astrocaption-dev` systemd unit from this checkout: never `npm ci`/`make install`/`make dev` by hand.
- Conventional commits; every commit ends with the two attribution trailers the controller supplies.

---

## File map

| File | Responsibility |
|---|---|
| `backend/app/main.py` | Read `ASTROCAPTION_SOLVE_TIMEOUT_SECONDS` / `ASTROCAPTION_SOLVE_POLL_SECONDS` for the module-level app (defaults unchanged: 900 / 5). |
| `backend/app/worker.py` | Timeout sentence says seconds when the deadline is under a minute. |
| `backend/tests/test_worker.py`, `backend/tests/test_main.py` (or wherever `create_app`/env is tested) | Wording test; env knob test. |
| `frontend/e2e/fake-nova.mjs` | `POST /_fake/mode` `{"job": "success" \| "failure" \| "timeout"}`, `GET /_fake/mode`; `job()` honours the mode; `job_failure.json` loaded. |
| `frontend/e2e/helpers.ts` | `FAKE_NOVA_URL`, `setFakeNovaMode(page, mode)`, `deleteImageIfPresent(page, title)`, `uploadImage(page, title)`. |
| `frontend/e2e/solve-failure.spec.ts` | Failure → Re-solve timeout → Check again → Solved; plain-language and nova-link assertions; cleanup. |
| `frontend/vite.config.ts` | Proxy target `process.env.ASTROCAPTION_API_URL ?? 'http://localhost:8000'`. |
| `frontend/playwright.config.ts` | Timeout env for the local uvicorn; `vite` webServer on 5799; `dev-proxy` project; `chromium` project ignores the dev-proxy spec. |
| `frontend/e2e/dev-proxy.spec.ts` | Through the dev server: `/api/health` is JSON, the app mounts. |
| `.github/workflows/ci.yml` | Container gets `ASTROCAPTION_SOLVE_TIMEOUT_SECONDS=8` and `ASTROCAPTION_SOLVE_POLL_SECONDS=1`. |
| `docs/INSTALL.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md` | Env knobs; what the suite covers; the fake's modes. |

---

### Task 1: Solve timeout knobs and the seconds wording (backend)

**Files:**
- Modify: `backend/app/main.py:226` (module-level `app = create_app(...)`)
- Modify: `backend/app/worker.py:284-292` (`_check_deadline`)
- Test: `backend/tests/test_worker.py`; `backend/tests/test_api.py` (the file that exercises `create_app`; put the two knob tests next to its headless-setup test, `grep -n headless backend/tests/test_api.py`)

**Interfaces:**
- Consumes: `create_app(settings=None, *, solver_factory=None, poll_interval=5.0, solve_timeout=900, setup_password=None)`.
- Produces: env vars `ASTROCAPTION_SOLVE_TIMEOUT_SECONDS` and `ASTROCAPTION_SOLVE_POLL_SECONDS` (floats; unset/blank/invalid → defaults with one warning log line, never a crash); the timeout sentence `Timed out after 8 seconds waiting for nova.astrometry.net. Check {url}: …` when the deadline is under 60 s, `… after 15 minutes …` otherwise (rounded as today).

- [ ] **Step 1: Failing tests.** In `backend/tests/test_worker.py` next to the existing timeout test (`grep -n "Timed out" backend/tests/test_worker.py`):

```python
def test_timeout_sentence_uses_seconds_under_a_minute(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    solver = FakeSolver(job_polls=10_000)
    asyncio.run(make_worker(settings, db, solver, timeout=0.05).process(rec.id))
    got = db.get_image(rec.id)
    assert got is not None and got.solve_error
    assert got.solve_error.startswith("Timed out after 0 seconds waiting for nova.astrometry.net.")
    assert "https://nova.example.test/status/12345678" in got.solve_error
```

(`round(0.05)` is 0; use `timeout=8` if the fake settles fast enough for the assertion to read "8 seconds" — pick the one the existing fixtures make deterministic and say which in the report.)

In `backend/tests/test_api.py` (import `build_app_from_env` from `app.main`):

```python
def test_solve_knobs_come_from_the_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ASTROCAPTION_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ASTROCAPTION_SOLVE_TIMEOUT_SECONDS", "8")
    monkeypatch.setenv("ASTROCAPTION_SOLVE_POLL_SECONDS", "0.5")
    app = build_app_from_env()   # the helper Step 3 adds; see below
    worker = app.state.worker
    assert worker.timeout == 8.0 and worker.poll_interval == 0.5


def test_bad_solve_knobs_fall_back_to_defaults(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("ASTROCAPTION_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ASTROCAPTION_SOLVE_TIMEOUT_SECONDS", "soon")
    with caplog.at_level(logging.WARNING, logger="app.main"):
        app = build_app_from_env()
    assert app.state.worker.timeout == 15 * 60
    assert "ASTROCAPTION_SOLVE_TIMEOUT_SECONDS" in caplog.text
```

- [ ] **Step 2: Run them to verify they fail** — `cd backend && .venv/bin/pytest tests/test_worker.py -k timeout_sentence tests/<app test file> -k solve_knobs -v`.

- [ ] **Step 3: Implement.** In `backend/app/main.py` replace the bare module-level call with:

```python
def _env_seconds(name: str, default: float) -> float:
    """A positive number of seconds from the environment, or the default (with one log line)."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        value = 0.0
    if value <= 0:
        log.warning("%s=%r is not a positive number of seconds; using %s", name, raw, default)
        return default
    return value


def build_app_from_env() -> FastAPI:
    """The process entry point's app: every knob a self-hoster can set comes from the environment."""
    return create_app(
        setup_password=os.environ.get("ASTROCAPTION_PASSWORD"),
        poll_interval=_env_seconds("ASTROCAPTION_SOLVE_POLL_SECONDS", 5.0),
        solve_timeout=_env_seconds("ASTROCAPTION_SOLVE_TIMEOUT_SECONDS", 15 * 60),
    )


app = build_app_from_env()
```

(`main.py` already has `log = logging.getLogger(__name__)`.) In `worker.py` `_check_deadline`:

```python
        span = f"{round(self.timeout)} seconds" if self.timeout < 60 else f"{round(self.timeout / 60)} minutes"
        ...
            f"Timed out after {span} waiting for nova.astrometry.net."
```

- [ ] **Step 4: Run the backend suite** — `cd backend && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy app && .venv/bin/pytest -q`.

- [ ] **Step 5: Docs.** `docs/INSTALL.md`, the environment-variable list (grep `ASTROCAPTION_MAX_UPLOAD_MB`): add the two knobs with defaults "900 / 5; the browser test suite sets them low so a timed-out solve can be exercised in seconds". `docs/SPEC.md` § 5.2 step 3 mentions "the 15-minute deadline" — append "(configurable, `ASTROCAPTION_SOLVE_TIMEOUT_SECONDS`)".

- [ ] **Step 6: Commit** — `git commit -m "feat: solve timeout and poll interval from the environment"`.

---

### Task 2: Fake-nova modes and the solve-failure spec (#53)

**Files:**
- Modify: `frontend/e2e/fake-nova.mjs`
- Modify: `frontend/e2e/helpers.ts`
- Create: `frontend/e2e/solve-failure.spec.ts`
- Modify: `frontend/playwright.config.ts` (local uvicorn env: the two knobs), `.github/workflows/ci.yml` (container env)
- Modify: `CLAUDE.md` (hard-rule line about the fake nova), `docs/ARCHITECTURE.md` testing paragraph

**Interfaces:**
- Consumes: Task 1's env knobs; the card markup (`article.card` with `hasText: title`, `.badge` text `Failed`/`Solving…`/`Solved`, `p.error` with `solve_error`, links named `nova status` and `nova job log`, buttons `Check again` (only when `check_available`), `Re-solve`, `Delete` → `ConfirmInline` with buttons `Delete`/`Cancel`); `POST /api/images/{id}/check`; `ImageOut.check_available`, `solve_failure`.
- Produces: fake nova `POST /_fake/mode` with JSON `{"job": "success"|"failure"|"timeout"}` → 200 `{"job": "<mode>"}`; `GET /_fake/mode` → the same; any other value → 400 `{"status":"error","errormessage":"unknown mode"}`. Helpers: `export const FAKE_NOVA_URL = \`http://127.0.0.1:${process.env.FAKE_NOVA_PORT ?? '8901'}\`` (the fake listens on 0.0.0.0 in CI, so 127.0.0.1 reaches it there too); `setFakeNovaMode(page, mode: 'success'|'failure'|'timeout'): Promise<void>`; `uploadImage(page, title): Promise<Locator>` (returns the card; does not wait for a status); `deleteImageIfPresent(page, title): Promise<void>` (through the API: `GET /api/images`, `DELETE /api/images/{id}` for every match, then asserts the card count is 0 after a reload).

- [ ] **Step 1: Fake-nova modes.** In `fake-nova.mjs`: add `'job_failure.json'` to `FIXTURE_NAMES`; `let mode = 'success'`; in `route()`:

```js
  if (path === '/_fake/mode') {
    if (method === 'GET') return { type: 'application/json', body: JSON.stringify({ job: mode }) }
    if (method === 'POST') return { control: true }  // handled below with the body
  }
  ...
  if (method === 'GET' && /^\/api\/jobs\/\d+$/.test(path)) {
    if (mode === 'timeout') return json('job_solving.json')
    return json(job('job_solving.json', mode === 'failure' ? 'job_failure.json' : 'job_success.json'))
  }
```

The server callback must collect the body for `/_fake/mode` POSTs (today it drains bodies unread): accumulate chunks, `JSON.parse`, validate `job ∈ {success, failure, timeout}`, set `mode`, answer 200 `{"job": mode}`; otherwise 400 with the error shape above. Log `mode -> failure` on each switch. Keep the file standard-library only.

- [ ] **Step 2: Wire the knobs.** `playwright.config.ts`, the local uvicorn command: add `'ASTROCAPTION_SOLVE_TIMEOUT_SECONDS=8'` and `'ASTROCAPTION_SOLVE_POLL_SECONDS=1'`. `.github/workflows/ci.yml` docker run: add `-e ASTROCAPTION_SOLVE_TIMEOUT_SECONDS=8 -e ASTROCAPTION_SOLVE_POLL_SECONDS=1`. (8 s: two polls at 1 s plus slack; well under the spec's 60 s waits.)

- [ ] **Step 3: Helpers.** In `helpers.ts`:

```ts
export const FAKE_NOVA_URL = `http://127.0.0.1:${process.env.FAKE_NOVA_PORT ?? '8901'}`
export type FakeNovaMode = 'success' | 'failure' | 'timeout'

/** Switches how the fake nova answers job polls for every solve from now on. */
export async function setFakeNovaMode(page: Page, mode: FakeNovaMode): Promise<void> {
  const res = await page.request.post(`${FAKE_NOVA_URL}/_fake/mode`, { data: { job: mode } })
  expect(res.status(), `fake nova mode ${mode}`).toBe(200)
}

/** Uploads the fixture under `title` and returns its card (no wait for a solve status). */
export async function uploadImage(page: Page, title: string): Promise<Locator> {
  await page.locator('input[type=file]').setInputFiles(FIXTURE)
  await page.getByPlaceholder('Title (optional)').fill(title)
  await page.getByRole('button', { name: 'Upload & solve' }).click()
  const card = page.locator('article.card', { hasText: title })
  await expect(card).toBeVisible()
  return card
}

/** Removes every image titled `title` through the API, so a re-run on the same data dir starts clean. */
export async function deleteImageIfPresent(page: Page, title: string): Promise<void> {
  const res = await page.request.get('/api/images')
  expect(res.status()).toBe(200)
  for (const img of (await res.json()) as ImageOut[]) {
    if (img.title === title) expect((await page.request.delete(`/api/images/${img.id}`)).status()).toBe(204)
  }
}
```

(`ensureSolvedImage` may now call `uploadImage`; keep its behaviour identical.)

- [ ] **Step 4: The spec** `frontend/e2e/solve-failure.spec.ts`:

```ts
import { expect, test } from '@playwright/test'
import { deleteImageIfPresent, ensureSetUpAndSignedIn, setFakeNovaMode, uploadImage } from './helpers'

// Runs last (alphabetical): the Orion story is already on the data dir, and a fake-nova mode
// left dirty by a failure here cannot break an earlier spec. Own scratch image, deleted at the end.
const TITLE = 'Doomed'

test('a failed solve, a timed-out re-solve, and Check again back to solved', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await ensureSetUpAndSignedIn(page)
  await deleteImageIfPresent(page, TITLE)
  try {
    // 1. nova reports the job failed: plain language, nova links, no Check again (not resumable).
    await setFakeNovaMode(page, 'failure')
    const card = await uploadImage(page, TITLE)
    await expect(card.locator('.badge')).toHaveText('Failed', { timeout: 60_000 })
    const message = card.locator('p.error')
    await expect(message).toContainText('could not solve')
    await expect(message).not.toContainText(/\/home\/|\/app\/|Traceback|Error:/)
    await expect(card.getByRole('link', { name: 'nova status' })).toHaveAttribute('href', /\/status\/\d+$/)
    await expect(card.getByRole('link', { name: 'nova job log' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Check again' })).toHaveCount(0)

    // 2. Re-solve while nova never finishes: the deadline (8 s in this stack) passes → timed out.
    await setFakeNovaMode(page, 'timeout')
    await card.getByRole('button', { name: 'Re-solve' }).click()
    await expect(card.locator('.badge')).toHaveText('Solving…')
    await expect(card.locator('.badge')).toHaveText('Failed', { timeout: 60_000 })
    await expect(message).toContainText('Timed out')
    await expect(message).toContainText('use Check again')

    // 3. Check again resumes the stored job without a new upload; nova now answers success.
    await setFakeNovaMode(page, 'success')
    const before = await page.request.get('/api/images').then(async (r) => (await r.json()) as { title: string; nova_submission_id: number }[])
    const subId = before.find((i) => i.title === TITLE)?.nova_submission_id
    await card.getByRole('button', { name: 'Check again' }).click()
    await expect(card.locator('.badge')).toHaveText('Solved', { timeout: 60_000 })
    await expect(card.getByText(/[1-9]\d* objects/)).toBeVisible()
    const after = await page.request.get('/api/images').then(async (r) => (await r.json()) as { title: string; nova_submission_id: number }[])
    expect(after.find((i) => i.title === TITLE)?.nova_submission_id).toBe(subId)
  } finally {
    await setFakeNovaMode(page, 'success')
    await deleteImageIfPresent(page, TITLE)
  }
  expect(errors).toEqual([])
})
```

Adjust selectors to the real markup (`p.error` is `{image.solve_error && <p className="error">…}`; the `.error` class also carries the card's action errors, so scope to the first `p.error` under the card or use `getByText(/could not solve/)`). The "no second upload" proof is the unchanged `nova_submission_id` (the fake returns the same fixed id on every upload, so also assert through the fake: `GET /_fake/mode` is not enough — add a counter: the fake's `POST /api/upload` increments `uploads` and `GET /_fake/mode` returns `{ job, uploads }`; assert `uploads` unchanged across step 3).

- [ ] **Step 5: Run** — `make e2e` (4 files, the new one last), then a second run on the same data dir to prove the cleanup (`E2E_START_APP=1 E2E_DATA_DIR=/tmp/astrocaption-e2e-fail npx playwright test` twice from `frontend/`; delete the dir). Also `npx playwright test --list` to confirm the file order.

- [ ] **Step 6: Docs.** `CLAUDE.md` hard rule: "`frontend/e2e/fake-nova.mjs` replays the Orion set for the browser test" → "…and can be switched to a failed or never-finishing job (`POST /_fake/mode`) for the failure spec". `docs/ARCHITECTURE.md` testing paragraph: one sentence on `solve-failure.spec.ts` (failure → timeout → Check again).

- [ ] **Step 7: Commit** — `git commit -m "test: e2e covers a failed solve, a timeout and Check again (fake-nova modes)"`.

---

### Task 3: The dev-proxy project (#52)

**Files:**
- Modify: `frontend/vite.config.ts` (proxy target)
- Modify: `frontend/playwright.config.ts` (webServer + projects)
- Create: `frontend/e2e/dev-proxy.spec.ts`
- Modify: `docs/INSTALL.md` (`make e2e` line), `CLAUDE.md` dev-server pitfall note (one clause: the e2e suite now guards it)

**Interfaces:**
- Consumes: the app under test at `baseURL` (local uvicorn 8765, or CI's container via `E2E_BASE_URL`); the fake nova (unchanged).
- Produces: `ASTROCAPTION_API_URL` honoured by `vite.config.ts` (`proxy: { '/api': target, '/fonts': target }`, default `http://localhost:8000`); Playwright projects `chromium` (all specs except `dev-proxy.spec.ts`, `baseURL` as today) and `dev-proxy` (`testMatch: /dev-proxy\.spec\.ts/`, `baseURL: http://127.0.0.1:5799`); a `vite` webServer entry `npx vite --port 5799 --strictPort --host 127.0.0.1` with env `ASTROCAPTION_API_URL=<baseURL>`, `url: http://127.0.0.1:5799/`, `reuseExistingServer: false`, `timeout: 30_000`, always started (CI too: it proxies to the container).

- [ ] **Step 1: vite.config.ts**

```ts
// The dev proxy's target. The e2e dev-proxy project points it at the app under test; a
// developer's `make dev` keeps the default (the uvicorn the Makefile starts on :8000).
const apiTarget = process.env.ASTROCAPTION_API_URL ?? 'http://localhost:8000'
...
    proxy: {
      '/api': apiTarget,
      '/fonts': apiTarget,
    },
```

- [ ] **Step 2: playwright.config.ts.** `const devPort = 5799; const devURL = \`http://127.0.0.1:${devPort}\``. Projects:

```ts
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], baseURL }, testIgnore: /dev-proxy\.spec\.ts/ },
    // #52: the Vite dev server with its /api proxy, against the same app. Guards the blank-page
    // regression a lost proxy causes; never touches :5173 or :8000.
    { name: 'dev-proxy', use: { ...devices['Desktop Chrome'], baseURL: devURL }, testMatch: /dev-proxy\.spec\.ts/ },
  ],
```

(move `baseURL` out of the top-level `use` into each project). webServer: append

```ts
    {
      command: `npx vite --port ${devPort} --strictPort --host 127.0.0.1`,
      env: { ASTROCAPTION_API_URL: baseURL },
      url: `${devURL}/`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
```

after the app entry (Playwright starts entries in order; the proxy target need not be up when vite starts, but keep the order readable).

- [ ] **Step 3: The spec** `frontend/e2e/dev-proxy.spec.ts`:

```ts
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
```

- [ ] **Step 4: Run** — `cd frontend && npx playwright test --list` (two projects, the dev-proxy file only in the second), then `make e2e` (all green, five test runs). Confirm no process listens on 5173/8000 that the suite started (`ss -ltnp | grep -E ':5173|:8000'` shows only the owner's unit).

- [ ] **Step 5: Docs.** `docs/INSTALL.md` `make e2e` line: "…plus the Vite dev server through its /api proxy". `CLAUDE.md` "Working with Claude Code" dev-server pitfall: append "(`make e2e`'s dev-proxy project guards this)". Close-out note for #52 in the PR body: CI covers it too because the dev server proxies to the container.

- [ ] **Step 6: Commit** — `git commit -m "test: a Playwright project drives the Vite dev proxy"`.

---

## Self-review

- **Spec coverage:** design § 6 "#52 (dev-proxy project) and #53 (fake-nova failure mode) ride in the same suite" — Tasks 3 and 2. #53's comment (fail at the job stage; a timeout mode for Check again) — Task 2 steps 1 and 4; the timeout needs Task 1's knobs. #52's constraints (never 8000/5173, never `./data`, one-assertion mount + `/api/health` through the proxy) — Task 3.
- **Placeholder scan:** every step has its code; the two lookups (the app-creation test file, the exact `p.error` selector) carry explicit grep instructions.
- **Type consistency:** `setFakeNovaMode(page, mode)` / `FakeNovaMode` match the fake's accepted values; `uploadImage` returns the `Locator` the spec uses; `ASTROCAPTION_SOLVE_TIMEOUT_SECONDS`/`_POLL_SECONDS` are spelled identically in `main.py`, the Playwright config, CI and INSTALL.
- **Not in scope:** a fake mode for `login_bad_key.json` (the no-key/bad-key path is covered by pytest); making the dev-proxy project run under the Docker job's Node-only environment is already handled (vite needs only node_modules); running e2e in CI with a venv.
