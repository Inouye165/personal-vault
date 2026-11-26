import { CheckSquare, Copy, FileText, HardDrive, Image, Layers, ShieldCheck, X } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import type { NavigationTab } from '../../../shared/validation/ipc-schemas'
import type { UpdateStateDto } from '../../../shared/validation/update-ipc-schemas'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { VIEWS } from '../views'

interface SidebarProps {
  currentTab: NavigationTab
  onSelectTab: (tab: NavigationTab) => void
  appVersion?: string
  updateState?: UpdateStateDto | null
  onCheckForUpdates?: () => void
  isOpen?: boolean
  isMobileViewport?: boolean
  onClose?: () => void
  restoreFocusTo?: () => HTMLElement | null
}

const ICONS: Record<NavigationTab, ReactNode> = {
  all: <Layers size={18} aria-hidden="true" />,
  photos: <Image size={18} aria-hidden="true" />,
  documents: <FileText size={18} aria-hidden="true" />,
  review: <CheckSquare size={18} aria-hidden="true" />,
  duplicates: <Copy size={18} aria-hidden="true" />,
  backup: <HardDrive size={18} aria-hidden="true" />
}

export function Sidebar({
  currentTab,
  onSelectTab,
  appVersion,
  updateState = null,
  onCheckForUpdates,
  isOpen = false,
  isMobileViewport = false,
  onClose,
  restoreFocusTo
}: SidebarProps) {
  const sidebarRef = useRef<HTMLElement>(null)
  const isMobileClosed = isMobileViewport && !isOpen
  const isMobileModalOpen = isMobileViewport && isOpen

  useFocusTrap({
    isOpen: isMobileModalOpen,
    isModal: isMobileModalOpen,
    containerRef: sidebarRef,
    onClose: onClose ?? (() => {}),
    restoreFocusTo
  })

  return (
    <>
      {isOpen && (
        <div className="sidebar-backdrop" aria-hidden="true" onClick={() => onClose?.()} />
      )}
      <aside
        id="main-sidebar"
        ref={sidebarRef}
        className={`sidebar ${isOpen ? 'open' : ''}`}
        aria-label="Main navigation"
        aria-hidden={isMobileClosed ? true : undefined}
        inert={isMobileClosed ? true : undefined}
        role={isMobileModalOpen ? 'dialog' : undefined}
        aria-modal={isMobileModalOpen ? true : undefined}
        tabIndex={-1}
      >
        <div className="brand-header">
          <div className="brand-icon" aria-hidden="true">
            <ShieldCheck size={18} />
          </div>
          <h1 className="brand-title">Personal Vault</h1>
          {onClose && (
            <button
              type="button"
              className="sidebar-close-btn"
              onClick={onClose}
              aria-label="Close navigation menu"
            >
              <X size={18} aria-hidden="true" />
            </button>
          )}
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

        {(appVersion || updateState?.configured) && (
          <div className="sidebar-footer">
            {appVersion ? <span>Version {appVersion}</span> : null}
            {updateState?.configured && onCheckForUpdates ? (
              <button
                type="button"
                className="sidebar-update-btn"
                data-testid="sidebar-update-btn"
                disabled={
                  updateState.phase === 'checking' ||
                  updateState.phase === 'downloading' ||
                  updateState.phase === 'waiting_for_jobs' ||
                  updateState.phase === 'installing'
                }
                onClick={onCheckForUpdates}
              >
                {updateState.phase === 'deferred' && updateState.availableVersion
                  ? `Update v${updateState.availableVersion} available`
                  : updateState.phase === 'checking'
                    ? 'Checking for updates…'
                    : updateState.phase === 'up_to_date'
                      ? 'Up to date'
                      : 'Check for updates'}
              </button>
            ) : null}
          </div>
        )}
      </aside>
    </>
  )
}
