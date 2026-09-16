import { useState } from 'react'
import ImageTab from './ImageTab'
import LayoutTab from './LayoutTab'
import ObjectsTab from './ObjectsTab'
import StyleTab from './StyleTab'

type Tab = 'objects' | 'style' | 'layout' | 'image'

const TABS: { id: Tab; label: string }[] = [
  { id: 'objects', label: 'Objects' },
  { id: 'style', label: 'Style' },
  { id: 'layout', label: 'Layout' },
  { id: 'image', label: 'Image' },
]

/** The editor's right-hand panel (design § 5). Collapses to a strip so the canvas can have the
 *  whole window; the open/closed state lives in `EditorPage` because the grid column is its CSS. */
export default function SidePanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [tab, setTab] = useState<Tab>('objects')

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
          <div className="tabs" role="tablist">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                role="tab"
                id={`tab-${id}`}
                aria-selected={tab === id}
                aria-controls="side-panel-body"
                className="tab"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {open && (
        <div id="side-panel-body" role="tabpanel" aria-labelledby={`tab-${tab}`} className="side-panel-body">
          {tab === 'objects' && <ObjectsTab />}
          {tab === 'style' && <StyleTab />}
          {tab === 'layout' && <LayoutTab />}
          {tab === 'image' && <ImageTab />}
        </div>
      )}
    </aside>
  )
}
