import { useId, type ReactNode } from 'react'
import type { FontOut, StyleDefaults } from '../api'
import ColorField from './ColorField'
import LabelPreview from './LabelPreview'
import {
  NUMBER_BOUNDS,
  otherPreference,
  parseNumberField,
  PREFERENCE_LABELS,
  type ColorKey,
  type NumberKey,
  type Tri,
  type TriKey,
  type StyleForm as StyleFormValues,
} from './styleForm'

const FONTS_UNAVAILABLE = 'The font list could not be loaded; the saved font is kept.'

export interface StyleFormProps {
  mode: 'overrides' | 'values'
  values: StyleFormValues
  /** Built-ins shown for blank fields (overrides mode) and the preview's fallbacks. */
  defaults: StyleDefaults
  /** null: the font list could not be loaded. */
  fonts: FontOut[] | null
  disabled?: boolean
  /** Shown under the font select (a fallback notice, "Loading…", or a load error). */
  fontNote?: string | null
  onChange: <K extends keyof StyleFormValues>(key: K, value: StyleFormValues[K]) => void
  /** values mode only: a colour picker closed or a hex was typed — commit the current value.
   *  `hex` is set for a typed commit (the just-typed value); undefined for a close, where the
   *  caller commits whatever it already has for `key`. */
  onColorCommit?: (key: ColorKey, hex?: string) => void
  /** values mode only: a number field lost focus, or Enter was pressed in it — commit its
   *  currently-debounced value at once rather than waiting out the debounce. */
  onNumberFlush?: (key: NumberKey) => void
  /** Rendered above the grid, after the preview (the config page's note; the Style tab's reset button). */
  children?: ReactNode
}

export default function StyleForm({
  mode,
  values,
  defaults: d,
  fonts,
  disabled = false,
  fontNote = null,
  onChange,
  onColorCommit,
  onNumberFlush,
  children,
}: StyleFormProps) {
  const overrides = mode === 'overrides'
  const fontList = fonts ?? []
  const fontsLoaded = fonts !== null
  const formId = useId()
  const fieldId = (key: string) => `${formId}-${key}`
  const numberField = (label: string, key: NumberKey, placeholder = 'auto') => {
    const [min, max] = NUMBER_BOUNDS[key]
    // Values mode holds a concrete style at all times, so a blank or out-of-bounds field there is
    // always wrong (never "use the default", as it would be in overrides mode) — flag it rather
    // than let it silently fail to commit (StyleTab's patchForField returns null for it).
    const bad = !overrides && parseNumberField(key, values[key]) === null
    const id = fieldId(key)
    const noteId = `${id}-note`
    return (
      <div className="field" key={key}>
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          step={1}
          required={!overrides}
          placeholder={overrides ? placeholder : undefined}
          disabled={disabled}
          value={values[key]}
          aria-invalid={bad || undefined}
          aria-describedby={bad ? noteId : undefined}
          onChange={(e) => onChange(key, e.target.value)}
          onBlur={() => onNumberFlush?.(key)}
          onKeyDown={(e) => {
            // Only the Style tab passes onNumberFlush; the config page's number inputs have no
            // debounce to flush, and Enter there must still submit the form as it always has.
            if (e.key === 'Enter' && onNumberFlush) {
              e.preventDefault()
              onNumberFlush(key)
            }
          }}
        />
        {bad && (
          <span className="field-note" id={noteId}>
            Whole number between {min} and {max}.
          </span>
        )}
      </div>
    )
  }
  const triField = (label: string, key: TriKey) => {
    const id = fieldId(key)
    return (
      <div className="field" key={key}>
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        <select id={id} value={values[key]} disabled={disabled} onChange={(e) => onChange(key, e.target.value as Tri)}>
          {overrides && <option value="">Default ({d[key] ? 'on' : 'off'})</option>}
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </div>
    )
  }
  const colorField = (label: string, key: ColorKey) => (
    <ColorField
      key={key}
      label={label}
      value={values[key]}
      fallback={d[key]}
      allowDefault={overrides}
      disabled={disabled}
      onChange={(hex) => onChange(key, hex)}
      onCommit={(hex) => onColorCommit?.(key, hex)}
    />
  )
  const fontMissing = values.font_file !== '' && !fontList.some((f) => f.file === values.font_file)
  return (
    <>
      <LabelPreview style={values} defaults={d} />
      {children}
      <div className="grid3">
        <div className="field span2">
          <label className="field-label" htmlFor={fieldId('font_file')}>
            Font
          </label>
          <select
            id={fieldId('font_file')}
            value={values.font_file}
            disabled={disabled || !fontsLoaded}
            onChange={(e) => onChange('font_file', e.target.value)}
          >
            {overrides && <option value="">Default ({d.font_file})</option>}
            {fontMissing && (
              <option value={values.font_file}>{fontsLoaded ? `${values.font_file} (not installed)` : values.font_file}</option>
            )}
            {fontList.map((f) => (
              <option key={f.file} value={f.file}>
                {f.family} {f.weight}
              </option>
            ))}
          </select>
          {!fontsLoaded && <span className="field-note">{FONTS_UNAVAILABLE}</span>}
          {fontNote && <span className="field-note">{fontNote}</span>}
        </div>
        {numberField('Font size (px)', 'font_size')}
        <div className="field span2">
          <label className="field-label" htmlFor={fieldId('name_preference')}>
            Primary name
          </label>
          <select
            id={fieldId('name_preference')}
            value={values.name_preference}
            disabled={disabled}
            onChange={(e) => onChange('name_preference', e.target.value as StyleFormValues['name_preference'])}
          >
            {overrides ? (
              <>
                <option value="">Default ({PREFERENCE_LABELS[d.name_preference]})</option>
                {values.name_preference === d.name_preference && (
                  <option value={values.name_preference}>{PREFERENCE_LABELS[values.name_preference]} (same as default)</option>
                )}
                <option value={otherPreference(d.name_preference)}>{PREFERENCE_LABELS[otherPreference(d.name_preference)]}</option>
              </>
            ) : (
              <>
                <option value="popular">{PREFERENCE_LABELS.popular}</option>
                <option value="ngc_ic">{PREFERENCE_LABELS.ngc_ic}</option>
              </>
            )}
          </select>
        </div>
        {triField('Alias line', 'show_aliases')}
        {numberField('Aliases shown (max)', 'max_aliases', `Default (${d.max_aliases})`)}
        {colorField('Text colour', 'text_color')}
        {colorField('Marker colour', 'marker_color')}
        {colorField('Leader colour', 'leader_color')}
        {triField('Halo', 'halo')}
        {colorField('Halo colour', 'halo_color')}
        {numberField('Halo width (px)', 'halo_width')}
        {numberField('Marker line width (px)', 'marker_width')}
        {numberField('Marker min radius (px)', 'marker_min_radius')}
      </div>
    </>
  )
}
