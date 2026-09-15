import { describe, expect, it } from 'vitest'
import type { StyleDefaults } from '../api'
import { fontFamilyFor } from '../editor/metrics'
import { styleFormFromOverrides } from './styleForm'
import { previewCap, previewGeometry, previewLines, previewTextSize } from './labelPreview'

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

  it('scales the drawn text with the font size inside a readable band', () => {
    expect(previewTextSize('', 24)).toBeCloseTo(22)
    expect(previewTextSize('48', 24)).toBeCloseTo(40) // 44 clamped
    expect(previewTextSize('12', 24)).toBeCloseTo(12) // 11 clamped
    expect(previewTextSize('36', 24)).toBeCloseTo(33)
    expect(previewTextSize('abc', 24)).toBeCloseTo(22)
    expect(previewTextSize('Infinity', 24)).toBeCloseTo(22)
    expect(previewTextSize('-5', 24)).toBeCloseTo(22)
  })
  it('keeps widths in proportion to the drawn text and doubles the halo for an outward stroke', () => {
    const base = previewGeometry(styleFormFromOverrides({}), defaults)
    expect(base.textSize).toBeCloseTo(22)
    expect(base.markerWidth).toBeCloseTo((2 * 22) / 24)
    expect(base.haloWidth).toBeCloseTo(((2 * 22) / 24) * 2)
    expect(base.aliasSize).toBeCloseTo(22 * 0.7)
    expect(base.aliasOffset).toBeCloseTo(22 * 1.2)
    const bigger = previewGeometry(styleFormFromOverrides({ font_size: 36, marker_width: 3 }), defaults)
    expect(bigger.textSize).toBeCloseTo(33)
    expect(bigger.markerWidth).toBeCloseTo((3 * 33) / 36) // same ratio to the text as 3 px to 36 px
    expect(previewGeometry(styleFormFromOverrides({ halo: false }), defaults).haloWidth).toBe(0)
  })

  it('treats a negative font size as unset', () => {
    const negative = previewGeometry(styleFormFromOverrides({ font_size: -5 }), defaults)
    const unset = previewGeometry(styleFormFromOverrides({}), defaults)
    expect(negative.textSize).toBeCloseTo(unset.textSize)
    expect(negative.markerWidth).toBeCloseTo(unset.markerWidth)
    expect(negative.haloWidth).toBeCloseTo(unset.haloWidth)
    expect(negative.aliasSize).toBeCloseTo(unset.aliasSize)
    expect(negative.aliasOffset).toBeCloseTo(unset.aliasOffset)
  })

  it('clamps the max-aliases field to 0..MAX_ALIASES, falling back on blank or unparseable input', () => {
    expect(previewCap('', 2)).toBe(2)
    expect(previewCap('3', 2)).toBe(3)
    expect(previewCap('-1', 2)).toBe(0)
    expect(previewCap('9', 2)).toBe(5)
    expect(previewCap('abc', 2)).toBe(2)
  })
})
