# Image Card Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Milestone 3, PR 6 of 8: the image card gets the three actions the backlog owes it — the nova submission link with the "cannot delete it for you" copy (#1), "Check again" on a failed row that resumes the stored nova job without re-uploading (#10), and an upload progress bar plus an in-page delete confirmation instead of `window.confirm` (#12).

**Architecture:** One new backend route, `POST /api/images/{id}/check`, flips a failed row with stored nova ids back to `solving` and enqueues it; the worker's existing resume path (SOLVING + submission id, job id when known) does the rest, so no worker logic changes. The frontend gains an `XMLHttpRequest`-based multipart upload (the only browser transport that reports upload progress; no dependency) sharing `parseBody`/401 handling with `request()`, and the images page gets the three UI pieces in `ImagesPage.tsx` with two small CSS rules. No editor files change.

**Tech Stack:** FastAPI + SQLite backend (pytest, TestClient with the in-memory `FakeSolver`); React 19 + TypeScript strict frontend (vitest, node environment: page components are not unit-tested, pure helpers are).

**Spec:** `docs/superpowers/specs/2026-09-11-editor-v1-design.md` § 7 ("Image card actions") and § 8 (PR 6); `docs/SPEC.md` § 5.2 (upload & solve, steps 1, 3, 6), § 13 (milestone 3). Issues #1, #10, #12 hold the decided wording.

## Global Constraints

- CLAUDE.md hard rules: API responses and the page never carry server paths or raw exception text; failures are plain language, with the nova status URL when one exists. Secrets never in responses. The uploaded original is never modified.
- Ask before adding a dependency: this plan adds none (XHR is built in; the confirmation is plain markup).
- Python 3.13+ type hints everywhere, ruff defaults, Pydantic models for every response; TypeScript strict, function components + hooks.
- Backlog in GitHub Issues: the PR closes #1, #10, #12; anything deferred becomes an issue, not a TODO.
- Existing e2e contracts that must keep working unchanged: the upload form's file input, the "Title (optional)" placeholder and the "Upload & solve" button name (`frontend/e2e/helpers.ts` `ensureSolvedImage`); the card's `.badge`, "Export" button, "Edit" link and "Download full-resolution export" link (`smoke.spec.ts`). Playwright runs single-worker against a scratch data dir with the fake nova; `make e2e` must stay green.
- The dev servers run as the `astrocaption-dev` systemd unit from this checkout: never run `npm ci`/`make install`/`make dev` by hand; never touch `data/`.
- Conventional commits; every commit ends with the two attribution trailers the controller supplies.

---

## File map

| File | Responsibility |
|---|---|
| `backend/app/api/images.py` | New `POST /{image_id}/check` route (`check_solve`) and its two 409 sentences; the deadline sentence in `worker.py` mentions Check again. |
| `backend/tests/test_api.py`, `backend/tests/test_worker.py` | Route tests (resume succeeds without a second upload; refused without ids / while busy / when solved / unknown id); worker test that a SOLVING row with both ids skips submit and submission polling. |
| `frontend/src/api.ts` | `uploadForm()` (XHR multipart with progress, injectable XHR class), `api.upload(file, title, onProgress?)`, `api.checkSolve(id)`. |
| `frontend/src/api.test.ts` | `uploadForm` tests with a fake XHR: progress events forwarded, 201 body parsed, 413 → `ApiError`, 401 → `onUnauthorized` + session-lost error, network error → plain sentence. |
| `frontend/src/pages/ImagesPage.tsx` | `UploadPanel` progress bar and "Uploading… N %" / "Processing…" states; `ImageCard` "Check again" button, nova-link note, inline delete confirmation. |
| `frontend/src/styles.css` | `.upload-progress`, `.confirm`. |
| `docs/SPEC.md` | § 5.2 steps 1 and 6, the route list; the card's nova note. |

---

### Task 1: `POST /api/images/{id}/check` resumes the stored nova job (#10)

**Files:**
- Modify: `backend/app/api/images.py` (after `solve_image`, ~line 278)
- Modify: `backend/app/worker.py:252-265` (`_check_deadline` sentence)
- Test: `backend/tests/test_api.py`, `backend/tests/test_worker.py`

