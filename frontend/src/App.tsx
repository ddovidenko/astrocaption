import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router'
import { api, describeError, setUnauthorizedHandler, type HealthOut } from './api'
import EditorPage from './editor/EditorPage'
import ConfigPage from './pages/ConfigPage'
import GalleryImagePage from './pages/GalleryImagePage'
import GalleryPage from './pages/GalleryPage'
import ImagesPage from './pages/ImagesPage'
import LoginPage from './pages/LoginPage'
import PasswordPanel from './pages/PasswordPanel'
import SetupPage from './pages/SetupPage'

export default function App() {
  const [health, setHealth] = useState<HealthOut | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const { pathname } = useLocation()

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
        {health && !health.setup_required && (
          <nav>
            {health.authenticated ? (
              <>
                <NavLink to="/" end>
                  Images
                </NavLink>
                <NavLink to="/gallery">Gallery</NavLink>
                <NavLink to="/config">Config</NavLink>
                <button className="secondary" onClick={() => void logout()}>
                  Log out
                </button>
              </>
            ) : (
              <NavLink to="/login">Log in</NavLink>
            )}
          </nav>
        )}
      </header>
      <main className={pathname.startsWith('/images/') ? 'editor-main' : undefined}>
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
                <Guard health={health} requireAuth={false}>
                  {health.authenticated ? (
                    <ImagesPage health={health} refreshHealth={refreshHealth} />
                  ) : (
                    <GalleryPage health={health} />
                  )}
                </Guard>
              }
            />
            <Route
              path="/gallery"
              element={
                <Guard health={health} requireAuth={false}>
                  <GalleryPage health={health} />
                </Guard>
              }
            />
            <Route
              path="/gallery/:id"
              element={
                <Guard health={health} requireAuth={false}>
                  <GalleryImagePage />
                </Guard>
              }
            />
            <Route
              path="/config"
              element={
                <Guard health={health}>
                  {/* Two independent forms, side by side in `main`'s grid: a failed
                      /api/config must not take the password form down with it. */}
                  <ConfigPage refreshHealth={refreshHealth} />
                  <PasswordPanel />
                </Guard>
              }
            />
            <Route
              path="/images/:id"
              element={
                <Guard health={health}>
                  <EditorPage />
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

/** Setup first, always; then sign-in, unless `requireAuth` is false (the public routes, which
 *  render for both a visitor and the signed-in owner). */
function Guard({
  health,
  requireAuth = true,
  children,
}: {
  health: HealthOut
  requireAuth?: boolean
  children: React.ReactNode
}) {
  if (health.setup_required) return <Navigate to="/setup" replace />
  if (requireAuth && !health.authenticated) return <Navigate to="/login" replace />
  return children
}
