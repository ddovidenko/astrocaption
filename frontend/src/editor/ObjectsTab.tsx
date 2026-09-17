import { useMemo, useState } from 'react'
import type { ObjectKind, ObjectOut } from '../api'
import { disableAll, enableWithPlacement, isEditable, toggleWithPlacement } from './editing'
import { primaryName } from './names'
import { DEFAULT_FILTER, KINDS, KIND_LABELS, filterObjects, type ObjectsFilter } from './objectsFilter'
import { useEditor } from './store'

/** Search, kind chips and one row per object (design § 5). The checkbox does exactly what a click
 *  on the canvas marker does — `toggleWithPlacement`, so a label enabled here is placed by the
 *  same anchor search — and the name pans the view to the object. The name is ranked here, not
 *  taken from the server, so a Style-tab preference change updates the list (#94). */
export default function ObjectsTab() {
  const objects = useEditor((s) => s.objects)
  const objectOrder = useEditor((s) => s.objectOrder)
  const labels = useEditor((s) => s.labels)
  const editable = useEditor(isEditable)
  const hover = useEditor((s) => s.hover)
  const panTo = useEditor((s) => s.panTo)
  const hoveredId = useEditor((s) => s.hoveredId)
  const preference = useEditor((s) => s.style?.name_preference ?? 'popular')

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ObjectsFilter>(DEFAULT_FILTER)
  const [error, setError] = useState<string | null>(null)

  const rows = useMemo(() => {
    const all: ObjectOut[] = []
    for (const id of objectOrder) {
      const obj = objects.get(id)
      if (obj) all.push(obj)
    }
    return filterObjects(all, query, filter)
  }, [objectOrder, objects, query, filter])

  const toggleKind = (kind: ObjectKind) =>
    setFilter((prev) => {
      const kinds = new Set(prev.kinds)
      if (!kinds.delete(kind)) kinds.add(kind)
      return { ...prev, kinds }
    })
  const toggleHd = () => setFilter((prev) => ({ ...prev, hd: !prev.hd }))

  // One store change for the whole batch: one undo entry, one autosave, and a measurement that
  // throws (a stale font) leaves the list exactly as it was — the error says so.
  const bulk = (enable: boolean) => {
    setError(null)
    const ids = rows.map((obj) => obj.id)
    try {
      if (enable) enableWithPlacement(ids)
      else disableAll(ids)
    } catch (err) {
      console.error('bulk change failed', err)
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
        {KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="chip"
            aria-pressed={filter.kinds.has(kind)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleKind(kind)}
          >
            {KIND_LABELS[kind]}
          </button>
        ))}
        <button
          type="button"
          className="chip"
          aria-pressed={filter.hd}
          title="Nova's HD-catalogue rows, hidden by default: most duplicate a brighter star"
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleHd}
        >
          HD stars
        </button>
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
          const name = primaryName(obj.catalog_names, preference)
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
                aria-label={`Show ${name}`}
                onChange={() => toggleWithPlacement(obj.id)}
              />
              <button
                type="button"
                className="link-button"
                title="Centre the view on this object"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => panTo(obj.id)}
              >
                {name}
              </button>
              <span className="object-type">{obj.kind}</span>
              <span className="object-radius">{Math.round(obj.radius)} px</span>
            </li>
          )
        })}
      </ul>
      {rows.length === 0 && <p className="meta">No objects match this search.</p>}
    </div>
  )
}
