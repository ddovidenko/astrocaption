import { describe, expect, it } from 'vitest'
import { makeDoc } from '../editor/testDoc'
import {
  otherPreference,
  overridesFromStyleForm,
  parseNumberField,
  PREFERENCE_LABELS,
  styleFormFromConfig,
  styleFormFromOverrides,
  type StyleForm,
} from './styleForm'

const empty: StyleForm = {
  font_file: '',
  font_size: '',
  text_color: '',
  marker_color: '',
  leader_color: '',
  halo: '',
  halo_color: '',
  halo_width: '',
  marker_width: '',
  marker_min_radius: '',
  show_aliases: '',
  max_aliases: '',
  name_preference: '',
}

describe('style form helpers', () => {
  it('round-trips overrides through the form', () => {
    const o = { font_file: 'Roboto-Bold.ttf', font_size: 30, halo: false, text_color: '#ff8800' }
    const form = styleFormFromOverrides(o)
    expect(form).toEqual({ ...empty, font_file: 'Roboto-Bold.ttf', font_size: '30', halo: 'off', text_color: '#ff8800' })
    expect(overridesFromStyleForm(form)).toEqual(o)
  })

  it('treats blanks as "use the default" and drops them', () => {
    expect(overridesFromStyleForm(empty)).toEqual({})
    expect(overridesFromStyleForm({ ...empty, font_size: '  ', halo: 'on' })).toEqual({ halo: true })
  })

  it('treats a non-numeric size as unset', () => {
    expect(overridesFromStyleForm({ ...empty, marker_width: 'abc' })).toEqual({})
  })

  it('round-trips max_aliases and drops it when blank', () => {
    expect(styleFormFromOverrides({ max_aliases: 3 }).max_aliases).toBe('3')
    expect(overridesFromStyleForm({ ...styleFormFromOverrides({}), max_aliases: '0' })).toEqual({ max_aliases: 0 })
    expect(overridesFromStyleForm({ ...styleFormFromOverrides({}), max_aliases: '' })).toEqual({})
  })

  it('names the other preference and labels both', () => {
    expect(otherPreference('popular')).toBe('ngc_ic')
    expect(otherPreference('ngc_ic')).toBe('popular')
    expect(PREFERENCE_LABELS.popular).toContain('Messier')
    expect(PREFERENCE_LABELS.ngc_ic).toContain('NGC')
  })

  describe('values mode helpers', () => {
    it('styleFormFromConfig renders every field as text', () => {
      expect(styleFormFromConfig(makeDoc().annotations.style)).toMatchObject({
        font_size: '24',
        halo: 'on',
        show_aliases: 'off',
        max_aliases: '2',
      })
    })

    it('parseNumberField accepts integers inside the bounds only', () => {
      expect(parseNumberField('font_size', '24')).toBe(24)
      expect(parseNumberField('font_size', '5')).toBeNull()
      expect(parseNumberField('font_size', '201')).toBeNull()
      expect(parseNumberField('font_size', '2.5')).toBeNull()
      expect(parseNumberField('font_size', '')).toBeNull()
      expect(parseNumberField('halo_width', '0')).toBe(0)
      expect(parseNumberField('max_aliases', '6')).toBeNull()
    })
  })
})