**Interfaces:**
- Consumes: `SolveWorker.enqueue(image_id)`; the worker's resume branch in `_solve` (`solve_status == SOLVING and nova_submission_id is not None`; a stored `nova_job_id` skips the submission poll); `image_out`, `_get_or_404`, `WorkerDep`.
- Produces: `POST /api/images/{image_id}/check` → `ImageOut` (200, `solve_status == "solving"`, `solve_error == null`, nova ids unchanged); 404 unknown id; 409 `"A solve is already in progress."` for pending/solving; 409 `NO_SUBMISSION_MESSAGE` when the row has no `nova_submission_id`; 409 `ALREADY_SOLVED_MESSAGE` for a solved row. Module constants:
  - `NO_SUBMISSION_MESSAGE = "There is no nova.astrometry.net submission to check; use Re-solve."`
  - `ALREADY_SOLVED_MESSAGE = "This image is already solved; use Re-solve to solve it again."`

- [ ] **Step 1: Write the failing route tests** in `backend/tests/test_api.py`, next to `test_failed_solve_then_resolve_with_hints` (mirror its settings/client construction exactly):

```python
def test_check_again_resumes_the_stored_job_without_a_second_upload(
    tmp_path: Path, sample_jpeg: Path
) -> None:
    settings = make_settings(tmp_path)
    solver = FakeSolver(fail=True)
    with make_client(settings, lambda: solver) as client:
        login(client)
        body = upload(client, sample_jpeg)
        failed = wait_for_status(client, body["id"], {"solved", "failed"})
        assert failed["solve_status"] == "failed"
        assert failed["nova_submission_id"] == 12345678
        assert failed["nova_job_id"] == 7654321

        solver.fail = False
        resp = client.post(f"/api/images/{body['id']}/check")
        assert resp.status_code == 200, resp.text
        assert resp.json()["solve_status"] == "solving"
        assert resp.json()["solve_error"] is None
        assert resp.json()["nova_submission_id"] == 12345678

        solved = wait_for_status(client, body["id"], {"solved", "failed"})
        assert solved["solve_status"] == "solved", solved["solve_error"]
        # Nothing was uploaded again and the stored job id spared the submission poll.
        assert len(solver.requests) == 1
        assert solver.submission_poll_count == 1
        assert solved["nova_submission_id"] == 12345678
        assert solved["nova_job_id"] == 7654321


def test_check_again_is_refused_when_there_is_nothing_to_check(
    tmp_path: Path, sample_jpeg: Path
) -> None:
    settings = make_settings(tmp_path)
    # No solver at all: the row fails before nova ever sees it, so it has no ids.
    with make_client(settings, lambda: None) as client:
        login(client)
        body = upload(client, sample_jpeg)
        failed = wait_for_status(client, body["id"], {"solved", "failed"})
        assert failed["solve_status"] == "failed" and failed["nova_submission_id"] is None
        resp = client.post(f"/api/images/{body['id']}/check")
        assert resp.status_code == 409
        assert resp.json()["detail"] == NO_SUBMISSION_MESSAGE
        assert client.post("/api/images/nope/check").status_code == 404


def test_check_again_is_refused_while_busy_or_solved(client: TestClient, sample_jpeg: Path) -> None:
    body = upload(client, sample_jpeg)
    solved = wait_for_status(client, body["id"], {"solved", "failed"})
    assert solved["solve_status"] == "solved"
    resp = client.post(f"/api/images/{body['id']}/check")
    assert resp.status_code == 409 and resp.json()["detail"] == ALREADY_SOLVED_MESSAGE
    # Queue a re-solve, then the row is busy.
    assert client.post(f"/api/images/{body['id']}/solve").status_code == 200
    resp = client.post(f"/api/images/{body['id']}/check")
    assert resp.status_code == 409 and resp.json()["detail"] == "A solve is already in progress."
    wait_for_status(client, body["id"], {"solved", "failed"})
```

Import `NO_SUBMISSION_MESSAGE`, `ALREADY_SOLVED_MESSAGE` from `app.api.images`; `make_settings`, `make_client`, `login`, `upload`, `wait_for_status`, `FakeSolver` are already imported from `tests.conftest` in this file.

And in `backend/tests/test_worker.py`, after `test_resume_after_restart_skips_upload`:

