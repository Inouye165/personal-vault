import React from 'react'
import { Layers, Image, FileText, CheckSquare, Copy, ShieldCheck } from 'lucide-react'
import type { NavigationTab } from '../../../shared/validation/ipc-schemas.js'

interface SidebarProps {
  currentTab: NavigationTab
  onSelectTab: (tab: NavigationTab) => void
  appVersion: string
}

interface NavItemConfig {
  id: NavigationTab
  label: string
  icon: React.ReactNode
}

const NAV_ITEMS: readonly NavItemConfig[] = [
  { id: 'all', label: 'All Items', icon: <Layers size={18} aria-hidden="true" /> },
  { id: 'photos', label: 'Photos', icon: <Image size={18} aria-hidden="true" /> },
  { id: 'documents', label: 'Documents', icon: <FileText size={18} aria-hidden="true" /> },
  { id: 'review', label: 'Review', icon: <CheckSquare size={18} aria-hidden="true" /> },
  { id: 'duplicates', label: 'Duplicates', icon: <Copy size={18} aria-hidden="true" /> }
]

export const Sidebar: React.FC<SidebarProps> = ({ currentTab, onSelectTab, appVersion }) => {
  return (
    <aside className="sidebar" aria-label="Main Navigation">
      <div className="brand-header">
        <div className="brand-icon" aria-hidden="true">
          <ShieldCheck size={18} />
        </div>
        <h1 className="brand-title">Personal Vault</h1>
      </div>

      <nav className="nav-section">
        {NAV_ITEMS.map((item) => {
          const isActive = currentTab === item.id
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${isActive ? 'active' : ''}`}
              onClick={() => onSelectTab(item.id)}
              aria-current={isActive ? 'page' : undefined}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        <div>Stage 1 Shell</div>
        <div>v{appVersion}</div>
      </div>
    </aside>
  )
}
