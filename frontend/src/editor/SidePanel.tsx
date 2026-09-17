import { useState, type ComponentType, type KeyboardEvent } from 'react'
import ImageTab from './ImageTab'
import LayoutTab from './LayoutTab'
import ObjectsTab from './ObjectsTab'
import StyleTab from './StyleTab'

type Tab = 'objects' | 'style' | 'layout' | 'image'

const TABS: { id: Tab; label: string; body: ComponentType }[] = [
  { id: 'objects', label: 'Objects', body: ObjectsTab },
  { id: 'style', label: 'Style', body: StyleTab },
  { id: 'layout', label: 'Layout', body: LayoutTab },
  { id: 'image', label: 'Image', body: ImageTab },
]

/** The editor's right-hand panel (design § 5). Collapses to a strip so the canvas can have the
 *  whole window; the open/closed state lives in `EditorPage` because the grid column is its CSS.
 *
 *  A tab body mounts on its first visit and then stays mounted behind `hidden`, so an export
 *  still rendering on the Image tab, or a search typed on the Objects tab, survives a switch
 *  (#76); a tab never opened costs nothing. The tablist follows the WAI-ARIA pattern: one tab
 *  stop, arrows / Home / End move and select, the panel itself is focusable. */
export default function SidePanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [tab, setTab] = useState<Tab>('objects')
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set<Tab>(['objects']))

  const show = (id: Tab) => {
    setTab(id)
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab)
    let next: number
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = TABS.length - 1
    else return
    e.preventDefault()
    const id = TABS[next]!.id
    show(id)
    document.getElementById(`tab-${id}`)?.focus()
  }

  return (
    <aside className={open ? 'side-panel' : 'side-panel collapsed'}>
      <div className="side-panel-head">
        {/* Like the toolbar buttons: these act on click and never need the focus, so the canvas
            shortcuts stay alive and Space cannot re-click them. */}
        <button
          className="secondary panel-toggle"
          aria-label={open ? 'Collapse panel' : 'Expand panel'}
          aria-expanded={open}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggle}
        >
          {open ? '›' : '‹'}
        </button>
        {open && (
          <div className="tabs" role="tablist" onKeyDown={onKeyDown}>
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                role="tab"
                id={`tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                className="tab"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => show(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {open &&
        TABS.map(({ id, body: Body }) => (
          <div
            key={id}
            id={`panel-${id}`}
            role="tabpanel"
            aria-labelledby={`tab-${id}`}
            tabIndex={0}
            hidden={tab !== id}
            className="side-panel-body"
          >
            {visited.has(id) && <Body />}
          </div>
        ))}
    </aside>
  )
}
