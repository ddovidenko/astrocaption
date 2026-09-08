import { useState } from 'react'
import { Link, Navigate } from 'react-router'
import { api, describeError, type HealthOut } from '../api'

export default function SetupPage({
  health,
  onDone,
}: {
  health: HealthOut
  onDone: () => Promise<HealthOut | null>
}) {
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

  // An environment variable wins over anything typed here, so offer it read-only and do
  // not send it: a value parked in config.json would never take effect.
  const novaLocked = health.locked.includes('nova_api_key')
  const titleLocked = health.locked.includes('site_title')

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
      await api.setup({
        password,
        nova_api_key: novaLocked ? undefined : novaKey.trim() || undefined,
        site_title: titleLocked ? undefined : siteTitle.trim() || undefined,
      })
      setSubmitted(true)
      // Navigate on what health now says, not on the 204 alone: if we sent the user to
      // /login while setup_required was still true, LoginPage would bounce them back here.
      const fresh = await onDone()
      if (fresh && !fresh.setup_required) setDone(true)
      else setError('Setup was saved, but the page could not confirm it. Reload and sign in.')
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
          <input type="text" value={novaKey} autoComplete="off" disabled={novaLocked} onChange={(e) => setNovaKey(e.target.value)} />
          {novaLocked && <span className="meta">set by the environment</span>}
        </label>
        <label>
          Site title (optional)
          <input type="text" value={siteTitle} placeholder={health.site_title} disabled={titleLocked} onChange={(e) => setSiteTitle(e.target.value)} />
          {titleLocked && <span className="meta">set by the environment</span>}
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Finish setup'}
        </button>
      </form>
    </section>
  )
}
