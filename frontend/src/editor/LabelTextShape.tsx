import { useRef } from 'react'
import { Shape } from 'react-konva'
import type Konva from 'konva'
import type { FontOut, Label, StyleConfig } from '../api'
import { ascentFor, fontShorthand, type LabelBox, type LabelLines } from './metrics'

/** A refusal to draw this shape at all, raised here and worded for the page. Anything else the
 *  canvas throws is a browser failure whose message is not for the owner (CLAUDE.md: no raw
 *  exception text on the page). */
class DrawSetupError extends Error {}

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
 *  is the measured text box, so a drag grabs exactly the rectangle the placer placed.
 *
 *  Everything is drawn at the origin: the enclosing Konva Group carries `label.x`/`label.y`, and
 *  dragging that group is what moves the label (the store keeps the position in original pixels).
 *
 *  Nothing here is chrome: this shape draws exactly what the export draws, so the parity render
 *  can keep it and hide the overlay layer (selection outline, hover ring) instead. */
export function LabelTextShape({ label, style, font, box, text, onDrawError }: Props) {
  const color = label.color ?? style.text_color
  const failedRef = useRef(false)
  const draw = (ctx: Konva.Context) => {
    if (failedRef.current) return
    try {
      // Ascent and family must come from the same file, or the baseline would be Pillow's for one
      // font and the glyphs another's.
      if (font.file !== style.font_file) {
        throw new DrawSetupError(
          `the ascent table is for ${font.file} but the style asks for ${style.font_file}`,
        )
      }
      const c = ctx._context
      c.textRendering = 'geometricPrecision'
      c.textBaseline = 'alphabetic'
      c.textAlign = 'left'
      c.lineJoin = 'round'
      const lines: [string, number, number][] = [[text.primary, box.primarySize, 0]]
      if (text.alias !== null) lines.push([text.alias, box.aliasSize, box.line1Height])
      for (const [str, size, dy] of lines) {
        c.font = fontShorthand(size, style.font_file)
        const y = dy + ascentFor(font, size)
        if (style.halo && style.halo_width > 0) {
          c.lineWidth = 2 * style.halo_width
          c.strokeStyle = style.halo_color
          c.strokeText(str, 0, y)
        }
        c.fillStyle = color
        c.fillText(str, 0, y)
      }
    } catch (err) {
      failedRef.current = true
      console.error('label draw failed', err)
      onDrawError?.(err instanceof DrawSetupError ? err.message : 'the browser could not draw it')
    }
  }
  return (
    <Shape
      sceneFunc={draw}
      hitFunc={(ctx, shape) => {
        ctx.beginPath()
        ctx.rect(0, 0, box.width, box.height)
        ctx.closePath()
        ctx.fillStrokeShape(shape)
      }}
    />
  )
}
