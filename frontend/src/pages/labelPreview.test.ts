import { describe, expect, it } from 'vitest'
import type { StyleDefaults } from '../api'
import { fontFamilyFor } from '../editor/metrics'
import { styleFormFromOverrides } from './configForm'
import { previewCap, previewGeometry, previewLines } from './labelPreview'

const defaults: StyleDefaults = {
  font_file: 'Inter-Regular.ttf',
  text_color: '#FFFFFF',
  marker_color: '#FFD54A',
  leader_color: '#FFD54A',
  halo: true,
  halo_color: '#000000',
  show_aliases: true,
  max_aliases: 2,
  name_preference: 'popular',
}

describe('label preview', () => {
  it('builds the sample lines from the alias policy and the cap', () => {
    expect(previewLines('', 'popular', 2)).toEqual({ primary: 'M 42', aliases: 'Great Orion Nebula · NGC 1976' })
    expect(previewLines('', 'ngc_ic', 2)).toEqual({ primary: 'NGC 1976', aliases: 'Great Orion Nebula · M 42' })
    expect(previewLines('ngc_ic', 'popular', 5).aliases).toBe('Great Orion Nebula · M 42 · LBN 974')
    expect(previewLines('popular', 'popular', 1).aliases).toBe('Great Orion Nebula')
    expect(previewLines('popular', 'popular', 0).aliases).toBe('')
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

  it('clamps the max-aliases field to 0..MAX_ALIASES, falling back on blank or unparseable input', () => {
    expect(previewCap('', 2)).toBe(2)
    expect(previewCap('3', 2)).toBe(3)
    expect(previewCap('-1', 2)).toBe(0)
    expect(previewCap('9', 2)).toBe(5)
    expect(previewCap('abc', 2)).toBe(2)
  })
})
