import { CheckSquare, Copy, FileText, Image, Layers, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import type { NavigationTab } from '../../../shared/validation/ipc-schemas'
import { VIEWS } from '../views'

interface SidebarProps {
  currentTab: NavigationTab
  onSelectTab: (tab: NavigationTab) => void
  appVersion?: string
}

const ICONS: Record<NavigationTab, ReactNode> = {
  all: <Layers size={18} aria-hidden="true" />,
  photos: <Image size={18} aria-hidden="true" />,
  documents: <FileText size={18} aria-hidden="true" />,
  review: <CheckSquare size={18} aria-hidden="true" />,
  duplicates: <Copy size={18} aria-hidden="true" />
}

export function Sidebar({ currentTab, onSelectTab, appVersion }: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="Main navigation">
      <div className="brand-header">
        <div className="brand-icon" aria-hidden="true">
          <ShieldCheck size={18} />
        </div>
        <h1 className="brand-title">Personal Vault</h1>
      </div>

      <nav className="nav-section" aria-label="Views">
        {VIEWS.map((view) => {
          const isActive = currentTab === view.id
          return (
            <button
              key={view.id}
              type="button"
              className={`nav-item ${isActive ? 'active' : ''}`}
              onClick={() => onSelectTab(view.id)}
              aria-current={isActive ? 'page' : undefined}
            >
              {ICONS[view.id]}
              <span>{view.label}</span>
            </button>
          )
        })}
      </nav>

      {appVersion ? <div className="sidebar-footer">Version {appVersion}</div> : null}
    </aside>
  )
}