```python
def test_check_again_with_a_stored_job_id_skips_submit_and_submission_poll(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    # What POST /check leaves behind after a timed-out solve: SOLVING with both ids and the scale.
    db.update_image(
        rec.id,
        {
            "solve_status": SolveStatus.SOLVING,
            "solve_error": None,
            "solve_scale": 1.0,
            "nova_submission_id": 12345678,
            "nova_job_id": 7654321,
        },
    )
    solver = FakeSolver()
    asyncio.run(make_worker(settings, db, solver).process(rec.id))
    assert solver.requests == []
    assert solver.submission_poll_count == 0
    got = db.get_image(rec.id)
    assert got is not None and got.solve_status == SolveStatus.SOLVED
    assert got.nova_submission_id == 12345678 and got.nova_job_id == 7654321
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_api.py -k check_again tests/test_worker.py -k check_again -v`
Expected: the API tests fail with 404/405 on `/check` (route missing) and an ImportError for the two constants; the worker test may already pass (the resume path exists) — that is fine, it pins the behaviour the route relies on.

- [ ] **Step 3: Add the route** in `backend/app/api/images.py` directly after `solve_image`:

```python
NO_SUBMISSION_MESSAGE = "There is no nova.astrometry.net submission to check; use Re-solve."
ALREADY_SOLVED_MESSAGE = "This image is already solved; use Re-solve to solve it again."


@router.post("/{image_id}/check")
async def check_solve(
    image_id: str, settings: SettingsDep, db: DbDep, worker: WorkerDep
) -> ImageOut:
    """Check again (#10): resume polling the stored nova submission/job of a failed row instead
    of uploading the image again — the 15-minute deadline may have passed while nova was still
    working. The worker's resume branch does the polling; a stored job id skips the submission
    poll. Nothing about the row changes except the status and the cleared error."""
    rec = _get_or_404(db, image_id)
    if rec.solve_status in (SolveStatus.PENDING, SolveStatus.SOLVING):
        raise HTTPException(status.HTTP_409_CONFLICT, "A solve is already in progress.")
    if rec.solve_status == SolveStatus.SOLVED:
        raise HTTPException(status.HTTP_409_CONFLICT, ALREADY_SOLVED_MESSAGE)
    if rec.nova_submission_id is None:
        raise HTTPException(status.HTTP_409_CONFLICT, NO_SUBMISSION_MESSAGE)
    db.update_image(image_id, {"solve_status": SolveStatus.SOLVING, "solve_error": None})
    worker.enqueue(image_id)
    return image_out(_get_or_404(db, image_id), settings, db.count_objects(image_id))
```

Place the two constants next to `SOLVING_MESSAGE` if that reads better; keep them module-level and importable.

- [ ] **Step 4: Point the timeout sentence at the new action.** In `backend/app/worker.py` `_check_deadline`, change the sentence to:

```python
        raise SolverError(
            f"Timed out after {minutes} minutes waiting for nova.astrometry.net."
            f" Check {url}: if the job finished there, use Check again; otherwise Re-solve.{detail}"
        )
```

Run `grep -rn "use Re-solve" backend/tests` and update any assertion that pins the old wording.

- [ ] **Step 5: Run the backend suite**

Run: `cd backend && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy app && .venv/bin/pytest -q`
Expected: all pass (332 + the new tests).

- [ ] **Step 6: Document the route.** In `docs/SPEC.md` § 5.2 step 6 append: "When the row still holds nova ids (a timed-out or interrupted poll), **Check again** resumes polling the stored submission and job without uploading again (#10); the worker's restart-resume path serves both." In the API route list (the line with `GET /images`, `GET /images/{id}`, `DELETE /images/{id}`) add `POST /images/{id}/check` next to `POST /images/{id}/solve` (add the latter too if it is missing).

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/images.py backend/app/worker.py backend/tests/test_api.py backend/tests/test_worker.py docs/SPEC.md
git commit -m "feat: check again resumes a failed row's stored nova job"
```

---

### Task 2: Upload with progress and the check-again client (`api.ts`)

**Files:**
- Modify: `frontend/src/api.ts` (`request`/`json` area, ~lines 236-290)
- Test: `frontend/src/api.test.ts`

**Interfaces:**
- Consumes: `parseBody(status, ok, text, lost)` (exported), `onUnauthorized` (module variable set by `setUnauthorizedHandler` or equivalent — read the file), `ApiError`.
- Produces:
  - `export type UploadProgress = (sent: number, total: number) => void`
  - `export function uploadForm<T>(url: string, form: FormData, onProgress?: UploadProgress, XHR: typeof XMLHttpRequest = XMLHttpRequest): Promise<T>`
  - `api.upload(file: File, title: string, onProgress?: UploadProgress): Promise<ImageOut>` (same multipart fields as today: `file`, and `title` only when non-blank)
  - `api.checkSolve(id: string): Promise<ImageOut>` → `POST /api/images/${id}/check`

- [ ] **Step 1: Write the failing tests** in `frontend/src/api.test.ts` (node environment: no real XHR; the fake below is injected):

```ts
import { ApiError, uploadForm, setUnauthorizedHandler /* the real name of the 401 hook setter */ } from './api'

