import { useState } from 'react'
import { api, ApiError, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, pageError } from '../api'

/** Change the owner password (SPEC § 10). Its own form, not part of the config form's Save:
 *  a password change is one deliberate act, and nothing else on the page should ride along
 *  with it. It is mounted beside ConfigPage (App.tsx), so a failed /api/config still leaves
 *  the owner a way to change their password. The server re-issues the session cookie, so the
 *  owner stays signed in. */
export default function PasswordPanel() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  /** Any edit makes both verdicts stale: "Password changed." must never sit over a form the
   *  owner has started filling in again, and neither must the failure before it. */
  const edit = (set: (value: string) => void, value: string) => {
    setDone(false)
    setError(null)
    set(value)
  }

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
      const message = pageError(err)
      if (message === null) return // the session is gone; the shell is already redirecting
      // An answer from the API is the truth about what happened. Anything else (the request
      // never arrived, or the reply did not) leaves the change genuinely undecided, and the
      // owner needs to be told that rather than shown a bare failure.
      setError(
        err instanceof ApiError
          ? message
          : `Could not reach the server: ${message}. The password may or may not have been changed — reload the page and try signing in with the new one first.`,
      )
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
          password? See <code>docs/LOCKOUT.md</code> (<code>make reset-password</code>, or{' '}
          <code>make reset-password-dev</code> on a source checkout).
        </p>
        {/* Two rows rather than one three-column grid: the pair of "new" fields has to stay
            together at every width, and .row2 collapses to a single column on a narrow screen. */}
        <div className="row2">
          <label className="field">
            <span className="field-label">Current password</span>
            <input
              type="password"
              value={current}
              required
              maxLength={MAX_PASSWORD_LENGTH}
              autoComplete="current-password"
              onChange={(e) => edit(setCurrent, e.target.value)}
            />
          </label>
        </div>
        <div className="row2">
          <label className="field">
            <span className="field-label">New password</span>
            <input
              type="password"
              value={next}
              required
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              autoComplete="new-password"
              onChange={(e) => edit(setNext, e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">New password again</span>
            <input
              type="password"
              value={again}
              required
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              autoComplete="new-password"
              onChange={(e) => edit(setAgain, e.target.value)}
            />
          </label>
        </div>
      </section>
      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Changing…' : 'Change password'}
        </button>
        {done && <span className="meta">Password changed.</span>}
        {error && <span className="error">{error}</span>}
      </div>
    </form>
  )
}
