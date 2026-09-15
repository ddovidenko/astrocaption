import { useEffect, useMemo, useRef, useState } from 'react'
import { api, pageError, type FontOut, type StyleConfig } from '../api'
import StyleForm from '../style/StyleForm'
import { styleFormFromConfig, type ColorKey, type NumberKey, type StyleForm as StyleFormValues } from '../style/styleForm'
import { loadBundledFont } from './fonts'
import { isEditable, useEditor } from './store'
import { fallbackSentence, isNumberKey, patchForField } from './styleTab'

/** One pending debounced commit for a number field: the patch is fixed at schedule time (the
 *  keystroke that (re)started the wait), so a later keystroke cancels and replaces the whole
 *  entry rather than mutating it. */
interface PendingNumberCommit {
  timer: ReturnType<typeof setTimeout>
  patch: Partial<StyleConfig>
}

/** A number field commits this long after the last keystroke that left it valid, so typing
 *  "24" → "100" digit by digit is one undo entry, not four (#94). Blur and Enter flush at once. */
const NUMBER_DEBOUNCE_MS = 400

/** The image's global style, edited live (SPEC § 6.3). Each committed field is one undo entry;
 *  a font is committed only once the browser has loaded it, so the canvas never measures an
 *  unloaded family (#62); colours commit when their picker closes; numbers commit debounced
 *  (above). */
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

  // Pending debounced commits, one timer per number field. A patch is captured when the timer is
  // (re)scheduled, so the value that eventually lands is the one from the keystroke that started
  // this timer's 400ms — the correct "debounce of the latest value" once later keystrokes cancel
  // and reschedule it.
  const numberTimers = useRef<Partial<Record<NumberKey, PendingNumberCommit>>>({})

  // Whenever `style` moves to a new object — from its own commit landing, from elsewhere
  // (undo/redo/reset), or from the component unmounting (switching tabs never blurs the input
  // first, so discarding here would silently drop a still-in-flight, already-valid edit) — every
  // still-pending debounced commit is flushed, not discarded: its captured patch commits now
  // rather than waiting out the rest of its 400ms. An effect, not the render body below: refs may
  // be read and written only outside render (react-hooks/refs).
  useEffect(() => {
    return () => {
      for (const entry of Object.values(numberTimers.current)) {
        if (!entry) continue
        clearTimeout(entry.timer)
        setStyle(entry.patch)
      }
      numberTimers.current = {}
    }
  }, [style, setStyle])

  // The store is the source of truth: undo/redo, a reset and every commit re-derive the draft.
  // Adjusted during render rather than in an effect (react-hooks/set-state-in-effect; the React
  // docs' "adjusting state when a prop changes" pattern) so the stale draft never paints.
  const [renderedStyle, setRenderedStyle] = useState(style)
  if (style !== renderedStyle) {
    setRenderedStyle(style)
    setDraft(style ? styleFormFromConfig(style) : null)
    setFontError(null)
  }

  if (!style || !draft) return null

  // StyleDefaults-shaped fallbacks for the preview; in values mode every field is set, so
  // they are never shown.
  const defaults = {
    font_file: style.font_file, text_color: style.text_color, marker_color: style.marker_color,
    leader_color: style.leader_color, halo: style.halo, halo_color: style.halo_color,
    show_aliases: style.show_aliases, name_preference: style.name_preference, max_aliases: style.max_aliases,
  }

  /** (Re)starts a field's debounce: any previous wait for this field is cancelled, and — while
   *  the text is currently a value the API accepts — a fresh 400ms wait begins for exactly that
   *  patch. Text that is not currently valid (out of bounds, mid-edit) leaves nothing scheduled,
   *  so an invalid keystroke can never commit a stale prior value later. */
  const scheduleNumberCommit = (key: NumberKey, raw: string) => {
    const pending = numberTimers.current[key]
    if (pending) clearTimeout(pending.timer)
    const patch = patchForField(key, raw)
    if (!patch) {
      delete numberTimers.current[key]
      return
    }
    numberTimers.current[key] = {
      patch,
      timer: setTimeout(() => {
        delete numberTimers.current[key]
        setStyle(patch)
      }, NUMBER_DEBOUNCE_MS),
    }
  }

  /** Commits a field's pending debounce at once (blur, Enter) instead of waiting out the timer. */
  const flushNumberCommit = (key: NumberKey) => {
    const pending = numberTimers.current[key]
    if (!pending) return
    clearTimeout(pending.timer)
    delete numberTimers.current[key]
    setStyle(pending.patch)
  }

  const onChange = <K extends keyof StyleFormValues>(key: K, value: StyleFormValues[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d))
    if (key === 'font_file') {
      void changeFont(value as string)
      return
    }
    if (key === 'text_color' || key === 'marker_color' || key === 'leader_color' || key === 'halo_color') return
    if (isNumberKey(key)) {
      scheduleNumberCommit(key, value as string)
      return
    }
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
      <StyleForm
        mode="values"
        values={draft}
        defaults={defaults}
        fonts={fonts}
        disabled={!editable || fontLoading !== null || busy}
        fontNote={fontNote}
        onChange={onChange}
        onColorCommit={onColorCommit}
        onNumberFlush={flushNumberCommit}
      >
        <div className="tab-actions">
          <button
            className="secondary"
            disabled={!editable || busy || fontLoading !== null}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void resetToSiteDefaults()}
          >
            {busy ? 'Resetting…' : 'Reset to site defaults'}
          </button>
        </div>
      </StyleForm>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
