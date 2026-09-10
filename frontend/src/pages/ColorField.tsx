import { useEffect, useId, useRef, useState } from 'react'
import { HexColorInput, HexColorPicker } from 'react-colorful'

/** A colour override: a swatch that opens an in-page picker, never the OS dialog. */
export default function ColorField({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string
  /** The override, or '' for "use the built-in default". */
  value: string
  /** The built-in default shown when there is no override. */
  fallback: string
  onChange: (hex: string) => void
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const id = useId()
  const shown = value || fallback

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  return (
    <div className="field color-field" ref={wrap}>
      <span className="field-label" id={id}>
        {label}
      </span>
      <button
        type="button"
        className="swatch"
        aria-labelledby={id}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="swatch-chip" style={{ background: shown }} />
        <span className="swatch-hex">{shown.toUpperCase()}</span>
        {!value && <span className="swatch-note">default</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label={`${label} picker`}>
          <HexColorPicker color={shown} onChange={onChange} />
          <div className="popover-row">
            <HexColorInput color={shown} onChange={onChange} prefixed />
            <button
              type="button"
              className="secondary"
              disabled={!value}
              onClick={() => {
                onChange('')
                setOpen(false)
              }}
            >
              Use default
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
