import { useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router'
import { api, describeError, setUnauthorizedHandler, type HealthOut } from './api'
import ImagesPage from './pages/ImagesPage'
import LoginPage from './pages/LoginPage'
import SetupPage from './pages/SetupPage'

export default function App() {
  const [health, setHealth] = useState<HealthOut | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.health())
      setError(null)
    } catch (err) {
      setError(describeError(err))
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
      setHealth((h) => (h ? { ...h, authenticated: false } : h))
      navigate('/login', { replace: true })
    })
    return () => setUnauthorizedHandler(null)
  }, [navigate])

  useEffect(() => {
    if (health?.site_title) document.title = health.site_title
  }, [health])

  async function logout() {
    try {
      await api.logout()
    } finally {
      await refreshHealth()
      navigate('/login', { replace: true })
    }
  }

  return (
    <>
      <header>
        <h1>{health?.site_title ?? 'AstroCaption'}</h1>
        {health && <span className="version">v{health.version}</span>}
        {health?.authenticated && (
          <nav>
            <button className="secondary" onClick={() => void logout()}>
              Log out
            </button>
          </nav>
        )}
      </header>
      <main>
        {error && <p className="error">{error}</p>}
        {health && (
          <Routes>
            <Route path="/setup" element={<SetupPage health={health} onDone={refreshHealth} />} />
            <Route path="/login" element={<LoginPage health={health} onDone={refreshHealth} />} />
            <Route path="/" element={<Guard health={health}><ImagesPage health={health} /></Guard>} />
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
