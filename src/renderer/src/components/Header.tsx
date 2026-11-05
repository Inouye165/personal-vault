import { Search } from 'lucide-react'
import type { BridgeState } from '../hooks/useVaultApi'

interface HeaderProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  state: BridgeState
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

export function Header({ searchQuery, onSearchChange, state }: HeaderProps) {
  const searchAvailable = state.phase === 'ready' && state.vaultStatus.sourceCount > 0

  return (
    <header className="top-bar">
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

      <div className="top-status">
        <span className="status-badge">
          <span className={`status-dot ${state.phase}`} aria-hidden="true" />
          <span>{statusLabel(state)}</span>
        </span>
      </div>
    </header>
  )
}
