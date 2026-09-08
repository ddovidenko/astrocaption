import { useState } from 'react'
import { Link, Navigate } from 'react-router'
import { api, describeError, type HealthOut } from '../api'

export default function SetupPage({ health, onDone }: { health: HealthOut; onDone: () => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [novaKey, setNovaKey] = useState('')
  const [siteTitle, setSiteTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  // Set the instant api.setup() resolves, before health is refreshed. Without it, the
  // "already set up" branch below renders for one frame between the health refresh landing
  // (setup_required flips to false) and setDone(true) (done flips to true).
  const [submitted, setSubmitted] = useState(false)

  if (done) return <Navigate to="/login" replace />
  if (!health.setup_required) {
    if (submitted) return null
    return (
      <section className="panel">
        <h2>Setup</h2>
        <p>
          {health.config_error
            ? 'This site cannot be set up until data/config.json is fixed or removed.'
            : 'This site is already set up.'}{' '}
          <Link to="/login">Sign in</Link>
        </p>
      </section>
    )
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError('The two passwords do not match.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.setup({ password, nova_api_key: novaKey.trim() || undefined, site_title: siteTitle.trim() || undefined })
      setSubmitted(true)
      // Refresh health before navigating: if we sent the user to /login while health.setup_required
      // was still stale (true), LoginPage's own guard would bounce them straight back to /setup.
      await onDone()
      setDone(true)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <h2>Welcome</h2>
      <p className="meta">Choose the owner password. You can add the nova.astrometry.net key later.</p>
      <form className="auth" onSubmit={submit}>
        <label>
          Password (at least 8 characters)
          <input type="password" value={password} minLength={8} required autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          Password again
          <input type="password" value={confirm} required autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <label>
          nova.astrometry.net API key (optional)
          <input type="text" value={novaKey} autoComplete="off" onChange={(e) => setNovaKey(e.target.value)} />
        </label>
        <label>
          Site title (optional)
          <input type="text" value={siteTitle} placeholder="AstroCaption" onChange={(e) => setSiteTitle(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Finish setup'}
        </button>
      </form>
    </section>
  )
}
