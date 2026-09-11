import { useEffect, useState } from 'react'
import type { StyleDefaults } from '../api'
import type { StyleForm } from './configForm'

/** Fixed stars so the preview is the same every time. */
const STARS = [
  [12, 18, 1.2], [58, 62, 0.8], [140, 28, 1.6], [210, 90, 0.7], [305, 40, 1.1], [372, 74, 0.9],
  [430, 22, 1.4], [500, 66, 0.8], [545, 30, 1.0], [80, 108, 0.6], [250, 118, 1.3], [470, 112, 0.7],
] as const

const PREVIEW_SIZE = 22 // the label's font size inside this strip, whatever the image would use
/** One object, two ways round: the primary line follows the name preference (SPEC § 6.3). */
const LINES = {
  popular: { primary: 'M 42', aliases: 'NGC 1976 · Orion Nebula' },
  ngc_ic: { primary: 'NGC 1976', aliases: 'M 42 · Orion Nebula' },
} as const

function fontFamilyFor(file: string): string {
  return file.replace(/\.ttf$/i, '')
}

/** Loads a bundled font into the document so the preview can use it; the family name is the
 *  file stem, so browser and export agree on which file is meant (CLAUDE.md). */
function useBundledFont(file: string): string {
  const family = fontFamilyFor(file)
  const [ready, setReady] = useState<string | null>(null)
  useEffect(() => {
    if (typeof FontFace === 'undefined') return
    let cancelled = false
    const face = new FontFace(family, `url(/fonts/${file})`)
    face
      .load()
      .then((loaded) => {
        document.fonts.add(loaded)
        if (!cancelled) setReady(family)
      })
      .catch(() => undefined) // a missing file leaves the fallback family in place
    return () => {
      cancelled = true
    }
  }, [family, file])
  return ready === family ? family : 'Inter, system-ui, sans-serif'
}

/** The label as the export would draw it, at a fixed size, updating with every edit. */
export default function LabelPreview({ style, defaults }: { style: StyleForm; defaults: StyleDefaults }) {
  const fontFile = style.font_file || defaults.font_file
  const family = useBundledFont(fontFile)
  const text = style.text_color || defaults.text_color
  const marker = style.marker_color || defaults.marker_color
  const leader = style.leader_color || defaults.leader_color
  const haloOn = style.halo === '' ? defaults.halo : style.halo === 'on'
  const haloColor = style.halo_color || defaults.halo_color
  const aliasesOn = style.show_aliases === '' ? defaults.show_aliases : style.show_aliases === 'on'
  const lines = LINES[style.name_preference || defaults.name_preference]
  // Widths are stored in image pixels; the preview keeps their ratio to the font size.
  const scale = PREVIEW_SIZE / (Number(style.font_size) || 24)
  const px = (v: string, fallback: number) => Math.max(0.5, (Number(v) || fallback) * scale)
  const haloWidth = haloOn ? px(style.halo_width, 2) * 2 : 0
  const markerWidth = px(style.marker_width, 2)
  const aliasSize = PREVIEW_SIZE * 0.7

  return (
    <svg className="preview" viewBox="0 0 560 130" role="img" aria-label="Preview of a label in the chosen style">
      <rect width="560" height="130" fill="#05070d" />
      {STARS.map(([x, y, r]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill="#d8e0ff" opacity="0.85" />
      ))}
      <circle cx="120" cy="72" r="34" fill="none" stroke={marker} strokeWidth={markerWidth} />
      <line x1="154" y1="72" x2="196" y2="62" stroke={leader} strokeWidth={markerWidth} />
      <text
        x="204"
        y={aliasesOn ? 62 : 70}
        fill={text}
        stroke={haloColor}
        strokeWidth={haloWidth}
        paintOrder="stroke"
        strokeLinejoin="round"
        fontFamily={family}
        fontSize={PREVIEW_SIZE}
      >
        {lines.primary}
      </text>
      {aliasesOn && (
        <text
          x="204"
          y={62 + aliasSize * 1.3}
          fill={text}
          stroke={haloColor}
          strokeWidth={haloWidth}
          paintOrder="stroke"
          strokeLinejoin="round"
          fontFamily={family}
          fontSize={aliasSize}
          opacity="0.9"
        >
          {lines.aliases}
        </text>
      )}
    </svg>
  )
}