/** Enough of XMLHttpRequest for uploadForm: records the request, lets a test drive the events. */
class FakeXHR {
  static last: FakeXHR | null = null
  method = ''
  url = ''
  body: unknown = null
  status = 0
  responseText = ''
  upload = { onprogress: null as ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  constructor() {
    FakeXHR.last = this
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  send(body: unknown) {
    this.body = body
  }
  respond(status: number, text: string) {
    this.status = status
    this.responseText = text
    this.onload?.()
  }
}
const XHR = FakeXHR as unknown as typeof XMLHttpRequest

describe('uploadForm', () => {
  it('posts the form, forwards progress and parses the body', async () => {
    const form = new FormData()
    const seen: Array<[number, number]> = []
    const p = uploadForm<{ id: string }>('/api/images', form, (s, t) => seen.push([s, t]), XHR)
    const xhr = FakeXHR.last!
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe('/api/images')
    expect(xhr.body).toBe(form)
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 5, total: 10 })
    xhr.upload.onprogress!({ lengthComputable: false, loaded: 0, total: 0 })
    xhr.respond(201, JSON.stringify({ id: 'img' }))
    await expect(p).resolves.toEqual({ id: 'img' })
    expect(seen).toEqual([[5, 10]])
  })

  it('turns an error status into an ApiError with the server sentence', async () => {
    const p = uploadForm('/api/images', new FormData(), undefined, XHR)
    FakeXHR.last!.respond(413, JSON.stringify({ detail: 'The file is larger than 60 MB.' }))
    await expect(p).rejects.toMatchObject({ status: 413, message: 'The file is larger than 60 MB.' })
  })

  it('reports a lost session on 401 like request() does', async () => {
    let called = 0
    setUnauthorizedHandler(() => {
      called++
    })
    const p = uploadForm('/api/images', new FormData(), undefined, XHR)
    FakeXHR.last!.respond(401, JSON.stringify({ detail: 'Not signed in.' }))
    await expect(p).rejects.toBeInstanceOf(ApiError)
    await expect(p).rejects.toMatchObject({ sessionLost: true })
    expect(called).toBe(1)
    setUnauthorizedHandler(null)
  })

  it('fails in plain language when the server cannot be reached', async () => {
    const p = uploadForm('/api/images', new FormData(), undefined, XHR)
    FakeXHR.last!.onerror!()
    await expect(p).rejects.toThrow('The upload did not reach the server. Check the connection and try again.')
  })
})
```

The 401-handler setter is the exported function at `api.ts:212-215` (it assigns the module-level `onUnauthorized`); use its real name in place of `setUnauthorizedHandler` above.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/api.test.ts`
Expected: FAIL — `uploadForm` is not exported.

- [ ] **Step 3: Implement** in `frontend/src/api.ts`, below `request()`:

```ts
export type UploadProgress = (sent: number, total: number) => void

/** Multipart POST over XMLHttpRequest — the one browser transport that reports upload
 *  progress — with the same session and error handling as `request()`: a 401 sends the shell to
 *  /login, every body goes through `parseBody`. `XHR` is injectable for tests. */
export function uploadForm<T>(
  url: string,
  form: FormData,
  onProgress?: UploadProgress,
  XHR: typeof XMLHttpRequest = XMLHttpRequest,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XHR()
    xhr.open('POST', url)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total)
    }
    xhr.onerror = () =>
      reject(new Error('The upload did not reach the server. Check the connection and try again.'))
    xhr.onabort = () => reject(new Error('The upload was cancelled.'))
    xhr.onload = () => {
      const lost = xhr.status === 401
      if (lost) onUnauthorized?.()
      try {
        const ok = xhr.status >= 200 && xhr.status < 300
        resolve(parseBody(xhr.status, ok, xhr.responseText, lost) as T)
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    xhr.send(form)
  })
}
```

