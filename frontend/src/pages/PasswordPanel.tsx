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
