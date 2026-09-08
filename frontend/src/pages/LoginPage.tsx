import { useState } from 'react'
import { Navigate } from 'react-router'
import { api, describeError, type HealthOut } from '../api'

export default function LoginPage({ health, onDone }: { health: HealthOut; onDone: () => Promise<void> }) {
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
      await onDone()
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
