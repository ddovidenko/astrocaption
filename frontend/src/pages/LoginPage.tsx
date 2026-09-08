import { useState } from 'react'
import { Navigate, useLocation } from 'react-router'
import { api, describeError, type HealthOut } from '../api'

export default function LoginPage({
  health,
  refreshHealth,
}: {
  health: HealthOut
  refreshHealth: () => Promise<HealthOut | null>
}) {
  // The shell navigates here with { state: { sessionEnded: true } } when a request 401s;
  // the flag lives on that navigation and dies with it, so nothing has to reset it.
  const sessionEnded = (useLocation().state as { sessionEnded?: boolean } | null)?.sessionEnded === true
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (health.setup_required) return <Navigate to="/setup" replace />
  if (health.authenticated) return <Navigate to="/" replace />

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(password)
      // A 204 only means the server sent the cookie. If the browser dropped it (Secure
      // cookie over plain http, third-party cookie blocking) health still says logged out,
      // and silently staying here with no message is the worst outcome.
      const fresh = await refreshHealth()
      if (fresh && !fresh.authenticated)
        setError(
          'Signed in, but the browser did not keep the session cookie. If TRUST_PROXY is set, open the site over HTTPS.',
        )
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <h2>Sign in</h2>
      {health.config_error && (
        <div className="notice error">
          <code>data/config.json</code> cannot be read: {health.config_error}. Fix or remove the file, then reload.
        </div>
      )}
      {sessionEnded && !error && <div className="notice">Your session has ended. Sign in and try again.</div>}
      <form className="auth" onSubmit={submit}>
        <label>
          Password
          <input type="password" value={password} required autoFocus autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || !!health.config_error}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </section>
  )
}
