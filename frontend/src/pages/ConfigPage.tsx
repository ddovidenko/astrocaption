import { useEffect, useState } from 'react'
import { api, pageError, type ConfigOut, type ConfigUpdate, type FontOut, type HealthOut } from '../api'
import { overridesFromStyleForm, sameOverrides, styleFormFromOverrides, type StyleForm, type Tri } from './configForm'

type ColorField = 'text_color' | 'marker_color' | 'leader_color' | 'halo_color'
type SizeField = 'font_size' | 'halo_width' | 'marker_width' | 'marker_min_radius'

const FONTS_UNAVAILABLE = 'The font list could not be loaded; the saved font is kept.'
const HEADER_NOT_REFRESHED = 'Saved, but the page header could not be refreshed; reload to see the new title.'

export default function ConfigPage({ refreshHealth }: { refreshHealth: () => Promise<HealthOut | null> }) {
  const [config, setConfig] = useState<ConfigOut | null>(null)
  const [fonts, setFonts] = useState<FontOut[] | null>(null) // null: the font list did not load
  const [siteTitle, setSiteTitle] = useState('')
  const [uploadMb, setUploadMb] = useState('')
  const [novaKey, setNovaKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [style, setStyle] = useState<StyleForm>(styleFormFromOverrides({}))
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

  const fontList = fonts ?? []
  const fontsLoaded = fonts !== null
  const locked = (field: string) => config.locked.includes(field)
  const lockedNote = (field: string) => config.locked_by[field] ?? 'the environment'
  const edit = <T,>(set: (value: T) => void, value: T) => {
    setSaved(null) // any edit makes "Saved." stale
    set(value)
  }
  const setField = <K extends keyof StyleForm>(key: K, value: StyleForm[K]) => {
    setSaved(null)
    setStyle((s) => ({ ...s, [key]: value }))
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!config) return
    setBusy(true)
    setError(null)
    setSaved(null)
    const body: ConfigUpdate = {}
    const next = overridesFromStyleForm(style)
    const stored = { ...config.default_style }
    if (!fontsLoaded) {
      // Nothing was offered to pick from, so the font is not ours to send back.
      delete next.font_file
      delete stored.font_file
    }
    if (!sameOverrides(next, stored)) body.default_style = next
    if (!locked('site_title') && siteTitle.trim() !== config.site_title) body.site_title = siteTitle.trim()
    if (!locked('max_upload_mb') && uploadMb.trim() !== '' && uploadMb !== String(config.max_upload_mb)) {
      body.max_upload_mb = Number(uploadMb)
    }
    if (!locked('nova_api_key')) {
      if (clearKey) body.nova_api_key = null
      else if (novaKey.trim()) body.nova_api_key = novaKey.trim()
    }
    try {
      const fresh = await api.updateConfig(body)
      setConfig(fresh)
      setSiteTitle(fresh.site_title)
      setUploadMb(String(fresh.max_upload_mb))
      setStyle(styleFormFromOverrides(fresh.default_style))
      setNovaKey('')
      setClearKey(false)
      const health = await refreshHealth() // the header title follows site_title
      setSaved(health ? 'Saved.' : HEADER_NOT_REFRESHED)
    } catch (err) {
      setError(pageError(err))
    } finally {
      setBusy(false)
    }
  }

  const d = config.style_defaults
  const colorRow = (label: string, key: ColorField) => (
    <div className="color-row" key={key}>
      <label>
        {label}
        <input type="color" value={style[key] || d[key]} onChange={(e) => setField(key, e.target.value)} />
      </label>
      <code>{style[key] || `${d[key]} (default)`}</code>
      {style[key] && (
        <button type="button" className="secondary" onClick={() => setField(key, '')}>
          Use default
        </button>
      )}
    </div>
  )
  const sizeRow = (label: string, key: SizeField, min: number, max: number) => (
    <label key={key}>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        placeholder="auto"
        value={style[key]}
        onChange={(e) => setField(key, e.target.value)}
      />
    </label>
  )
  const triRow = (label: string, key: 'halo' | 'show_aliases') => (
    <label key={key}>
      {label}
      <select value={style[key]} onChange={(e) => setField(key, e.target.value as Tri)}>
        <option value="">Default ({d[key] ? 'on' : 'off'})</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </label>
  )

  return (
    <form className="config" onSubmit={save}>
      <section className="panel">
        <h2>Site</h2>
        <label>
          Site title
          <input
            type="text"
            value={siteTitle}
            required
            maxLength={200}
            disabled={locked('site_title')}
            onChange={(e) => edit(setSiteTitle, e.target.value)}
          />
          {locked('site_title') && <span className="meta">set by {lockedNote('site_title')}</span>}
        </label>
        <label>
          Upload limit (MB)
          <input
            type="number"
            required
            min={1}
            max={1024}
            value={uploadMb}
            disabled={locked('max_upload_mb')}
            onChange={(e) => edit(setUploadMb, e.target.value)}
          />
          {locked('max_upload_mb') && <span className="meta">set by {lockedNote('max_upload_mb')}</span>}
        </label>
      </section>

      <section className="panel">
        <h2>Solver</h2>
        <p className="meta">
          nova.astrometry.net API key: {config.nova_api_key_set ? 'set' : 'not set'}
          {locked('nova_api_key') && ` (set by ${lockedNote('nova_api_key')})`}
        </p>
        {!locked('nova_api_key') && (
          <>
            <label>
              {config.nova_api_key_set ? 'Replace key' : 'Key'}
              <input
                type="text"
                value={novaKey}
                autoComplete="off"
                disabled={clearKey}
                onChange={(e) => edit(setNovaKey, e.target.value)}
              />
            </label>
            {config.nova_api_key_set && (
              <label className="hints">
                <input
                  type="checkbox"
                  checked={clearKey}
                  onChange={(e) => {
                    setSaved(null)
                    setClearKey(e.target.checked)
                    if (e.target.checked) setNovaKey('') // never silently discard a typed key
                  }}
                />{' '}
                Remove the stored key
              </label>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Default label style</h2>
        <p className="meta">Applies to newly solved images. Blank fields use the built-in defaults, which are derived from each image's size for the four size fields.</p>
        <div className="grid2">
          <label>
            Font
            <select value={style.font_file} disabled={!fontsLoaded} onChange={(e) => setField('font_file', e.target.value)}>
              <option value="">Default ({d.font_file})</option>
              {/* The saved font always has an option of its own, so the select is never blank. */}
              {style.font_file && !fontList.some((f) => f.file === style.font_file) && (
                <option value={style.font_file}>{fontsLoaded ? `${style.font_file} (not installed)` : style.font_file}</option>
              )}
              {fontList.map((f) => (
                <option key={f.file} value={f.file}>
                  {f.family} {f.weight}
                </option>
              ))}
            </select>
            {!fontsLoaded && <span className="meta">{FONTS_UNAVAILABLE}</span>}
          </label>
          <label>
            Primary name
            <select value={style.name_preference} onChange={(e) => setField('name_preference', e.target.value as StyleForm['name_preference'])}>
              <option value="">Default ({d.name_preference === 'popular' ? 'Messier/Caldwell first' : 'NGC/IC first'})</option>
              <option value="popular">Messier, Caldwell, Sharpless, Barnard first</option>
              <option value="ngc_ic">NGC / IC first</option>
            </select>
          </label>
          {sizeRow('Font size (px)', 'font_size', 6, 200)}
          {sizeRow('Marker line width (px)', 'marker_width', 1, 40)}
          {sizeRow('Marker minimum radius (px)', 'marker_min_radius', 1, 400)}
          {sizeRow('Halo width (px)', 'halo_width', 0, 40)}
          {triRow('Halo', 'halo')}
          {triRow('Alias line', 'show_aliases')}
          {colorRow('Text colour', 'text_color')}
          {colorRow('Marker colour', 'marker_color')}
          {colorRow('Leader colour', 'leader_color')}
          {colorRow('Halo colour', 'halo_color')}
        </div>
      </section>

      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="meta">{saved}</span>}
        {error && <span className="error">{error}</span>}
      </div>
    </form>
  )
}
