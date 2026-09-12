import { useEffect, useState } from 'react'
import type { StyleDefaults } from '../api'
import { loadBundledFont } from '../editor/fonts'
import { fontFamilyFor } from '../editor/metrics'
import type { StyleForm } from './configForm'
import { PREVIEW_SIZE, previewGeometry, previewLines } from './labelPreview'

/** Fixed stars so the preview is the same every time. */
const STARS = [
  [12, 18, 1.2], [58, 62, 0.8], [140, 28, 1.6], [210, 90, 0.7], [305, 40, 1.1], [372, 74, 0.9],
  [430, 22, 1.4], [500, 66, 0.8], [545, 30, 1.0], [80, 108, 0.6], [250, 118, 1.3], [470, 112, 0.7],
] as const

const FALLBACK_FAMILY = 'Inter, system-ui, sans-serif'

function useBundledFont(file: string): string {
  const [ready, setReady] = useState<string | null>(null)
  useEffect(() => {
    if (typeof FontFace === 'undefined') return
    let cancelled = false
    void loadBundledFont(file).then(
      (family) => {
        if (!cancelled) setReady(family)
      },
      () => {
        if (!cancelled) setReady(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [file])
  return ready === fontFamilyFor(file) ? `"${ready}"` : FALLBACK_FAMILY
}

/** The label as the export would draw it, at a fixed text size, updating with every edit. */
export default function LabelPreview({ style, defaults }: { style: StyleForm; defaults: StyleDefaults }) {
  const fontFile = style.font_file || defaults.font_file
  const family = useBundledFont(fontFile)
  const text = style.text_color || defaults.text_color
  const marker = style.marker_color || defaults.marker_color
  const leader = style.leader_color || defaults.leader_color
  const haloColor = style.halo_color || defaults.halo_color
  const aliasesOn = style.show_aliases === '' ? defaults.show_aliases : style.show_aliases === 'on'
  const lines = previewLines(style.name_preference, defaults.name_preference)
  const g = previewGeometry(style, defaults)
  const description = `Preview: ${lines.primary}${aliasesOn ? `, ${lines.aliases}` : ''} in ${fontFile}`
  const strokeProps = { stroke: haloColor, strokeWidth: g.haloWidth, paintOrder: 'stroke' as const, strokeLinejoin: 'round' as const }

  return (
    <svg className="preview" viewBox="0 0 560 130" role="img" aria-label={description}>
      <rect width="560" height="130" fill="#05070d" />
      {STARS.map(([x, y, r]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill="#d8e0ff" opacity="0.85" />
      ))}
      <circle cx="120" cy="72" r="34" fill="none" stroke={marker} strokeWidth={g.markerWidth} />
      <line x1="154" y1="72" x2="196" y2="62" stroke={leader} strokeWidth={g.markerWidth} />
      <text x="204" y={aliasesOn ? 62 : 70} fill={text} fontFamily={family} fontSize={PREVIEW_SIZE} {...strokeProps}>
        {lines.primary}
      </text>
      {aliasesOn && (
        <text x="204" y={62 + g.aliasOffset} fill={text} fontFamily={family} fontSize={g.aliasSize} opacity="0.9" {...strokeProps}>
          {lines.aliases}
        </text>
      )}
    </svg>
  )
}
