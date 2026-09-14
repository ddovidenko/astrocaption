# Password Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Milestone 3, PR 7 of 8 (#43): the owner changes the password from the config page — current password, new password twice — and stays signed in afterwards.

**Architecture:** One owner-only route, `POST /api/password`, verifies the current password (through the same `LoginLimiter` as sign-in, so a stolen session cannot guess the password unthrottled), validates the new one with the shared `validate_new_password`, writes through `set_owner_password` (which also rotates the session secret, so every other session is signed out, SPEC § 10) and sets a fresh session cookie in the 204 response. The config page gets a second, self-contained form (`PasswordPanel`) under the existing one; the smoke test changes the password and changes it back so re-runs on the same data dir keep working. The CLI stays the lockout path.

**Tech Stack:** FastAPI backend (pytest, `TestClient`), React 19 + TypeScript strict (vitest, node env: pure helpers only), Playwright smoke test.

**Spec:** `docs/superpowers/specs/2026-09-11-editor-v1-design.md` § 7 ("Password change") and § 8 (PR 7); `docs/SPEC.md` § 10 (auth), § 8 (API list); issue #43.

## Global Constraints

- CLAUDE.md: secrets never in responses or logs (never log a password; the failed-attempt log line carries no detail); API responses never carry raw exception text; failures in plain language. Ask before adding a dependency (none here). TypeScript strict; Pydantic models for every request.
- SPEC § 10: a new password is 8 to 1024 characters wherever it is chosen (`validate_new_password` is the one rule); a password change re-keys every session token; sign-in is rate-limited (five wrong passwords → 60 s cooldown, one global `LoginLimiter`).
- A wrong current password must NOT answer 401: the frontend's `settle()` treats a session-aware 401 as a lost session and sends the owner to /login. Use 403.
- Config writes go through `request.app.state.config_write_lock` and `set_owner_password`; write failures become `config_write_error(exc, "The password")`.
- e2e: `frontend/e2e/helpers.ts` signs in with a fixed password on every run of the same data dir; any password change in the smoke test must be reverted within the test. The existing config step (Site title → "Renamed sky", "Saved.") stays.
- Dev servers run as the `astrocaption-dev` systemd unit from this checkout: never `npm ci`/`make install`/`make dev`; never touch `data/`.
- Conventional commits; every commit ends with the two attribution trailers the controller supplies.

---

## File map

| File | Responsibility |
|---|---|
| `backend/app/models.py` | `PasswordChangeRequest {current_password, new_password}` (both `max_length=MAX_PASSWORD_LENGTH`). |
| `backend/app/api/auth.py` | `POST /password` (owner-only via `Depends(require_owner)`), the 403/422 sentences, cookie re-issue. |
| `backend/tests/test_auth_api.py` | Route tests: success keeps this session and signs out others; wrong current → 403 and the limiter; validation 422s; anonymous 401. |
| `frontend/src/api.ts` | `api.changePassword(current, next)`. |
| `frontend/src/pages/PasswordPanel.tsx` | The form: current, new, confirm; client mismatch check; "Change password"; "Password changed." |
| `frontend/src/pages/ConfigPage.tsx` | Renders `<PasswordPanel />` after the main form. |
| `frontend/e2e/smoke.spec.ts` | Config step: change the password, confirm, change it back. |
| `docs/SPEC.md`, `docs/INSTALL.md`, `docs/LOCKOUT.md` | § 10 no longer says the CLI is the only way; § 8 route list; INSTALL/LOCKOUT one line each. |

---

### Task 1: `POST /api/password` (backend)

**Files:**
- Modify: `backend/app/models.py` (next to `LoginRequest`, ~line 643)
- Modify: `backend/app/api/auth.py` (after `logout`)
- Test: `backend/tests/test_auth_api.py`
- Modify: `docs/SPEC.md` § 8 route list (~line 277) and § 10 (~lines 371-372)

