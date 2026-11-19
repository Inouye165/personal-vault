import { Menu, Search, X } from 'lucide-react'
import { useRef, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import type { BridgeState } from '../hooks/useVaultApi'
import type { NavigationTab } from '../../../shared/validation/ipc-schemas'

interface HeaderProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  onSearchSubmit?: (query: string) => void
  onClearSearch?: () => void
  hasActiveUnifiedSearch?: boolean
  searchInputRef?: RefObject<HTMLInputElement | null>
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
  onSearchSubmit,
  onClearSearch,
  hasActiveUnifiedSearch = false,
  searchInputRef,
  state,
  currentTab,
  isNavOpen = false,
  onToggleNav,
  navToggleRef
}: HeaderProps) {
  const internalInputRef = useRef<HTMLInputElement | null>(null)
  const resolvedInputRef = searchInputRef ?? internalInputRef
  const hideGlobalSearch = currentTab === 'photos' || currentTab === 'documents'
  const searchAvailable =
    state.phase === 'ready' && state.vaultStatus.sourceCount > 0 && !hideGlobalSearch

  const triggerSubmit = () => {
    if (!searchAvailable) return
    const trimmed = searchQuery.trim()
    if (trimmed) {
      onSearchSubmit?.(trimmed)
    }
  }

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    triggerSubmit()
  }

  const handleClear = () => {
    onSearchChange('')
    onClearSearch?.()
    resolvedInputRef.current?.focus()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      triggerSubmit()
    } else if (e.key === 'Escape' && (searchQuery.length > 0 || hasActiveUnifiedSearch)) {
      e.preventDefault()
      handleClear()
    }
  }

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

      {!hideGlobalSearch && (
        <form className="header-search-form" role="search" onSubmit={handleSubmit}>
          <div className="search-box">
            <Search size={16} className="header-search-icon" aria-hidden="true" />
            <input
              ref={resolvedInputRef}
              type="search"
              className="search-input"
              placeholder="Search"
              value={searchQuery}
              maxLength={500}
              onChange={(event) => onSearchChange(event.target.value)}
              onKeyDown={handleKeyDown}
              aria-label="Search"
              aria-describedby="search-help"
              disabled={!searchAvailable}
            />
            {searchAvailable && (searchQuery.length > 0 || hasActiveUnifiedSearch) && (
              <button
                type="button"
                className="header-search-clear-btn"
                data-testid="unified-search-clear-btn"
                aria-label="Clear search"
                onClick={handleClear}
              >
                <X size={15} aria-hidden="true" />
              </button>
            )}
            <span id="search-help" className="visually-hidden">
              {searchAvailable
                ? 'Press Enter to search across photos and documents.'
                : 'Search is unavailable until a source has been connected.'}
            </span>
          </div>
        </form>
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
