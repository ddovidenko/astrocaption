import { useEffect, useState } from 'react'
import type { StyleDefaults } from '../api'
import { loadBundledFont } from '../editor/fonts'
import { fontFamilyFor } from '../editor/metrics'
import type { StyleForm } from './styleForm'
import { fitToStrip, PREVIEW_TEXT_X, PREVIEW_WIDTH, previewCap, previewGeometry, previewLines } from './labelPreview'

/** Fixed stars so the preview is the same every time. */
const STARS = [
  [12, 18, 1.2], [58, 62, 0.8], [140, 28, 1.6], [210, 90, 0.7], [305, 40, 1.1], [372, 74, 0.9],
  [430, 22, 1.4], [500, 66, 0.8], [545, 30, 1.0], [80, 108, 0.6], [250, 118, 1.3], [470, 112, 0.7],
] as const

const FALLBACK_FAMILY = 'Inter, system-ui, sans-serif'

// Not the editor's shared measurer (editing.ts `getMeasurer`): that one takes a bundled file name,
// and the preview must also measure the CSS fallback family it draws with while a face loads or
// after one failed.
let measureCtx: CanvasRenderingContext2D | null | undefined

/** Advance width of `text` in the CSS `family` at `size` px, or null where there is no canvas
 *  (jsdom). The same family the SVG draws with, so a fallback face is measured as a fallback. */
function textWidth(text: string, family: string, size: number): number | null {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d')
  if (!measureCtx) return null
  // Unhinted, like SVG text: hinted canvas advances round per glyph and can drift past the margin
  // over a long alias line (see canvasMeasurer). Firefox has no textRendering; it measures as is.
  if ('textRendering' in measureCtx) measureCtx.textRendering = 'geometricPrecision'
  measureCtx.font = `${size}px ${family}`
  return measureCtx.measureText(text).width
}

function useBundledFont(file: string): { family: string; failed: boolean } {
  // Keyed by the file, so switching fonts drops the previous result instead of keeping a stale
  // family (or a stale failure note) until the new one resolves.
  const [result, setResult] = useState<{ file: string; family: string | null } | null>(null)
  const supported = typeof FontFace !== 'undefined'
  const current = result && result.file === file ? result : null
  useEffect(() => {
    if (!supported) return
    let cancelled = false
    void loadBundledFont(file).then(
      (family) => {
        if (!cancelled) setResult({ file, family })
      },
      () => {
        // The preview still renders, in a fallback face — but it says so, so nobody reads it as
        // what the export will look like.
        if (!cancelled) setResult({ file, family: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [file, supported])
  return {
    family: current?.family === fontFamilyFor(file) ? `"${current.family}"` : FALLBACK_FAMILY,
    failed: !supported || (current !== null && current.family === null),
  }
}

/** The label as the export would draw it, at a size that follows the font size, updating with every edit. */
export default function LabelPreview({ style, defaults }: { style: StyleForm; defaults: StyleDefaults }) {
  const fontFile = style.font_file || defaults.font_file
  const { family, failed } = useBundledFont(fontFile)
  const text = style.text_color || defaults.text_color
  const marker = style.marker_color || defaults.marker_color
  const leader = style.leader_color || defaults.leader_color
  const haloColor = style.halo_color || defaults.halo_color
  const aliasesOnSetting = style.show_aliases === '' ? defaults.show_aliases : style.show_aliases === 'on'
  const maxAliases = previewCap(style.max_aliases, defaults.max_aliases)
  const lines = previewLines(style.name_preference, defaults.name_preference, maxAliases)
  const aliasesOn = aliasesOnSetting && lines.aliases !== ''
  const sized = previewGeometry(style, defaults)
  // Re-measured on every render: family only changes once the font has loaded, so the first
  // measurement of a new font is with the fallback face and the next one with the real one.
  const primaryWidth = textWidth(lines.primary, family, sized.textSize)
  const aliasWidth = aliasesOn ? textWidth(lines.aliases, family, sized.aliasSize) : 0
  const g =
    primaryWidth === null || aliasWidth === null ? sized : fitToStrip(sized, { primary: primaryWidth, aliases: aliasWidth })
  const description = `Preview: ${lines.primary}${aliasesOn ? `, ${lines.aliases}` : ''} in ${fontFile}`
  const strokeProps = { stroke: haloColor, strokeWidth: g.haloWidth, paintOrder: 'stroke' as const, strokeLinejoin: 'round' as const }

  return (
    <>
      <svg className="preview" viewBox={`0 0 ${PREVIEW_WIDTH} 130`} role="img" aria-label={description}>
      <rect width={PREVIEW_WIDTH} height="130" fill="#05070d" />
      {STARS.map(([x, y, r]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill="#d8e0ff" opacity="0.85" />
      ))}
      <circle cx="120" cy="72" r="34" fill="none" stroke={marker} strokeWidth={g.markerWidth} />
      <line x1="154" y1="72" x2={PREVIEW_TEXT_X - 8} y2="62" stroke={leader} strokeWidth={g.markerWidth} />
      <text x={PREVIEW_TEXT_X} y={aliasesOn ? 62 : 70} fill={text} fontFamily={family} fontSize={g.textSize} {...strokeProps}>
        {lines.primary}
      </text>
      {aliasesOn && (
        <text x={PREVIEW_TEXT_X} y={62 + g.aliasOffset} fill={text} fontFamily={family} fontSize={g.aliasSize} opacity="0.9" {...strokeProps}>
          {lines.aliases}
        </text>
      )}
      </svg>
      {failed && <p className="field-note">Preview shown in a fallback font: {fontFile} could not be loaded.</p>}
    </>
  )
}