**Interfaces:**
- Consumes: `verify_password`, `validate_new_password`, `set_owner_password`, `issue_session`, `session_cookie_params`, `get_limiter`, `config_write_error`, `require_owner` (from `.deps`), `request.app.state.config_write_lock`, `request.app.state.settings_source`.
- Produces: `POST /api/password` body `{"current_password": str, "new_password": str}` → 204 with a fresh session cookie; 401 without a session (the router-level owner gate); 403 `WRONG_CURRENT_MESSAGE = "The current password is wrong."`; 429 with `Retry-After` during the sign-in cooldown (same sentence as login); 422 from `validate_new_password`, or `SAME_PASSWORD_MESSAGE = "The new password must differ from the current one."`; 409/500 from `config_write_error`.

- [ ] **Step 1: Write the failing tests** in `backend/tests/test_auth_api.py` (use the file's `env_app_client(tmp_path, monkeypatch)` and `login(client, password)` helpers; read `test_password_reset_invalidates_sessions` and `test_login_cooldown_after_five_failures` for the idioms; import the two new constants from `app.api.auth`):

```python
def test_password_change_keeps_this_session_and_signs_out_the_others(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with env_app_client(tmp_path, monkeypatch) as client:
        client.post("/api/setup", json={"password": "hunter2hunter2"})
        login(client, "hunter2hunter2")
        # A second browser holding its own cookie.
        old_cookie = client.cookies.get(COOKIE_NAME)
        assert old_cookie

        resp = client.post(
            "/api/password",
            json={"current_password": "hunter2hunter2", "new_password": "new-password-1"},
        )
        assert resp.status_code == 204, resp.text
        assert "set-cookie" in resp.headers
        # This client now carries the re-issued cookie and stays signed in.
        assert client.get("/api/images").status_code == 200
        # The old token is re-keyed away (SPEC § 10).
        assert client.get("/api/images", cookies={COOKIE_NAME: old_cookie}).status_code == 401
        # Old password no longer signs in; the new one does.
        assert client.post("/api/login", json={"password": "hunter2hunter2"}).status_code == 401
        client.cookies.clear()
        login(client, "new-password-1")


def test_password_change_refuses_a_wrong_current_password(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with env_app_client(tmp_path, monkeypatch) as client:
        client.post("/api/setup", json={"password": "hunter2hunter2"})
        login(client, "hunter2hunter2")
        resp = client.post(
            "/api/password", json={"current_password": "nope-nope-nope", "new_password": "new-password-1"}
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == WRONG_CURRENT_MESSAGE
        # Still signed in, nothing written.
        assert client.get("/api/images").status_code == 200
        client.cookies.clear()
        login(client, "hunter2hunter2")


def test_password_change_shares_the_sign_in_cooldown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with env_app_client(tmp_path, monkeypatch) as client:
        client.post("/api/setup", json={"password": "hunter2hunter2"})
        login(client, "hunter2hunter2")
        body = {"current_password": "nope-nope-nope", "new_password": "new-password-1"}
        for _ in range(5):
            assert client.post("/api/password", json=body).status_code == 403
        # The fifth wrong password started the cooldown: even the right one is turned away now.
        body["current_password"] = "hunter2hunter2"
        resp = client.post("/api/password", json=body)
        assert resp.status_code == 429 and resp.headers["retry-after"] == "60"
        # The cooldown is the sign-in one: login is throttled too.
        client.cookies.clear()
        assert client.post("/api/login", json={"password": "hunter2hunter2"}).status_code == 429


def test_password_change_validates_the_new_password(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with env_app_client(tmp_path, monkeypatch) as client:
        client.post("/api/setup", json={"password": "hunter2hunter2"})
        login(client, "hunter2hunter2")
        short = client.post(
            "/api/password", json={"current_password": "hunter2hunter2", "new_password": "short"}
        )
        assert short.status_code == 422
        assert short.json()["detail"] == validate_new_password("short")
        same = client.post(
            "/api/password",
            json={"current_password": "hunter2hunter2", "new_password": "hunter2hunter2"},
        )
        assert same.status_code == 422 and same.json()["detail"] == SAME_PASSWORD_MESSAGE
        # Nothing changed.
        client.cookies.clear()
        login(client, "hunter2hunter2")


def test_password_change_needs_a_session(anon_client: TestClient) -> None:
    resp = anon_client.post(
        "/api/password", json={"current_password": "x" * 8, "new_password": "y" * 8}
    )
    assert resp.status_code == 401
```

`COOKIE_NAME` comes from `app.auth`; `env_app_client`, `login`, `TEST_PASSWORD` are already imported from `tests.conftest`. The limiter's `max_failures` is 5 and the fifth failure locks (see `test_login_cooldown_after_five_failures`). One `LoginLimiter` per app, which is what the third test relies on. Use `httpx`'s cookie API the way the file already does; if `client.get(..., cookies=...)` is deprecated in the installed httpx, build a second `TestClient` on the same app (`TestClient(client.app)`) carrying `{COOKIE_NAME: old_cookie}` instead.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_auth_api.py -k password_change -v`
Expected: ImportError for the constants / 404s on `/api/password`.

- [ ] **Step 3: Model.** In `backend/app/models.py` after `LoginRequest`:

```python
class PasswordChangeRequest(BaseModel):
    current_password: str = Field(max_length=MAX_PASSWORD_LENGTH)
    new_password: str = Field(max_length=MAX_PASSWORD_LENGTH)
```

- [ ] **Step 4: Route.** In `backend/app/api/auth.py` after `logout` (import `PasswordChangeRequest`, `verify_password`, `require_owner` from `.deps`, `Depends`):

```python
WRONG_CURRENT_MESSAGE = "The current password is wrong."
SAME_PASSWORD_MESSAGE = "The new password must differ from the current one."


@router.post(
    "/password", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_owner)]
)
async def change_password(
    body: PasswordChangeRequest, request: Request, response: Response
) -> None:
    """Change the owner password from the config page (#43). The current password is checked
    through the sign-in limiter, so a stolen session cannot guess it unthrottled; the write
    goes through ``set_owner_password``, which also rotates the session secret (every other
    session is signed out, SPEC § 10), and this response carries a fresh cookie so the owner
    who made the change stays signed in. A wrong current password is 403, never 401: the page
    treats a 401 as a lost session."""
    lock: asyncio.Lock = request.app.state.config_write_lock
    async with lock:
        settings: Settings = request.app.state.settings_source.current()
        if settings.config_error is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, settings.config_error)
        assert settings.password_hash and settings.session_secret
        limiter = get_limiter(request)
        wait = limiter.retry_after()
        if wait:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                f"Too many failed sign-ins. Try again in {wait} seconds.",
                headers={"Retry-After": str(wait)},
            )
        just_locked = limiter.record_failure()
        if not await asyncio.to_thread(
            verify_password, body.current_password, settings.password_hash
        ):
            log.warning("failed password change: wrong current password")
            if just_locked:
                log.warning("sign-in cooldown started after %d failures", limiter.max_failures)
            raise HTTPException(status.HTTP_403_FORBIDDEN, WRONG_CURRENT_MESSAGE)
        limiter.reset()
        refusal = validate_new_password(body.new_password)
        if refusal is not None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, refusal)
        if body.new_password == body.current_password:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, SAME_PASSWORD_MESSAGE)
        try:
            await asyncio.to_thread(set_owner_password, settings, body.new_password)
        except (ConfigError, OSError) as exc:
            if isinstance(exc, OSError):
                log.exception("password change could not write config.json")
            raise config_write_error(exc, "The password") from exc
        fresh: Settings = request.app.state.settings_source.current()
        assert fresh.password_hash and fresh.session_secret
        log.info("owner password changed")
    response.set_cookie(
        COOKIE_NAME,
        issue_session(fresh.session_secret, fresh.password_hash),
        **session_cookie_params(fresh, with_max_age=True),
    )
