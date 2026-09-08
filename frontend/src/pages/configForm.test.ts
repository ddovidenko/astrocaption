import { describe, expect, it } from 'vitest'
import { overridesFromStyleForm, styleFormFromOverrides, type StyleForm } from './configForm'

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

  it('leaves a non-numeric size for the server to reject rather than guessing', () => {
    expect(overridesFromStyleForm({ ...empty, marker_width: 'abc' })).toEqual({ marker_width: NaN })
  })
})
