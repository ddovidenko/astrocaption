import { Shape } from 'react-konva'
import type Konva from 'konva'
import type { FontOut, Label, StyleConfig } from '../api'
import { ascentFor, fontFamilyFor, type LabelBox, type LabelLines } from './metrics'

interface Props {
  label: Label
  style: StyleConfig
  font: FontOut
  box: LabelBox
  text: LabelLines
}

/** Text drawn the way Pillow draws it (design § 3): geometricPrecision, alphabetic baseline at
 *  y + ascent, the halo as a round-joined stroke of 2 × halo_width under the fill. The hit area
 *  is the measured text box so hover and (in PR 5) drag use the same rectangle the placer used.
 *
 *  Nothing here is chrome: this shape draws exactly what the export draws, so the parity render
 *  can keep it and hide the overlay layer (selection outline, hover ring) instead. */
export function LabelTextShape({ label, style, font, box, text }: Props) {
  const color = label.color ?? style.text_color
  const family = fontFamilyFor(style.font_file)
  const draw = (ctx: Konva.Context) => {
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
      listening
    />
  )
}