```

The limiter sentence is the login route's; hoist it into a small `_cooldown_response(limiter)` helper used by both routes rather than duplicating the f-string. If `require_owner` lives elsewhere than `.deps`, use where the images router gets it. Confirm `settings_source.current()` re-reads `config.json` after the write (it does for setup: the `_file_stamp` includes `st_ino`).

- [ ] **Step 5: Run the backend suite**

Run: `cd backend && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy app && .venv/bin/pytest -q`
Expected: all pass.

- [ ] **Step 6: SPEC.** § 8 route list: add `POST /password` `{current_password, new_password}` → 204 + fresh cookie, 403 wrong current, 429 during the cooldown, 422 rule violations. § 10: replace "Changing the password is done with the CLI, not from the config page." with "The password is changed from the config page (`POST /password`: current password checked through the sign-in limiter, new one through the same 8–1024 rule, every other session re-keyed, the changing session's cookie re-issued); the CLI is the lockout path."

- [ ] **Step 7: Commit**

```bash
git add backend/app/models.py backend/app/api/auth.py backend/tests/test_auth_api.py docs/SPEC.md
git commit -m "feat: change the owner password from the API"
```

---

### Task 2: The config page form, the client, the smoke step, the docs

**Files:**
- Modify: `frontend/src/api.ts` (`api` object)
- Create: `frontend/src/pages/PasswordPanel.tsx`
- Modify: `frontend/src/pages/ConfigPage.tsx` (render the panel after the main `<form>`)
- Modify: `frontend/e2e/smoke.spec.ts` (config step)
- Modify: `docs/INSTALL.md` (~line 42), `docs/LOCKOUT.md` (top)

**Interfaces:**
- Consumes: `POST /api/password` from Task 1 (204; 403 `The current password is wrong.`; 422 sentences; 429), `request`/`json` in `api.ts`, `pageError`, the `.panel`/`.field`/`.row2`/`.actions` classes and the `form.config` column.
- Produces: `api.changePassword(currentPassword: string, newPassword: string): Promise<void>`; `PasswordPanel` (no props); the panel's accessible names: labels "Current password", "New password", "New password again", button "Change password", success text "Password changed."

- [ ] **Step 1: Client.** In `frontend/src/api.ts`'s `api` object after `logout`:

```ts
  /** 403 = wrong current password (ApiError.message); a 401 here is a lost session like anywhere. */
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/api/password', json('POST', { current_password: currentPassword, new_password: newPassword })),
```

- [ ] **Step 2: Panel.** Create `frontend/src/pages/PasswordPanel.tsx`:

```tsx
import { useState } from 'react'
import { api, pageError } from '../api'

