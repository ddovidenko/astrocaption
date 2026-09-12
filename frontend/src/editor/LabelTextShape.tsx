import { useRef } from 'react'
import { Shape } from 'react-konva'
import type Konva from 'konva'
import { describeError, type FontOut, type Label, type StyleConfig } from '../api'
import { ascentFor, fontFamilyFor, type LabelBox, type LabelLines } from './metrics'

interface Props {
  label: Label
  style: StyleConfig
  font: FontOut
  box: LabelBox
  text: LabelLines
  /** Called once with a plain message if the label cannot be drawn; the shape then stays blank
   *  instead of leaving a half-drawn layer behind silently. */
  onDrawError?: (message: string) => void
}

/** Text drawn the way Pillow draws it (design § 3): geometricPrecision, alphabetic baseline at
 *  y + ascent, the halo as a round-joined stroke of 2 × halo_width under the fill. The hit area
 *  is the measured text box so hover and (in PR 5) drag use the same rectangle the placer used.
 *
 *  Nothing here is chrome: this shape draws exactly what the export draws, so the parity render
 *  can keep it and hide the overlay layer (selection outline, hover ring) instead. */
export function LabelTextShape({ label, style, font, box, text, onDrawError }: Props) {
  const color = label.color ?? style.text_color
  const family = fontFamilyFor(style.font_file)
  const failedRef = useRef(false)
  const draw = (ctx: Konva.Context) => {
    if (failedRef.current) return
    try {
      // Ascent and family must come from the same file, or the baseline would be Pillow's for one
      // font and the glyphs another's.
      if (font.file !== style.font_file) {
        throw new Error(`the ascent table is for ${font.file} but the style asks for ${style.font_file}`)
      }
      const c = ctx._context
      c.textRendering = 'geometricPrecision'
      c.textBaseline = 'alphabetic'
      c.textAlign = 'left'
      c.lineJoin = 'round'
      const lines: [string, number, number][] = [[text.primary, box.primarySize, 0]]
      if (text.alias !== null) lines.push([text.alias, box.aliasSize, box.line1Height])
      for (const [str, size, dy] of lines) {
        c.font = `${size}px "${family}"`
        const y = label.y + dy + ascentFor(font, size)
        if (style.halo && style.halo_width > 0) {
          c.lineWidth = 2 * style.halo_width
          c.strokeStyle = style.halo_color
          c.strokeText(str, label.x, y)
        }
        c.fillStyle = color
        c.fillText(str, label.x, y)
      }
    } catch (err) {
      failedRef.current = true
      onDrawError?.(describeError(err))
    }
  }
  return (
    <Shape
      sceneFunc={draw}
      hitFunc={(ctx, shape) => {
        ctx.beginPath()
        ctx.rect(label.x, label.y, box.width, box.height)
        ctx.closePath()
        ctx.fillStrokeShape(shape)
      }}
      // Hover is served by the canvas overlay's hit circles; the hit area above stays so the
      // rectangle is ready. PR 5: drag/select will turn this on.
      listening={false}
    />
  )
}
