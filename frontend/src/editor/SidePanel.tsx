import { useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent, type UIEvent } from 'react'
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
 *  A tab body mounts on its first visit and then stays mounted behind `hidden`, through a tab
 *  switch and through a collapse alike, so an export still rendering on the Image tab, or a
 *  search typed on the Objects tab, survives both (#76, #110); a tab never opened costs nothing.
 *  `display: none` forgets a panel's scroll offset, so each panel's last offset is kept here and
 *  written back when it shows again. The tablist follows the WAI-ARIA pattern: one tab stop,
 *  arrows / Home / End move and select, the panel itself is focusable. */
export default function SidePanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [tab, setTab] = useState<Tab>('objects')
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set<Tab>(['objects']))
  const scrollTops = useRef<Partial<Record<Tab, number>>>({})
  const panels = useRef<Partial<Record<Tab, HTMLDivElement | null>>>({})
  useLayoutEffect(() => {
    if (!open) return
    const panel = panels.current[tab]
    const top = scrollTops.current[tab]
    if (panel && top !== undefined) panel.scrollTop = top
  }, [open, tab])
  const remember = (id: Tab) => (e: UIEvent<HTMLDivElement>) => {
    scrollTops.current[id] = e.currentTarget.scrollTop
  }

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
            {/* A mouse click selects without moving the focus (the project's onMouseDown pattern),
                so a tab reached by keyboard can end up with tabIndex -1; the arrows still work,
                because the focus stays inside the tablist and its handler reads `tab`. */}
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
      {TABS.map(({ id, body: Body }) => (
        <div
          key={id}
          ref={(el) => {
            panels.current[id] = el
          }}
          id={`panel-${id}`}
          role="tabpanel"
          aria-labelledby={`tab-${id}`}
          tabIndex={0}
          hidden={!open || tab !== id}
          className="side-panel-body"
          onScroll={remember(id)}
        >
          {visited.has(id) && <Body />}
        </div>
      ))}
    </aside>
  )
}