/** Change the owner password (SPEC § 10). Its own form, not part of the config form's Save:
 *  a password change is one deliberate act, and nothing else on the page should ride along
 *  with it. The server re-issues the session cookie, so the owner stays signed in. */
export default function PasswordPanel() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setDone(false)
    if (next !== again) {
      setError('The two new passwords do not match.')
      return
    }
    setBusy(true)
    try {
      await api.changePassword(current, next)
      setCurrent('')
      setNext('')
      setAgain('')
      setDone(true)
    } catch (err) {
      setError(pageError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="config" onSubmit={submit}>
      <section className="panel">
        <h2>Password</h2>
        <p className="field-note">
          Other browsers signed in as you are signed out; this one stays signed in. Forgot the current
          password? See the lockout guide (<code>make reset-password</code>).
        </p>
        <div className="grid3">
          <label className="field">
            <span className="field-label">Current password</span>
            <input
              type="password"
              value={current}
              required
              autoComplete="current-password"
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">New password</span>
            <input
              type="password"
              value={next}
              required
              minLength={8}
              maxLength={1024}
              autoComplete="new-password"
              onChange={(e) => setNext(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">New password again</span>
            <input
              type="password"
              value={again}
              required
              autoComplete="new-password"
              onChange={(e) => setAgain(e.target.value)}
            />
          </label>
        </div>
        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
          {done && <span className="meta">Password changed.</span>}
          {error && <span className="error">{error}</span>}
        </div>
      </section>
    </form>
  )
}
```

Follow the config page's existing label/input rhythm (`.field`, `.field-label`; the three-column `.grid3` collapses like the style grid does — `.grid3` collapses to two columns under the narrow media query in `styles.css`, so the third field wraps; fine and the `feedback-ui-polish` bar: no cramped forms).

- [ ] **Step 3: Mount it.** In `ConfigPage.tsx`, the component returns one `<form className="config">`. Wrap the return in a fragment and render `<PasswordPanel />` after the form:

```tsx
  return (
    <>
      <form className="config" onSubmit={save}>
        …unchanged…
      </form>
      <PasswordPanel />
    </>
  )
```

`form.config` carries the 680 px column and margins, so the second form lines up under the first; add `form.config + form.config { margin-top: 1.5rem }` in `styles.css` if the gap is missing.

- [ ] **Step 4: Smoke step.** In `frontend/e2e/smoke.spec.ts`, after the "Renamed sky" assertion and before Log out. The signed-in password is the one `ensureSetUpAndSignedIn` uses — it is the exported `PASSWORD` in `helpers.ts` and change it back so a second pass on the same data dir still signs in:

```ts
  // Password change (#43): the changing session stays signed in, and the change is reverted so
  // the next run of this suite on the same data dir can still sign in.
  const changePassword = async (from: string, to: string) => {
    await page.getByLabel('Current password').fill(from)
    await page.getByLabel('New password', { exact: true }).fill(to)
    await page.getByLabel('New password again').fill(to)
    await page.getByRole('button', { name: 'Change password' }).click()
    await expect(page.getByText('Password changed.')).toBeVisible()
  }
  await changePassword(PASSWORD, `${PASSWORD}-2`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible() // still signed in, still on the page
  await changePassword(`${PASSWORD}-2`, PASSWORD)
```

Then the existing Log out → /login steps continue; add, before the `/setup` check, a sign-in with the (restored) password to prove the round trip:

```ts
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.getByRole('button', { name: 'Log out' }).click()
```

The login page's label is `Password` and the button `Sign in` (`LoginPage.tsx`); `helpers.ts` line 47 already uses `getByLabel('Password')`. Run `make e2e` twice in a row against the same data dir (`E2E_START_APP=1 E2E_DATA_DIR=/tmp/astrocaption-pw-e2e npx playwright test` from `frontend/`, then again) to prove the revert; delete the temp dir afterwards.

- [ ] **Step 5: Docs.** `docs/INSTALL.md` line ~42: "Change the password on the Config page. Forgot it: `make reset-password` …" (keep the rest). `docs/LOCKOUT.md`: one sentence at the top: "Know the current password? Change it on the Config page instead; this guide is for when you cannot sign in."

- [ ] **Step 6: Lint, tests, e2e**

Run: `make lint test && make e2e`
Expected: green; the smoke test now includes the password round trip.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api.ts frontend/src/pages/PasswordPanel.tsx frontend/src/pages/ConfigPage.tsx frontend/src/styles.css frontend/e2e/smoke.spec.ts frontend/e2e/helpers.ts docs/INSTALL.md docs/LOCKOUT.md
git commit -m "feat: change the owner password from the config page"
```

---

## Self-review

- **Spec coverage:** design § 7 "Password change": config page form (current, new, new again) — Task 2; `POST /api/password` verifying the current password, writing through `set_owner_password`, re-issuing the cookie — Task 1; shared `validate_new_password` — Task 1 step 4; CLI remains the lockout path — docs in both tasks. Issue #43's "not logged out by the hash-bound session token" — the cookie re-issue, tested.
- **Placeholder scan:** every step carries its code; the two lookups (`require_owner`'s module, the login page's labels, the e2e password constant) are resolved by explicit read instructions with a fallback.
- **Type consistency:** `api.changePassword(currentPassword, newPassword)` posts `current_password`/`new_password`, matching `PasswordChangeRequest`; the constants `WRONG_CURRENT_MESSAGE`/`SAME_PASSWORD_MESSAGE` are named identically in the route and the tests; the panel's labels match the smoke step's `getByLabel` names.
- **Not in scope:** a "sign out everywhere" button (the change already does it); password strength meters; changing the password while `ASTROCAPTION_PASSWORD` is set (it is read once at setup and never locks the field, SPEC § 5.1 step 6).
