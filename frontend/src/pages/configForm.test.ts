import { describe, expect, it } from 'vitest'
import type { ConfigOut } from '../api'
import { buildUpdate, overridesFromStyleForm, sameOverrides, styleFormFromOverrides, type StyleForm } from './configForm'

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

  describe('buildUpdate', () => {
    const config: ConfigOut = {
      site_title: 'Sky',
      max_upload_mb: 60,
      nova_api_key_set: true,
      default_style: { font_file: 'Roboto-Bold.ttf' },
      style_defaults: {
        font_file: 'Inter-Regular.ttf',
        text_color: '#FFFFFF',
        marker_color: '#FFD54A',
        leader_color: '#FFD54A',
        halo: true,
        halo_color: '#000000',
        show_aliases: true,
        name_preference: 'popular',
      },
      locked: [],
      locked_by: {},
    }
    const form = { siteTitle: 'Sky', uploadMb: '60', novaKey: '', clearKey: false, style: { ...empty, font_file: 'Roboto-Bold.ttf' } }

    it('sends nothing when nothing changed', () => {
      expect(buildUpdate(form, config)).toEqual({})
    })

    it('sends only the changed scalars, trimmed, and treats a blank limit as unchanged', () => {
      expect(buildUpdate({ ...form, siteTitle: '  New sky ', uploadMb: '' }, config)).toEqual({ site_title: 'New sky' })
      expect(buildUpdate({ ...form, uploadMb: '12' }, config)).toEqual({ max_upload_mb: 12 })
    })

    it('never sends a locked field', () => {
      const locked = { ...config, locked: ['site_title', 'max_upload_mb'], locked_by: { site_title: 'ASTROCAPTION_SITE_TITLE', max_upload_mb: 'ASTROCAPTION_MAX_UPLOAD_MB' } }
      expect(buildUpdate({ ...form, siteTitle: 'Other', uploadMb: '9' }, locked)).toEqual({})
    })

    it('lets "remove the key" win over a typed key', () => {
      expect(buildUpdate({ ...form, novaKey: ' abc ' }, config)).toEqual({ nova_api_key: 'abc' })
      expect(buildUpdate({ ...form, novaKey: 'abc', clearKey: true }, config)).toEqual({ nova_api_key: null })
    })

    it('sends default_style as the whole set only when it differs, keeping the stored font', () => {
      const changed = buildUpdate({ ...form, style: { ...form.style, text_color: '#ff8800' } }, config)
      expect(changed).toEqual({ default_style: { font_file: 'Roboto-Bold.ttf', text_color: '#ff8800' } })
    })
  })
})
