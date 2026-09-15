import { useMemo, useState } from 'react'
import type { ObjectOut } from '../api'
import { disableAll, enableWithPlacement, isEditable, toggleWithPlacement } from './editing'
import { CHIPS, CHIP_LABELS, DEFAULT_CHIPS, filterObjects, type Chip } from './objectsFilter'
import { useEditor } from './store'

/** Search, type chips and one row per object (design § 5). The checkbox does exactly what a click
 *  on the canvas marker does — `toggleWithPlacement`, so a label enabled here is placed by the
 *  same anchor search — and the name pans the view to the object. */
export default function ObjectsTab() {
  const objects = useEditor((s) => s.objects)
  const objectOrder = useEditor((s) => s.objectOrder)
  const labels = useEditor((s) => s.labels)
  const editable = useEditor(isEditable)
  const hover = useEditor((s) => s.hover)
  const panTo = useEditor((s) => s.panTo)
  const hoveredId = useEditor((s) => s.hoveredId)

  const [query, setQuery] = useState('')
  const [chips, setChips] = useState<ReadonlySet<Chip>>(DEFAULT_CHIPS)
  const [error, setError] = useState<string | null>(null)

  const rows = useMemo(() => {
    const all: ObjectOut[] = []
    for (const id of objectOrder) {
      const obj = objects.get(id)
      if (obj) all.push(obj)
    }
    return filterObjects(all, query, chips)
  }, [objectOrder, objects, query, chips])

  const toggleChip = (chip: Chip) =>
    setChips((prev) => {
      const next = new Set(prev)
      if (!next.delete(chip)) next.add(chip)
      return next
    })

  // One store change for the whole batch: one undo entry, one autosave, and a measurement that
  // throws (a stale font) leaves the list exactly as it was — the error says so.
  const bulk = (enable: boolean) => {
    setError(null)
    const ids = rows.map((obj) => obj.id)
    try {
      if (enable) enableWithPlacement(ids)
      else disableAll(ids)
    } catch {
      setError('The labels could not be changed; nothing was altered.')
    }
  }

  return (
    <div className="tab-body">
      <input
        type="text"
        aria-label="Search objects"
        placeholder="Search objects"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="chips">
        {CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            className="chip"
            aria-pressed={chips.has(chip)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleChip(chip)}
          >
            {CHIP_LABELS[chip]}
          </button>
        ))}
      </div>
      <div className="tab-actions">
        <button className="secondary" disabled={!editable} onMouseDown={(e) => e.preventDefault()} onClick={() => bulk(true)}>
          Enable shown
        </button>
        <button className="secondary" disabled={!editable} onMouseDown={(e) => e.preventDefault()} onClick={() => bulk(false)}>
          Disable shown
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <p className="meta">
        {rows.length} of {objectOrder.length} objects
      </p>
      <ul className="object-list">
        {rows.map((obj) => {
          const label = labels.get(obj.id)
          return (
            <li
              key={obj.id}
              className={`object-row${hoveredId === obj.id ? ' hovered' : ''}`}
              onMouseEnter={() => hover(obj.id)}
              onMouseLeave={() => hover(null)}
            >
              <input
                type="checkbox"
                checked={label?.enabled ?? false}
                disabled={!editable || !label}
                aria-label={`Show ${obj.primary_name}`}
                onChange={() => toggleWithPlacement(obj.id)}
              />
              <button
                type="button"
                className="link-button"
                title="Centre the view on this object"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => panTo(obj.id)}
              >
                {obj.primary_name}
              </button>
              <span className="object-type">{obj.type}</span>
              <span className="object-radius">{Math.round(obj.radius)} px</span>
            </li>
          )
        })}
      </ul>
      {rows.length === 0 && <p className="meta">No objects match this search.</p>}
    </div>
  )
}
