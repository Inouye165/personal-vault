import { Search } from 'lucide-react'
import type { BridgeState } from '../hooks/useVaultApi'
import type { NavigationTab } from '../../../shared/validation/ipc-schemas'

interface HeaderProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  state: BridgeState
  currentTab?: NavigationTab
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

export function Header({ searchQuery, onSearchChange, state, currentTab }: HeaderProps) {
  const isPhotosTab = currentTab === 'photos'
  const searchAvailable =
    state.phase === 'ready' && state.vaultStatus.sourceCount > 0 && !isPhotosTab

  return (
    <header className="top-bar">
      <div className="search-box">
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          className="search-input"
          placeholder={isPhotosTab ? 'Search photos (Stage 6)' : 'Search'}
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          aria-label={isPhotosTab ? 'Search photos (planned for Stage 6)' : 'Search'}
          aria-describedby={isPhotosTab ? 'search-photos-help' : 'search-help'}
          disabled={!searchAvailable}
          title={isPhotosTab ? 'Photograph search will be implemented in Stage 6' : undefined}
        />
        <span id="search-help" className="visually-hidden">
          Search is unavailable until a source has been connected.
        </span>
        {isPhotosTab && (
          <span id="search-photos-help" className="visually-hidden">
            Photograph search is planned for Stage 6.
          </span>
        )}
      </div>

      <div className="top-status">
        <span className="status-badge">
          <span className={`status-dot ${state.phase}`} aria-hidden="true" />
          <span>{statusLabel(state)}</span>
        </span>
      </div>
    </header>
  )
}
