import { Menu, Search } from 'lucide-react'
import type { RefObject } from 'react'
import type { BridgeState } from '../hooks/useVaultApi'
import type { NavigationTab } from '../../../shared/validation/ipc-schemas'

interface HeaderProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  state: BridgeState
  currentTab?: NavigationTab
  isNavOpen?: boolean
  onToggleNav?: () => void
  navToggleRef?: RefObject<HTMLButtonElement | null>
}

function statusLabel(state: BridgeState): string {
  switch (state.phase) {
    case 'loading':
      return 'Connecting…'
    case 'error':
      return 'Unavailable'
    case 'ready':
      return state.vaultStatus.sourceCount === 0
        ? 'No sources connected'
        : `${state.vaultStatus.itemCount} items`
  }
}

export function Header({
  searchQuery,
  onSearchChange,
  state,
  currentTab,
  isNavOpen = false,
  onToggleNav,
  navToggleRef
}: HeaderProps) {
  const isPhotosTab = currentTab === 'photos'
  const searchAvailable =
    state.phase === 'ready' && state.vaultStatus.sourceCount > 0 && !isPhotosTab

  return (
    <header className="top-bar">
      <button
        ref={navToggleRef}
        type="button"
        className="mobile-nav-toggle-btn"
        onClick={onToggleNav}
        aria-label="Open navigation menu"
        aria-expanded={isNavOpen}
        aria-controls="main-sidebar"
      >
        <Menu size={20} aria-hidden="true" />
      </button>

      {!isPhotosTab && (
        <div className="search-box">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            className="search-input"
            placeholder="Search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            aria-label="Search"
            aria-describedby="search-help"
            disabled={!searchAvailable}
          />
          <span id="search-help" className="visually-hidden">
            Search is unavailable until a source has been connected.
          </span>
        </div>
      )}

      <div className="top-status">
        <span className="status-badge">
          <span className={`status-dot ${state.phase}`} aria-hidden="true" />
          <span>{statusLabel(state)}</span>
        </span>
      </div>
    </header>
  )
}
