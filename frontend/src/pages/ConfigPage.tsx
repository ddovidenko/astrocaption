import { useEffect, useState } from 'react'
import { api, pageError, type ConfigOut, type ConfigUpdate, type FontOut, type HealthOut } from '../api'
import { overridesFromStyleForm, styleFormFromOverrides, type StyleForm, type Tri } from './configForm'

type ColorField = 'text_color' | 'marker_color' | 'leader_color' | 'halo_color'
type SizeField = 'font_size' | 'halo_width' | 'marker_width' | 'marker_min_radius'

export default function ConfigPage({ refreshHealth }: { refreshHealth: () => Promise<HealthOut | null> }) {
  const [config, setConfig] = useState<ConfigOut | null>(null)
  const [fonts, setFonts] = useState<FontOut[]>([])
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
    Promise.all([api.config(), api.fonts()])
      .then(([cfg, list]) => {
        if (cancelled) return
        setConfig(cfg)
        setFonts(list)
        setSiteTitle(cfg.site_title)
        setUploadMb(String(cfg.max_upload_mb))
        setStyle(styleFormFromOverrides(cfg.default_style))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(pageError(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!config) return error ? <p className="error">{error}</p> : <p className="meta">Loading…</p>

  const locked = (field: string) => config.locked.includes(field)
  const setField = <K extends keyof StyleForm>(key: K, value: StyleForm[K]) =>
    setStyle((s) => ({ ...s, [key]: value }))

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!config) return
    setBusy(true)
    setError(null)
    setSaved(null)
    const body: ConfigUpdate = { default_style: overridesFromStyleForm(style) }
    if (!locked('site_title') && siteTitle.trim() !== config.site_title) body.site_title = siteTitle.trim()
    if (!locked('max_upload_mb') && uploadMb !== String(config.max_upload_mb)) body.max_upload_mb = Number(uploadMb)
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
      setSaved('Saved.')
      await refreshHealth() // the header title follows site_title
    } catch (err) {
      setError(pageError(err))
    } finally {
      setBusy(false)
    }
  }

  const d = config.style_defaults
  const colorRow = (label: string, key: ColorField) => (
    <label key={key}>
      {label}
      <span className="color-row">
        <input
          type="color"
          value={style[key] || d[key]}
          onChange={(e) => setField(key, e.target.value)}
          aria-label={label}
        />
        <code>{style[key] || `${d[key]} (default)`}</code>
        {style[key] && (
          <button type="button" className="secondary" onClick={() => setField(key, '')}>
            Use default
          </button>
        )}
      </span>
    </label>
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
          <input type="text" value={siteTitle} maxLength={200} disabled={locked('site_title')} onChange={(e) => setSiteTitle(e.target.value)} />
          {locked('site_title') && <span className="meta">set by ASTROCAPTION_SITE_TITLE</span>}
        </label>
        <label>
          Upload limit (MB)
          <input type="number" min={1} max={1024} value={uploadMb} disabled={locked('max_upload_mb')} onChange={(e) => setUploadMb(e.target.value)} />
          {locked('max_upload_mb') && <span className="meta">set by ASTROCAPTION_MAX_UPLOAD_MB</span>}
        </label>
      </section>

      <section className="panel">
        <h2>Solver</h2>
        <p className="meta">
          nova.astrometry.net API key: {config.nova_api_key_set ? 'set' : 'not set'}
          {locked('nova_api_key') && ' (set by NOVA_API_KEY)'}
        </p>
        {!locked('nova_api_key') && (
          <>
            <label>
              {config.nova_api_key_set ? 'Replace key' : 'Key'}
              <input type="text" value={novaKey} autoComplete="off" disabled={clearKey} onChange={(e) => setNovaKey(e.target.value)} />
            </label>
            {config.nova_api_key_set && (
              <label className="hints">
                <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> Remove the stored key
              </label>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Default label style</h2>
        <p className="meta">Applies to newly solved images. Blank fields use the size-relative defaults.</p>
        <div className="grid2">
          <label>
            Font
            <select value={style.font_file} onChange={(e) => setField('font_file', e.target.value)}>
              <option value="">Default ({d.font_file})</option>
              {fonts.map((f) => (
                <option key={f.file} value={f.file}>
                  {f.family} {f.weight}
                </option>
              ))}
            </select>
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
