import { useEffect, useState } from 'react'
import { api, pageError, type ConfigOut, type FontOut, type HealthOut } from '../api'
import ColorField from './ColorField'
import { buildUpdate, styleFormFromOverrides, type StyleForm, type Tri } from './configForm'
import LabelPreview from './LabelPreview'

type ColorKey = 'text_color' | 'marker_color' | 'leader_color' | 'halo_color'
type SizeKey = 'font_size' | 'halo_width' | 'marker_width' | 'marker_min_radius'

const FONTS_UNAVAILABLE = 'The font list could not be loaded; the saved font is kept.'
const HEADER_NOT_REFRESHED = 'Saved, but the page header could not be refreshed; reload to see the new title.'

export default function ConfigPage({ refreshHealth }: { refreshHealth: () => Promise<HealthOut | null> }) {
  const [config, setConfig] = useState<ConfigOut | null>(null)
  const [fonts, setFonts] = useState<FontOut[] | null>(null) // null: the font list did not load
  const [siteTitle, setSiteTitle] = useState('')
  const [uploadMb, setUploadMb] = useState('')
  const [novaKey, setNovaKey] = useState('')
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
  const lockedNote = (field: string) => `Set by ${config.locked_by[field] ?? 'the environment'}`
  const edit = <T,>(set: (value: T) => void, value: T) => {
    setSaved(null) // any edit makes "Saved." stale
    set(value)
  }
  const setField = <K extends keyof StyleForm>(key: K, value: StyleForm[K]) =>
    edit((v: StyleForm[K]) => setStyle((s) => ({ ...s, [key]: v })), value)

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
  const sizeField = (label: string, key: SizeKey, min: number, max: number) => (
    <label className="field" key={key}>
      <span className="field-label">{label}</span>
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
  const triField = (label: string, key: 'halo' | 'show_aliases') => (
    <label className="field" key={key}>
      <span className="field-label">{label}</span>
      <select value={style[key]} onChange={(e) => setField(key, e.target.value as Tri)}>
        <option value="">Default ({d[key] ? 'on' : 'off'})</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </label>
  )
  const colorField = (label: string, key: ColorKey) => (
    <ColorField key={key} label={label} value={style[key]} fallback={d[key]} onChange={(hex) => setField(key, hex)} />
  )

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
        <LabelPreview style={style} defaults={d} />
        <p className="field-note">
          Applies to newly solved images. Blank fields keep the built-in defaults; the four sizes then scale with each image.
          The preview is drawn at one fixed text size, so widths show their proportion to the font.
        </p>
        <div className="grid3">
          <label className="field span2">
            <span className="field-label">Font</span>
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
            {!fontsLoaded && <span className="field-note">{FONTS_UNAVAILABLE}</span>}
          </label>
          {sizeField('Font size (px)', 'font_size', 6, 200)}
          <label className="field span2">
            <span className="field-label">Primary name</span>
            <select value={style.name_preference} onChange={(e) => setField('name_preference', e.target.value as StyleForm['name_preference'])}>
              <option value="">Default ({d.name_preference === 'popular' ? 'Messier and Caldwell first' : 'NGC and IC first'})</option>
              <option value="popular">Messier, Caldwell, Sharpless, Barnard first</option>
              <option value="ngc_ic">NGC and IC first</option>
            </select>
          </label>
          {triField('Alias line', 'show_aliases')}
          {colorField('Text colour', 'text_color')}
          {colorField('Marker colour', 'marker_color')}
          {colorField('Leader colour', 'leader_color')}
          {sizeField('Marker line width (px)', 'marker_width', 1, 40)}
          {sizeField('Marker min radius (px)', 'marker_min_radius', 1, 400)}
          {triField('Halo', 'halo')}
          {colorField('Halo colour', 'halo_color')}
          {sizeField('Halo width (px)', 'halo_width', 0, 40)}
        </div>
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