Then in `api`:

```ts
  upload(file: File, title: string, onProgress?: UploadProgress): Promise<ImageOut> {
    const form = new FormData()
    form.append('file', file)
    if (title.trim()) form.append('title', title.trim())
    return uploadForm<ImageOut>('/api/images', form, onProgress)
  },
  /** Check again (#10): resumes the stored nova job of a failed row; a 409 says why it cannot. */
  checkSolve: (id: string) => request<ImageOut>(`/api/images/${id}/check`, json('POST')),
```

Check `parseBody`'s handling of a 204/empty body is not needed here (uploads answer 201 with JSON).

- [ ] **Step 4: Run the tests and the type check**

Run: `cd frontend && npx vitest run src/api.test.ts && npx tsc --noEmit && npx eslint src/api.ts src/api.test.ts`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/api.test.ts
git commit -m "feat: upload with progress events; check-again client"
```

---

### Task 3: The card and the upload panel (#1, #10, #12 UI)

**Files:**
- Modify: `frontend/src/pages/ImagesPage.tsx` (`UploadPanel` lines 97-139, `ImageCard` lines 141-292)
- Modify: `frontend/src/styles.css` (after `.hints`, line 56)
- Modify: `docs/SPEC.md` § 5.2 step 1 (progress), the card description wherever the nova links are described (grep "nova status"), § 6 M3 note if it lists card actions

**Interfaces:**
- Consumes: `api.upload(file, title, onProgress)`, `api.checkSolve(id)`, `ImageOut.nova_submission_id`, `nova_status_url`, `isBusy`, `pageError`, `formatBytes`.
- Produces: no new exports. Visible contracts: the idle button text stays exactly `Upload & solve`; the delete confirmation is inline markup (no `window.confirm`), with buttons named `Delete` (confirm) and `Cancel`; the failed-card button is named `Check again`.

- [ ] **Step 1: Upload progress.** In `UploadPanel`:

```tsx
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null)
  ...
    setUploading(true)
    setProgress(null)
    setError(null)
    try {
      await api.upload(file, title, (sent, total) => setProgress({ sent, total }))
      ...
    } finally {
      setUploading(false)
      setProgress(null)
    }
```

Button label and bar (the bytes are all sent well before the server answers: it still has to write the file and build the preview and thumbnail, hence "Processing…"):

```tsx
  const sent = progress !== null && progress.total > 0 && progress.sent >= progress.total
  const label = !uploading
    ? 'Upload & solve'
    : progress === null || sent
      ? 'Processing…'
      : `Uploading… ${Math.floor((progress.sent / progress.total) * 100)} %`
  ...
        <button type="submit" disabled={uploading}>{label}</button>
      </form>
      {uploading && (
        <progress
          className="upload-progress"
          aria-label="Upload progress"
          value={progress?.sent ?? 0}
          max={progress?.total ?? 1}
        />
      )}
```

A `<progress>` with `value === max` renders full during "Processing…"; before the first event it shows empty (value 0 of 1), which is honest.

- [ ] **Step 2: Nova note (#1).** In `ImageCard`, directly after the `.meta` block (before `solve_error`), when the card has a submission link:

```tsx
        {image.nova_status_url && (
          <p className="field-note">
            The upload stays in your nova.astrometry.net account (not publicly listed). To remove it,
            open the nova status page and delete it there — AstroCaption cannot delete it for you.
          </p>
        )}
```

Reuse the existing `.field-note` class (muted, 0.85rem); no new CSS.

- [ ] **Step 3: Check again (#10).** Add the action and the button. Next to `resolve`:

```tsx
  const checkAgain = () => run(() => api.checkSolve(image.id))
```

In the `!busy` block, before the Re-solve button, only for a failed row that has a submission:

```tsx
              {image.solve_status === 'failed' && image.nova_submission_id !== null && (
                <button
                  className="secondary"
                  onClick={checkAgain}
                  disabled={working}
                  title="Resumes the stored nova job; nothing is uploaded again"
                >
                  Check again
                </button>
              )}
