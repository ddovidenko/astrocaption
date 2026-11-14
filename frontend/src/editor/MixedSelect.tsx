import { MIXED } from './labelControls'

/** A select over a selection that may disagree: the "mixed" sentinel is an option only
 *  while it is the value, so the owner can never pick it, and it disappears once they have. Every
 *  option reads "<field>: <choice>", which is also the field's accessible name; `bare` drops the
 *  field from what is shown, for a row that already names it beside the select. */
export default function MixedSelect({
  label,
  value,
  options,
  onChange,
  bare = false,
}: {
  bare?: boolean
  label: string
  /** One of `options`, or MIXED while the selection disagrees. */
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {value === MIXED && (
        <option value={MIXED} disabled>
          {bare ? MIXED : `${label}: ${MIXED}`}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {bare ? o.label : `${label}: ${o.label}`}
        </option>
      ))}
    </select>
  )
}
