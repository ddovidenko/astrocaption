import { describe, expect, it } from 'vitest'
import { fallbackSentence, isNumberKey, patchForField } from './styleTab'

describe('patchForField', () => {
  it('parses numbers within bounds and refuses the rest', () => {
    expect(patchForField('font_size', '30')).toEqual({ font_size: 30 })
    expect(patchForField('font_size', '3')).toBeNull()
    expect(patchForField('max_aliases', '0')).toEqual({ max_aliases: 0 })
  })
  it('maps tri fields, preference, colours and the font', () => {
    expect(patchForField('halo', 'off')).toEqual({ halo: false })
    expect(patchForField('show_aliases', 'on')).toEqual({ show_aliases: true })
    expect(patchForField('name_preference', 'ngc_ic')).toEqual({ name_preference: 'ngc_ic' })
    expect(patchForField('text_color', '#abc')).toEqual({ text_color: '#aabbcc' })
    expect(patchForField('text_color', 'red')).toBeNull()
    expect(patchForField('font_file', 'Roboto-Bold.ttf')).toEqual({ font_file: 'Roboto-Bold.ttf' })
  })
})
describe('isNumberKey', () => {
  it('picks out the debounced number fields and nothing else', () => {
    expect(isNumberKey('font_size')).toBe(true)
    expect(isNumberKey('halo_width')).toBe(true)
    expect(isNumberKey('marker_width')).toBe(true)
    expect(isNumberKey('marker_min_radius')).toBe(true)
    expect(isNumberKey('max_aliases')).toBe(true)
    expect(isNumberKey('halo')).toBe(false)
    expect(isNumberKey('font_file')).toBe(false)
    expect(isNumberKey('text_color')).toBe(false)
  })
})
describe('fallbackSentence', () => {
  it('names both fonts', () => {
    expect(fallbackSentence({ stored: 'Lato-Regular.ttf', used: 'Inter-Regular.ttf' })).toBe(
      'This image was set up with Lato-Regular.ttf, which is no longer bundled; labels use Inter-Regular.ttf until you pick a font. The next save keeps Inter-Regular.ttf.',
    )
  })
})
