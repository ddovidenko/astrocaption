import { useMemo, useState } from 'react'
import { api, pageError, type FontOut } from '../api'
import StyleForm from '../style/StyleForm'
import { styleFormFromConfig, type ColorKey, type StyleForm as StyleFormValues } from '../style/styleForm'
import { loadBundledFont } from './fonts'
import { isEditable, useEditor } from './store'
import { fallbackSentence, patchForField } from './styleTab'

/** The image's global style, edited live (SPEC § 6.3). Each committed field is one undo entry;
 *  a font is committed only once the browser has loaded it, so the canvas never measures an
 *  unloaded family (#62); colours commit when their picker closes. */
export default function StyleTab() {
  const style = useEditor((s) => s.style)
  const fontsMap = useEditor((s) => s.fonts)
  const imageId = useEditor((s) => s.image?.id ?? null)
  const fallback = useEditor((s) => s.fontFallback)
  const editable = useEditor(isEditable)
  const setStyle = useEditor((s) => s.setStyle)
  const fonts = useMemo<FontOut[]>(() => [...fontsMap.values()], [fontsMap])

  const [draft, setDraft] = useState<StyleFormValues | null>(style ? styleFormFromConfig(style) : null)
  const [fontLoading, setFontLoading] = useState<string | null>(null)
  const [fontError, setFontError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The store is the source of truth: undo/redo, a reset and every commit re-derive the draft.
  // Adjusted during render rather than in an effect (react-hooks/set-state-in-effect; the React
  // docs' "adjusting state when a prop changes" pattern) so the stale draft never paints.
  const [renderedStyle, setRenderedStyle] = useState(style)
  if (style !== renderedStyle) {
    setRenderedStyle(style)
    setDraft(style ? styleFormFromConfig(style) : null)
  }

  if (!style || !draft) return null

  // StyleDefaults-shaped fallbacks for the preview; in values mode every field is set, so
  // they are never shown.
  const defaults = {
    font_file: style.font_file, text_color: style.text_color, marker_color: style.marker_color,
    leader_color: style.leader_color, halo: style.halo, halo_color: style.halo_color,
    show_aliases: style.show_aliases, name_preference: style.name_preference, max_aliases: style.max_aliases,
  }

  const onChange = <K extends keyof StyleFormValues>(key: K, value: StyleFormValues[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d))
    if (key === 'font_file') {
      void changeFont(value as string)
      return
    }
    if (key === 'text_color' || key === 'marker_color' || key === 'leader_color' || key === 'halo_color') return
    const patch = patchForField(key, value)
    if (patch) setStyle(patch)
  }

  const onColorCommit = (key: ColorKey) => {
    const patch = patchForField(key, draft[key])
    if (patch) setStyle(patch)
  }

  async function changeFont(file: string): Promise<void> {
    if (!file || file === style?.font_file) return
    setFontLoading(file)
    setFontError(null)
    try {
      await loadBundledFont(file)
      useEditor.getState().setStyle({ font_file: file })
    } catch (err) {
      setFontError(pageError(err))
      const current = useEditor.getState().style
      if (current) setDraft(styleFormFromConfig(current))
    } finally {
      setFontLoading(null)
    }
  }

  async function resetToSiteDefaults(): Promise<void> {
    if (!imageId) return
    setBusy(true)
    setError(null)
    try {
      const def = await api.imageDefaultStyle(imageId)
      await loadBundledFont(def.font_file)
      useEditor.getState().setStyle(def)
    } catch (err) {
      setError(pageError(err))
    } finally {
      setBusy(false)
    }
  }

  const fontNote = fontLoading ? `Loading ${fontLoading}…` : (fontError ?? (fallback ? fallbackSentence(fallback) : null))

  return (
    <div className="tab-body">
      <StyleForm mode="values" values={draft} defaults={defaults} fonts={fonts} disabled={!editable || fontLoading !== null} fontNote={fontNote} onChange={onChange} onColorCommit={onColorCommit}>
        <div className="tab-actions">
          <button className="secondary" disabled={!editable || busy} onMouseDown={(e) => e.preventDefault()} onClick={() => void resetToSiteDefaults()}>
            {busy ? 'Resetting…' : 'Reset to site defaults'}
          </button>
        </div>
      </StyleForm>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
