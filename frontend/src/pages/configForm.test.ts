import { describe, expect, it } from 'vitest'
import { overridesFromStyleForm, sameOverrides, styleFormFromOverrides, type StyleForm } from './configForm'

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
  name_preference: '',
}

describe('config form helpers', () => {
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

  it('compares override sets regardless of key order', () => {
    expect(sameOverrides({ halo: false, font_size: 30 }, { font_size: 30, halo: false })).toBe(true)
    expect(sameOverrides({}, {})).toBe(true)
    expect(sameOverrides({ halo: false }, { halo: true })).toBe(false)
    expect(sameOverrides({ halo: false }, {})).toBe(false)
    expect(sameOverrides({ font_size: 30 }, { font_size: 30, halo: false })).toBe(false)
    // An explicit undefined is the same as an absent field: neither is sent.
    expect(sameOverrides({ halo: false, font_size: undefined }, { halo: false })).toBe(true)
  })
})
