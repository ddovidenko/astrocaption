import { describe, expect, it } from 'vitest'
import type { StyleDefaults } from '../api'
import { styleFormFromOverrides } from './configForm'
import { fontFamilyFor, previewGeometry, previewLines } from './labelPreview'

const defaults: StyleDefaults = {
  font_file: 'Inter-Regular.ttf',
  text_color: '#FFFFFF',
  marker_color: '#FFD54A',
  leader_color: '#FFD54A',
  halo: true,
  halo_color: '#000000',
  show_aliases: true,
  name_preference: 'popular',
}

describe('label preview', () => {
  it('puts the preferred catalogue first', () => {
    expect(previewLines('', 'popular').primary).toBe('M 42')
    expect(previewLines('', 'ngc_ic').primary).toBe('NGC 1976')
    expect(previewLines('ngc_ic', 'popular')).toEqual({ primary: 'NGC 1976', aliases: 'M 42 · Orion Nebula' })
  })

  it('names the font family after the file stem', () => {
    expect(fontFamilyFor('Roboto-Bold.ttf')).toBe('Roboto-Bold')
    expect(fontFamilyFor('IBMPlexSans-Regular.TTF')).toBe('IBMPlexSans-Regular')
  })

  it('keeps widths relative to the font size and doubles the halo for an outward stroke', () => {
    const base = previewGeometry(styleFormFromOverrides({}), defaults)
    expect(base.markerWidth).toBeCloseTo((2 * 22) / 24)
    expect(base.haloWidth).toBeCloseTo(((2 * 22) / 24) * 2)
    expect(base.aliasSize).toBeCloseTo(22 * 0.7)
    expect(base.aliasOffset).toBeCloseTo(22 * 1.2)
    const bigger = previewGeometry(styleFormFromOverrides({ font_size: 48, marker_width: 4 }), defaults)
    expect(bigger.markerWidth).toBeCloseTo(base.markerWidth) // same ratio to the font, same look
    expect(previewGeometry(styleFormFromOverrides({ halo: false }), defaults).haloWidth).toBe(0)
  })
})
