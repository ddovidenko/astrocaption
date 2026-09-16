import { useEffect, useState } from 'react'
import { api, pageError, type ConfigOut, type FontOut, type HealthOut } from '../api'
import StyleForm from '../style/StyleForm'
import { styleFormFromOverrides, type StyleForm as StyleFormValues } from '../style/styleForm'
import { buildUpdate } from './configForm'

const HEADER_NOT_REFRESHED = 'Saved, but the page header could not be refreshed; reload to see the new title.'

export default function ConfigPage({ refreshHealth }: { refreshHealth: () => Promise<HealthOut | null> }) {
  const [config, setConfig] = useState<ConfigOut | null>(null)
  const [fonts, setFonts] = useState<FontOut[] | null>(null) // null: the font list did not load
  const [siteTitle, setSiteTitle] = useState('')
  const [uploadMb, setUploadMb] = useState('')
  const [novaKey, setNovaKey] = useState('')
  const [style, setStyle] = useState<StyleFormValues>(styleFormFromOverrides({}))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // The font list is a nicety; the page is still usable (and savable) without it.
    Promise.allSettled([api.config(), api.fonts()]).then(([cfg, list]) => {
      if (cancelled) return
      if (cfg.status === 'rejected') {
        setError(pageError(cfg.reason))
        return
      }
      setConfig(cfg.value)
      setFonts(list.status === 'fulfilled' ? list.value : null)
      setSiteTitle(cfg.value.site_title)
      setUploadMb(String(cfg.value.max_upload_mb))
      setStyle(styleFormFromOverrides(cfg.value.default_style))
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!config) return error ? <p className="error">{error}</p> : <p className="meta">Loading…</p>

  const locked = (field: string) => config.locked.includes(field)
  const lockedNote = (field: string) => `Set by ${config.locked_by[field] ?? 'the environment'}`
  const edit = <T,>(set: (value: T) => void, value: T) => {
    setSaved(null) // any edit makes "Saved." stale
    set(value)
  }
  const setField = <K extends keyof StyleFormValues>(key: K, value: StyleFormValues[K]) =>
    edit((v: StyleFormValues[K]) => setStyle((s) => ({ ...s, [key]: v })), value)

  /** Apply a saved config to every piece of form state. */
  function adopt(fresh: ConfigOut) {
    setConfig(fresh)
    setSiteTitle(fresh.site_title)
    setUploadMb(String(fresh.max_upload_mb))
    setStyle(styleFormFromOverrides(fresh.default_style))
    setNovaKey('')
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!config) return
    setBusy(true)
    setError(null)
    setSaved(null)
    const body = buildUpdate({ siteTitle, uploadMb, novaKey, style }, config)
    try {
      adopt(await api.updateConfig(body))
      const health = await refreshHealth() // the header title follows site_title
      setSaved(health ? 'Saved.' : HEADER_NOT_REFRESHED)
    } catch (err) {
      setError(pageError(err))
    } finally {
      setBusy(false)
    }
  }

  /** Removing the key is its own action, done at once: nothing to stage, nothing to explain.
   *  Only the key changes, so the owner's unsaved edits elsewhere on the page stay put. */
  async function removeKey() {
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      setConfig(await api.updateConfig({ nova_api_key: null }))
      setNovaKey('')
      setSaved('Key removed.')
    } catch (err) {
      setError(pageError(err))
    } finally {
      setBusy(false)
    }
  }

  const d = config.style_defaults

  return (
    <form className="config" onSubmit={save}>
      <section className="panel">
        <h2>Site</h2>
        <div className="row2">
          <label className="field">
            <span className="field-label">Site title</span>
            <input
              type="text"
              value={siteTitle}
              required
              maxLength={200}
              disabled={locked('site_title')}
              onChange={(e) => edit(setSiteTitle, e.target.value)}
            />
            {locked('site_title') && <span className="field-note">{lockedNote('site_title')}</span>}
          </label>
          <label className="field">
            <span className="field-label">Upload limit (MB)</span>
            <input
              type="number"
              required
              min={1}
              max={1024}
              value={uploadMb}
              disabled={locked('max_upload_mb')}
              onChange={(e) => edit(setUploadMb, e.target.value)}
            />
            {locked('max_upload_mb') && <span className="field-note">{lockedNote('max_upload_mb')}</span>}
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>Solver</h2>
        <p className="status-line">
          <span className={`dot ${config.nova_api_key_set ? 'ok' : ''}`} aria-hidden="true" />
          nova.astrometry.net key {config.nova_api_key_set ? 'set' : 'not set'}
          {locked('nova_api_key') && <span className="field-note"> · {lockedNote('nova_api_key')}</span>}
        </p>
        {!locked('nova_api_key') && (
          <div className="row2 row2-action">
            <label className="field">
              <span className="field-label">{config.nova_api_key_set ? 'Replace key' : 'Key'}</span>
              <input
                type="text"
                value={novaKey}
                autoComplete="off"
                placeholder="Paste the key from your nova profile"
                onChange={(e) => edit(setNovaKey, e.target.value)}
              />
            </label>
            {config.nova_api_key_set && (
              <button type="button" className="secondary" disabled={busy} onClick={() => void removeKey()}>
                Remove key
              </button>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Default label style</h2>
        <StyleForm mode="overrides" values={style} defaults={d} fonts={fonts} onChange={setField}>
          <p className="field-note">
            Applies to newly solved images. Blank fields keep the built-in defaults; the four sizes then scale with each image.
            The preview draws the text near its real size and every width in proportion to it.
          </p>
        </StyleForm>
      </section>

      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        {saved && <span className="meta">{saved}</span>}
        {error && <span className="error">{error}</span>}
      </div>
    </form>
  )
}
