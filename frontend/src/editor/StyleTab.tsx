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
  const historySeq = useEditor((s) => s.historySeq)
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

  // Pending debounced commits, one timer per number field; the patch is captured when the timer
  // is (re)scheduled, so the value that lands is the one from the keystroke that started the wait.
  const numberTimers = useRef<Partial<Record<NumberKey, PendingNumberCommit>>>({})

  /** Removes a field's pending commit and returns its patch, or null when nothing was pending. */
  const takePending = (key: NumberKey): Partial<StyleConfig> | null => {
    const entry = numberTimers.current[key]
    if (!entry) return null
    clearTimeout(entry.timer)
    delete numberTimers.current[key]
    return entry.patch
  }
  const pendingKeys = () => Object.keys(numberTimers.current) as NumberKey[]

  // Cancel when the style changes or history moves (undo/redo), even one that only touched
  // labels: a value typed before the undo would otherwise land on top of what it restored. A
  // timer that just fired deleted its own entry before calling setStyle, so it never cancels
  // itself.
  useEffect(() => {
    for (const key of pendingKeys()) takePending(key)
  }, [style, historySeq])

  // Flush on unmount only (a tab switch never blurs the input either): a valid edit still waiting
  // out its debounce commits instead of vanishing. StrictMode's extra pass sees an empty map.
  useEffect(() => {
    return () => {
      for (const key of pendingKeys()) {
        const patch = takePending(key)
        if (patch) useEditor.getState().setStyle(patch)
      }
    }
  }, [])

  // The store is the source of truth: undo/redo, a reset and every commit re-derive the draft.
  // historySeq is tracked alongside style: an undo/redo that only touched labels leaves the style
  // object itself unchanged, but a number field's stale, not-yet-committed draft value must still
  // be dropped in favour of what history just restored (the cancel effect above only clears the
  // timer; this is what makes the input stop showing the discarded keystroke).
  // Adjusted during render rather than in an effect (react-hooks/set-state-in-effect; the React
  // docs' "adjusting state when a prop changes" pattern) so the stale draft never paints.
  const [renderedStyle, setRenderedStyle] = useState(style)
  const [renderedHistorySeq, setRenderedHistorySeq] = useState(historySeq)
  if (style !== renderedStyle || historySeq !== renderedHistorySeq) {
    setRenderedStyle(style)
    setRenderedHistorySeq(historySeq)
    setDraft(style ? styleFormFromConfig(style) : null)
    setFontError(null)
  }

  if (!style || !draft) return null

  /** (Re)starts a field's debounce: any previous wait for this field is cancelled, and — while
   *  the text is currently a value the API accepts — a fresh 400ms wait begins for exactly that
   *  patch. Text that is not currently valid (out of bounds, mid-edit) leaves nothing scheduled,
   *  so an invalid keystroke can never commit a stale prior value later. */
  const scheduleNumberCommit = (key: NumberKey, raw: string) => {
    takePending(key)
    const patch = patchForField(key, raw)
    if (!patch) return
    numberTimers.current[key] = {
      patch,
      timer: setTimeout(() => {
        if (takePending(key)) setStyle(patch)
      }, NUMBER_DEBOUNCE_MS),
    }
  }

  /** Commits a field's pending debounce at once (blur, Enter) instead of waiting out the timer. */
  const flushNumberCommit = (key: NumberKey) => {
    const patch = takePending(key)
    if (patch) setStyle(patch)
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

  const onColorCommit = (key: ColorKey, hex?: string) => {
    // A typed commit carries the just-typed hex, since `draft` here is whatever the last render
    // captured — a keystroke's onChange and its onCommit both fire before this closure's own
    // component re-renders, so `draft[key]` can still be the pre-keystroke value (#B).
    const patch = patchForField(key, hex ?? draft[key])
    if (patch) setStyle(patch)
  }

  async function changeFont(file: string): Promise<void> {
    // Choosing the font already in use is normally a no-op, except while a fallback notice is
    // pending: the notice promises that "picking a font" clears it, and store.setStyle lets that
    // same-value patch through in that case (#C), so it must reach setStyle here too.
    if (!file || (file === style?.font_file && !fallback)) return
    setFontLoading(file)
    setFontError(null)
    try {
      await loadBundledFont(file)
      useEditor.getState().setStyle({ font_file: file })
    } catch (err) {
      setFontError(pageError(err))
      // Restore only the font field: the rest of the draft may hold edits (a number mid-debounce,
      // say) that a failed font load must not discard.
      const current = useEditor.getState().style
      if (current) setDraft((d) => (d ? { ...d, font_file: current.font_file } : d))
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
        defaults={style}
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
