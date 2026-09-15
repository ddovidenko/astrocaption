import { useEffect, useId, useRef, useState } from 'react'
import { HexColorInput, HexColorPicker } from 'react-colorful'
import { normalizeHex } from './styleForm'

/** A colour override: a swatch that opens an in-page picker, never the OS dialog. */
export default function ColorField({
  label,
  value,
  fallback,
  allowDefault = true,
  disabled = false,
  onChange,
  onCommit,
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
  /** A colour picker closed or a hex was typed — commit the current value. */
  onCommit?: () => void
}) {
  const [open, setOpen] = useState(false)
  // Guards against a close reaching us twice for one interaction (mousedown fires on the
  // document before a blur's focusout bubbles), so onCommit fires exactly once per close.
  const openRef = useRef(false)
  const wrap = useRef<HTMLDivElement>(null)
  const swatch = useRef<HTMLButtonElement>(null)
  const id = useId()
  const valueId = `${id}-value`
  const shown = value || fallback
  const pick = (hex: string) => onChange(normalizeHex(hex))
  const typed = (hex: string) => {
    pick(hex)
    onCommit?.()
  }
  const openPicker = () => {
    openRef.current = true
    setOpen(true)
  }
  /** Every way out of the picker: once per close, whichever event gets there first. */
  const closePicker = (refocus: boolean) => {
    if (!openRef.current) return
    openRef.current = false
    setOpen(false)
    if (refocus) swatch.current?.focus() // a keyboard user lands back where they started
    onCommit?.()
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
    // closePicker reads only refs and the latest onCommit through the closure created for this
    // open; resubscribing per keystroke is the wrong fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <div className="popover" role="dialog" aria-label={`${label} picker`}>
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