```

The 409 sentences from the route surface through `run()`'s `setError(pageError(err))` as today.

- [ ] **Step 4: In-page delete confirmation (#12).** Replace `remove`/`window.confirm` with a confirming state:

```tsx
  const [confirming, setConfirming] = useState(false)
  const remove = () => {
    setConfirming(false)
    return run(() => api.deleteImage(image.id))
  }
```

and in the actions row replace the single Delete button with:

```tsx
          {confirming ? (
            <span className="confirm" role="group" aria-label="Confirm delete">
              Delete “{image.title}” and its export?
              <button className="danger" onClick={remove} disabled={working} autoFocus>
                Delete
              </button>
              <button className="secondary" onClick={() => setConfirming(false)} disabled={working}>
                Cancel
              </button>
            </span>
          ) : (
            <button className="danger" onClick={() => setConfirming(true)} disabled={working}>
              Delete
            </button>
          )}
```

Cancel on Escape while the group has focus:

```tsx
  onKeyDown={(e) => {
    if (e.key === 'Escape') setConfirming(false)
  }}
```

on the `.confirm` span. `autoFocus` on the confirming Delete button is intentional (the owner just clicked Delete; Enter confirms, Escape cancels); if eslint's `jsx-a11y/no-autofocus` is enabled, disable it for that line with a comment saying why.

- [ ] **Step 5: CSS.** In `frontend/src/styles.css` after `.hints`:

```css
.upload-progress { display: block; width: 100%; height: 0.5rem; margin-top: 0.75rem; accent-color: var(--accent); }
.confirm { display: inline-flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; color: var(--danger); }
```

`form.upload` is a wrapping flex row (`styles.css:31`); the `<progress>` is rendered as a sibling after the `</form>`, so `display: block; width: 100%` keeps it on its own line below the row.

- [ ] **Step 6: Lint, tests, and a browser check**

Run: `make lint test`
Expected: clean; vitest count grows by Task 2's tests only.

Then verify in a browser against a scratch server with the fake nova (never the owner's `data/`): `make e2e` builds the bundle and runs the smoke test, which exercises the upload button, the card badge, Export, Edit; it must pass unchanged. For the pieces the smoke test does not click (progress bar, Check again, the confirm), use the Playwright MCP against the e2e stack or `E2E_START_APP=1 npx playwright test --headed`-style manual checks as the environment allows; describe what was seen in the report. Take a screenshot of a card in the confirming state and of the failed-card actions and save them to the SDD workspace.

- [ ] **Step 7: SPEC.** `docs/SPEC.md` § 5.2 step 1: append "The page shows upload progress (bytes sent) and then 'Processing…' while the server writes the derivatives." Step 6 (or wherever the card's nova links are described): "The card shows the nova status link with a note that the upload stays in the owner's nova account and must be deleted there (#1)." Also: "Delete asks for confirmation in the page, not in a browser dialog."

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/ImagesPage.tsx frontend/src/styles.css docs/SPEC.md
git commit -m "feat: image card actions — upload progress, check again, nova note, in-page delete confirm"
```

---

## Self-review

- **Spec coverage:** design § 7 "Image card actions" lists exactly #1 (Task 3 step 2), #10 (Tasks 1, 2, 3 step 3), #12 progress (Tasks 2, 3 step 1) and #12 confirmation (Task 3 step 4). SPEC § 5.2 step 6 gains the Check-again sentence (Task 1 step 6). Nothing else in § 7 belongs to this PR (#43 is PR 7, #52/#53 PR 8).
- **Placeholder scan:** every code step has its code; the one open lookup (the name of the 401-handler setter) is resolved by a grep instruction with a fallback.
- **Type consistency:** `api.checkSolve(id)` (Task 2) is what Task 3 calls; `UploadProgress` `(sent, total)` matches the `setProgress({ sent, total })` call; `NO_SUBMISSION_MESSAGE`/`ALREADY_SOLVED_MESSAGE` are named identically in the route and the tests.
- **Not in scope (file as issues if the reviews raise them):** cancelling an in-flight upload (`xhr.abort()`; the `onabort` sentence exists for it), a progress bar for the export render, the Check-again e2e path (PR 8's #53 fake-nova failure mode is the natural home).
