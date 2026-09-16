import { useEffect, useId, useRef, useState } from 'react'
import { HexColorInput, HexColorPicker } from 'react-colorful'
import { normalizeHex } from './styleForm'

/** The popover's width (styles.css: `.popover { min-width: ... }`), used to decide at open time
 *  whether it would run off the right edge of its container. */
export const POPOVER_WIDTH = 232
/** Overrides mode (`allowDefault`) renders an extra "Use default" button beside the hex input, so
 *  `openPicker` below measures against this wider figure there instead of `POPOVER_WIDTH`. */
export const POPOVER_WIDTH_WITH_DEFAULT = 248
/** The popover's rendered height, used the same way to decide whether it would run off the bottom
 *  of its container. From styles.css: 160 px picker + ~34 px `.popover-row` (a 0.45rem-padded
 *  button on a 16 px line) + 0.6rem grid gap + 2 × 0.75rem padding + 2 × 1 px border ≈ 230 px,
 *  rounded up. It only has to be close: being a few px out flips the popover one swatch-row early
 *  or late, never off-screen. */
export const POPOVER_HEIGHT = 232

/** A colour override: a swatch that opens an in-page picker, never the OS dialog. */
export default function ColorField({
  label,
  value,
  fallback,
  allowDefault = true,
  disabled = false,
  onChange,
  onCommit,
  onClear,
}: {
  label: string
  /** The override, or '' for "use the built-in default". */
  value: string
  /** The built-in default shown when there is no override. */
  fallback: string
  /** Whether '' ("use the built-in default") is a valid value: shows the default chip and the
   *  "Use default" button. Off in values mode, where every field always holds a concrete colour. */
  allowDefault?: boolean
  disabled?: boolean
  onChange: (hex: string) => void
  /** A colour picker closed or a hex was typed — commit the current value. A typed commit carries
   *  the just-typed hex, since the draft `onChange` set a moment earlier has not necessarily
   *  reached the caller's own state yet (StyleTab reads `draft` a render behind a keystroke); a
   *  close carries nothing, so the caller commits whatever it already has. */
  onCommit?: (hex?: string) => void
  /** "Use default" was clicked (allowDefault only). Without it the caller sees `onChange('')`
   *  followed by a bare `onCommit()`, which a stateless caller cannot tell from a plain close. */
  onClear?: () => void
}) {
  const [open, setOpen] = useState(false)
  // Whether the popover would run off the right edge of its container (the side panel, a config
  // page panel, or the viewport) if opened left-aligned under the swatch — decided by measurement
  // at open time, not by which grid column the field happens to land in: a `.span2` row ahead of
  // it can shift every field after it into the other column, so column parity does not track
  // which side has room (#94 IMPORTANT 4).
  const [alignRight, setAlignRight] = useState(false)
  // The same measurement for the other axis: the popover opens upwards when there is no room for
  // it below the swatch inside that container. The editor's floating label toolbar sits low over a
  // canvas that clips its overflow, so a downward popover there would simply be cut off.
  const [alignUp, setAlignUp] = useState(false)
  // Guards against a close reaching us twice for one interaction (mousedown fires on the
  // document before a blur's focusout bubbles), so onCommit fires exactly once per close.
  const openRef = useRef(false)
  const wrap = useRef<HTMLDivElement>(null)
  const swatch = useRef<HTMLButtonElement>(null)
  const id = useId()
  const valueId = `${id}-value`
  const shown = value || fallback
  // The document listeners below are wired once per open (not once per render), so they cannot
  // close over a fresh `onCommit` themselves; an effect (not render — refs may not be written
  // during render) keeps this ref current after every render, so a drag that just changed the
  // draft is what gets committed, not whatever `onCommit` closed over when the picker opened.
  const onCommitRef = useRef(onCommit)
  useEffect(() => {
    onCommitRef.current = onCommit
  })
  const pick = (hex: string) => onChange(normalizeHex(hex))
  const typed = (hex: string) => {
    pick(hex)
    onCommitRef.current?.(normalizeHex(hex))
  }
  const openPicker = () => {
    openRef.current = true
    setOpen(true)
    const wrapEl = wrap.current
    if (wrapEl) {
      const wrapRect = wrapEl.getBoundingClientRect()
      // `.editor-canvas` is a bound as much as a panel is: it clips its overflow, so a popover
      // reaching past its edges is invisible, not merely awkward.
      const bound = (
        wrapEl.closest('.editor-canvas, .side-panel-body, .panel') ?? document.documentElement
      ).getBoundingClientRect()
      const width = allowDefault ? POPOVER_WIDTH_WITH_DEFAULT : POPOVER_WIDTH
      setAlignRight(wrapRect.left + width > bound.right)
      setAlignUp(wrapRect.bottom + POPOVER_HEIGHT > bound.bottom)
    }
  }
  /** Every way out of the picker: once per close, whichever event gets there first. */
  const closePicker = (refocus: boolean) => {
    if (!openRef.current) return
    openRef.current = false
    setOpen(false)
    if (refocus) swatch.current?.focus() // a keyboard user lands back where they started
    onCommitRef.current?.()
  }

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) closePicker(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePicker(true)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
    // closePicker reads only refs, including the latest onCommit through onCommitRef (kept
    // current by the effect above), so it needs nothing in the dependency list besides `open`.
  }, [open])

  return (
    <div
      className="field color-field"
      ref={wrap}
      onBlur={(e) => {
        // Tabbing out of the popover closes it; moving focus within it does not.
        if (open && !wrap.current?.contains(e.relatedTarget as Node | null)) closePicker(false)
      }}
    >
      <span className="field-label" id={id}>
        {label}
      </span>
      <button
        ref={swatch}
        type="button"
        className="swatch"
        aria-labelledby={`${id} ${valueId}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? closePicker(true) : openPicker())}
      >
        <span className="swatch-chip" style={{ background: shown }} />
        <span className="swatch-hex" id={valueId}>
          {shown.toUpperCase()}
          {allowDefault && !value && <span className="swatch-note"> default</span>}
        </span>
      </button>
      {open && (
        <div
          className={`popover${alignRight ? ' popover-right' : ''}${alignUp ? ' popover-up' : ''}`}
          role="dialog"
          aria-label={`${label} picker`}
        >
          <HexColorPicker color={shown} onChange={pick} />
          <div className="popover-row">
            <HexColorInput color={shown} onChange={typed} prefixed />
            {allowDefault && (
              <button
                type="button"
                className="secondary"
                disabled={!value}
                onClick={() => {
                  onChange('')
                  onClear?.()
                  closePicker(true)
                }}
              >
                Use default
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
