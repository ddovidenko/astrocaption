import type { StyleConfig } from '../api'
import type { FontFallback } from './store'
import { normalizeHex, parseNumberField, type NumberKey, type StyleForm } from '../style/styleForm'

export const NUMBER_KEYS: readonly NumberKey[] = ['font_size', 'halo_width', 'marker_width', 'marker_min_radius', 'max_aliases']

/** Whether a form field key is one of the debounced number fields (StyleTab commits these on a
 *  400ms pause, not on every keystroke). */
export function isNumberKey(key: string): key is NumberKey {
  return (NUMBER_KEYS as readonly string[]).includes(key)
}

export function fallbackSentence(f: FontFallback): string {
  return `This image was set up with ${f.stored}, which is no longer bundled; labels use ${f.used} until you pick a font. The next save keeps ${f.used}.`
}

/** The store patch for one edited field, or null while the text is not a value the API accepts. */
export function patchForField<K extends keyof StyleForm>(key: K, value: StyleForm[K]): Partial<StyleConfig> | null {
  if (isNumberKey(key)) {
    const n = parseNumberField(key as NumberKey, value as string)
    return n === null ? null : { [key]: n }
  }
  switch (key) {
    case 'halo':
    case 'show_aliases':
      return value === '' ? null : { [key]: value === 'on' }
    case 'name_preference':
      return value === '' ? null : { name_preference: value as StyleConfig['name_preference'] }
    case 'font_file':
      return value === '' ? null : { font_file: value as string }
    default: {
      const hex = normalizeHex(value as string)
      return /^#[0-9a-f]{6}$/i.test(hex) ? { [key]: hex } : null
    }
  }
}
