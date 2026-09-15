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
  const close = () => {
    setOpen(false)
    swatch.current?.focus() // a keyboard user lands back where they started
    onCommit?.()
  }

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) {
        setOpen(false)
        onCommit?.()
      }
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  return (
    <div
      className="field color-field"
      ref={wrap}
      onBlur={(e) => {
        // Tabbing out of the popover closes it; moving focus within it does not.
        if (open && !wrap.current?.contains(e.relatedTarget as Node | null)) {
          setOpen(false)
          onCommit?.()
        }
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
        onClick={() => setOpen((o) => !o)}
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
                  close()
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
