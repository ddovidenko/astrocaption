import { describe, expect, it } from 'vitest'
import raw from '../../../tests/fixtures/render/vectors.json'
import type { FontOut, Label, LeaderMode, ObjectOut, StyleConfig } from '../api'
import {
  ANCHORS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  anchorBox,
  ascentFor,
  labelText,
  leaderSegment,
  leaderVisible,
  markerRadius,
  measureLabel,
  roundHalfEven,
  scaleUnit,
  type Anchor,
  type Box,
  type TextMeasurer,
} from './metrics'

interface LabelCase {
  style: StyleConfig
  label: Label
  object: ObjectOut
  text: { primary: string; alias: string | null }
  box: {
    width: number
    height: number
    primary_size: number
    alias_size: number
    line1_height: number
    line2_height: number
  }
  marker_radius: number
  widths: { primary: number; alias: number | null }
  ascents: { primary: number; alias: number | null }
}
interface LeaderCase {
  cx: number
  cy: number
  r: number
  s: number
  box: Box
  segment: { from: [number, number]; to: [number, number]; gap: number } | null
  visible: Record<LeaderMode, boolean>
}
interface AnchorCase {
  anchor: Anchor
  cx: number
  cy: number
  offset: number
  w: number
  h: number
  box: Box
}
interface Vectors {
  min_font_size: number
  max_font_size: number
  fonts: FontOut[]
  texts: [string, number, string, number][]
  labels: LabelCase[]
  leaders: LeaderCase[]
  anchors: AnchorCase[]
}

const vectors = raw as unknown as Vectors
const fontByFile = new Map(vectors.fonts.map((f) => [f.file, f]))
const EPS = 1e-6 // the generator rounds to six decimals

/** Pillow's widths stand in for the canvas; the arithmetic on top of them is what this file pins. */
function pillowMeasurer(): TextMeasurer {
  const key = (file: string, size: number, text: string) => JSON.stringify([file, size, text])
  const widths = new Map<string, number>()
  for (const [file, size, text, width] of vectors.texts) widths.set(key(file, size, text), width)
  for (const c of vectors.labels) {
    widths.set(key(c.style.font_file, c.box.primary_size, c.text.primary), c.widths.primary)
    if (c.text.alias !== null && c.widths.alias !== null) {
      widths.set(key(c.style.font_file, c.box.alias_size, c.text.alias), c.widths.alias)
    }
  }
  return (text, file, size) => {
    const width = widths.get(key(file, size, text))
    if (width === undefined) throw new Error(`no Pillow width for ${file} ${size}px ${JSON.stringify(text)}`)
    return width
  }
}

function expectBox(got: Box, want: Box): void {
  expect(Math.abs(got.left - want.left)).toBeLessThanOrEqual(EPS)
  expect(Math.abs(got.top - want.top)).toBeLessThanOrEqual(EPS)
  expect(Math.abs(got.right - want.right)).toBeLessThanOrEqual(EPS)
  expect(Math.abs(got.bottom - want.bottom)).toBeLessThanOrEqual(EPS)
}

describe('render vectors', () => {
  it('loaded the contract the Python side generated', () => {
    expect(vectors.min_font_size).toBe(MIN_FONT_SIZE)
    expect(vectors.max_font_size).toBe(MAX_FONT_SIZE)
    expect(vectors.fonts.length).toBeGreaterThan(0)
    expect(vectors.labels.length).toBeGreaterThan(0)
  })

  it('rounds halves to even like Python', () => {
    expect(roundHalfEven(10.5)).toBe(10)
    expect(roundHalfEven(17.5)).toBe(18)
    expect(roundHalfEven(24.5)).toBe(24)
    expect(roundHalfEven(31.499999999999996)).toBe(31)
    expect(roundHalfEven(2.5)).toBe(2)
    expect(roundHalfEven(3.5)).toBe(4)
    expect(roundHalfEven(4.2)).toBe(4)
    expect(roundHalfEven(4.7)).toBe(5)
  })

  it('has an ascent for every allowed size and refuses the rest', () => {
    for (const font of vectors.fonts) {
      expect(font.ascents).toHaveLength(MAX_FONT_SIZE - MIN_FONT_SIZE + 1)
      expect(ascentFor(font, MIN_FONT_SIZE)).toBe(font.ascents[0])
      expect(ascentFor(font, MAX_FONT_SIZE)).toBe(font.ascents[font.ascents.length - 1])
      expect(() => ascentFor(font, MIN_FONT_SIZE - 1)).toThrow(RangeError)
      expect(() => ascentFor(font, MAX_FONT_SIZE + 1)).toThrow(RangeError)
    }
  })

  it('covers the sizes where Python and JavaScript rounding differ', () => {
    const sizes = new Set(vectors.labels.map((c) => c.box.primary_size))
    expect(sizes).toContain(15)
    expect(sizes).toContain(35)
  })

  it('reproduces every label box, text, marker radius and ascent', () => {
    const measure = pillowMeasurer()
    for (const c of vectors.labels) {
      const font = fontByFile.get(c.style.font_file)
      expect(font, c.style.font_file).toBeDefined()
      expect(labelText(c.object, c.label, c.style)).toEqual(c.text)
      expect(measureLabel(measure, c.style, c.label, c.object)).toEqual({
        width: c.box.width,
        height: c.box.height,
        primarySize: c.box.primary_size,
        aliasSize: c.box.alias_size,
        line1Height: c.box.line1_height,
        line2Height: c.box.line2_height,
      })
      expect(markerRadius(c.object, c.style)).toBe(c.marker_radius)
      expect(ascentFor(font!, c.box.primary_size)).toBe(c.ascents.primary)
      if (c.ascents.alias !== null) expect(ascentFor(font!, c.box.alias_size)).toBe(c.ascents.alias)
    }
  })

  it('reproduces every leader segment and its visibility per mode', () => {
    const label = (mode: LeaderMode): Label => ({
      object_id: 1,
      enabled: true,
      x: 0,
      y: 0,
      font_size: null,
      text_override: null,
      color: null,
      show_aliases: null,
      leader: mode,
      collided: false,
    })
    expect(scaleUnit(3000, 2000)).toBe(vectors.leaders[0]!.s)
    for (const c of vectors.leaders) {
      const seg = leaderSegment(c.cx, c.cy, c.r, c.box)
      if (c.segment === null) {
        expect(seg).toBeNull()
      } else {
        expect(seg).not.toBeNull()
        expect(Math.abs(seg!.from[0] - c.segment.from[0])).toBeLessThanOrEqual(EPS)
        expect(Math.abs(seg!.from[1] - c.segment.from[1])).toBeLessThanOrEqual(EPS)
        expect(Math.abs(seg!.to[0] - c.segment.to[0])).toBeLessThanOrEqual(EPS)
        expect(Math.abs(seg!.to[1] - c.segment.to[1])).toBeLessThanOrEqual(EPS)
        expect(Math.abs(seg!.gap - c.segment.gap)).toBeLessThanOrEqual(EPS)
      }
      for (const mode of ['auto', 'on', 'off'] as const) {
        const drawn = seg !== null && leaderVisible(label(mode), seg.gap, c.s)
        expect(drawn, `${JSON.stringify(c.box)} ${mode}`).toBe(c.visible[mode])
      }
    }
  })

  it('reproduces every anchor box', () => {
    expect(vectors.anchors.map((c) => c.anchor).slice(0, ANCHORS.length)).toEqual([...ANCHORS])
    for (const c of vectors.anchors) {
      expectBox(anchorBox(c.anchor, c.cx, c.cy, c.offset, c.w, c.h), c.box)
    }
  })
})
