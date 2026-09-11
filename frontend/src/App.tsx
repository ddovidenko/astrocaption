import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router'
import { api, describeError, setUnauthorizedHandler, type HealthOut } from './api'
import ConfigPage from './pages/ConfigPage'
import ImagesPage from './pages/ImagesPage'
import LoginPage from './pages/LoginPage'
import SetupPage from './pages/SetupPage'

export default function App() {
  const [health, setHealth] = useState<HealthOut | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  /** Re-read health and hand it back, so a caller can act on what the server actually says
   *  instead of on the state it hoped for. Null means the call failed (the banner says why). */
  const refreshHealth = useCallback(async (): Promise<HealthOut | null> => {
    try {
      const fresh = await api.health()
      setHealth(fresh)
      setError(null)
      return fresh
    } catch (err) {
      setError(describeError(err))
      return null
    }
  }, [])

  useEffect(() => {
    // Inlined rather than `void refreshHealth()`: react-hooks/set-state-in-effect forbids
    // calling a setState-wrapping function directly in an effect body.
    let cancelled = false
    api
      .health()
      .then((h) => {
        if (!cancelled) {
          setHealth(h)
          setError(null)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Ask the server what is true now rather than patching `authenticated: false` onto a
      // stale copy: config_error and setup_required may have moved on too.
      void refreshHealth()
      navigate('/login', { replace: true, state: { sessionEnded: true } })
    })
    return () => setUnauthorizedHandler(null)
  }, [navigate, refreshHealth])

  useEffect(() => {
    if (health?.site_title) document.title = health.site_title
  }, [health])

  async function logout() {
    try {
      await api.logout()
    } catch (err) {
      setError(`Could not sign out: ${describeError(err)}. You are still signed in.`)
      return
    }
    const fresh = await refreshHealth()
    if (fresh && !fresh.authenticated) {
      navigate('/login', { replace: true })
    } else if (fresh) {
      setError('Could not sign out: the browser kept the session cookie. You are still signed in.')
    }
  }

  return (
    <>
      <header>
        <h1>
          <Link to="/">{health?.site_title ?? 'AstroCaption'}</Link>
        </h1>
        {health && <span className="version">v{health.version}</span>}
        {health?.authenticated && (
          <nav>
            <NavLink to="/" end>
              Images
            </NavLink>
            <NavLink to="/config">Config</NavLink>
            <button className="secondary" onClick={() => void logout()}>
              Log out
            </button>
          </nav>
        )}
      </header>
      <main>
        {error && (
          <p className="error">
            {error}{' '}
            {!health && (
              <button className="secondary" onClick={() => void refreshHealth()}>
                Try again
              </button>
            )}
          </p>
        )}
        {health && (
          <Routes>
            <Route path="/setup" element={<SetupPage health={health} refreshHealth={refreshHealth} />} />
            <Route path="/login" element={<LoginPage health={health} refreshHealth={refreshHealth} />} />
            <Route
              path="/"
              element={
                <Guard health={health}>
                  <ImagesPage health={health} refreshHealth={refreshHealth} />
                </Guard>
              }
            />
            <Route
              path="/config"
              element={
                <Guard health={health}>
                  <ConfigPage refreshHealth={refreshHealth} />
                </Guard>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </>
  )
}

/** Owner-only routes: setup first, then sign-in, then the page. */
function Guard({ health, children }: { health: HealthOut; children: React.ReactNode }) {
  if (health.setup_required) return <Navigate to="/setup" replace />
  if (!health.authenticated) return <Navigate to="/login" replace />
  return children
}
