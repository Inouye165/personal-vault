import React from 'react'
import { Search } from 'lucide-react'
import type { VaultStatus } from '../../../shared/validation/ipc-schemas.js'

interface HeaderProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  status: VaultStatus
}

export const Header: React.FC<HeaderProps> = ({ searchQuery, onSearchChange, status }) => {
  return (
    <header className="top-bar" role="banner">
      <div className="search-box">
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          className="search-input"
          placeholder="Search catalog (requires connected sources)..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          aria-label="Search catalog"
          disabled={status.sourceCount === 0}
        />
      </div>

      <div className="top-status">
        <span className="status-badge">
          <span className="status-dot" aria-hidden="true" />
          <span>
            {status.sourceCount === 0 ? 'No Sources Connected' : `${status.itemCount} items`}
          </span>
        </span>
      </div>
    </header>
  )
}
