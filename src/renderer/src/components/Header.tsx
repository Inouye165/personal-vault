import { Check, Menu, Moon, MoreHorizontal, Search, Sun, X } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject
} from 'react'
import type { BridgeState } from '../hooks/useVaultApi'
import type { ThemeMode } from '../hooks/useTheme'
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
  theme?: ThemeMode
  onSelectTheme?: (theme: ThemeMode) => void
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
  navToggleRef,
  theme = 'light',
  onSelectTheme
}: HeaderProps) {
  const internalInputRef = useRef<HTMLInputElement | null>(null)
  const resolvedInputRef = searchInputRef ?? internalInputRef
  const [isAppMenuOpen, setIsAppMenuOpen] = useState(false)
  const appMenuWrapperRef = useRef<HTMLDivElement>(null)
  const appMenuBtnRef = useRef<HTMLButtonElement>(null)
  const hideGlobalSearch = currentTab === 'photos' || currentTab === 'documents'
  const searchAvailable =
    state.phase === 'ready' && state.vaultStatus.sourceCount > 0 && !hideGlobalSearch

  useEffect(() => {
    if (!isAppMenuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      if (appMenuWrapperRef.current && !appMenuWrapperRef.current.contains(event.target as Node)) {
        setIsAppMenuOpen(false)
      }
    }
    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setIsAppMenuOpen(false)
        appMenuBtnRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleDocumentKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleDocumentKeyDown)
    }
  }, [isAppMenuOpen])

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

        <div ref={appMenuWrapperRef} className="app-menu-wrapper">
          <button
            ref={appMenuBtnRef}
            type="button"
            className="app-menu-trigger-btn"
            data-testid="app-menu-btn"
            aria-label="App menu"
            aria-haspopup="menu"
            aria-expanded={isAppMenuOpen}
            aria-controls="app-appearance-menu"
            onClick={() => setIsAppMenuOpen((prev) => !prev)}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>

          {isAppMenuOpen && (
            <div
              id="app-appearance-menu"
              className="app-menu-popover"
              data-testid="app-menu"
              role="menu"
              aria-label="App menu"
            >
              <div className="app-menu-section-title" role="presentation">
                Appearance
              </div>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={theme === 'light'}
                data-testid="theme-option-light"
                className={`app-menu-item ${theme === 'light' ? 'selected' : ''}`}
                onClick={() => {
                  onSelectTheme?.('light')
                  setIsAppMenuOpen(false)
                }}
              >
                <span className="app-menu-item-label">
                  <Sun size={15} aria-hidden="true" />
                  <span>Light</span>
                </span>
                {theme === 'light' && <Check size={14} aria-hidden="true" />}
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={theme === 'dark'}
                data-testid="theme-option-dark"
                className={`app-menu-item ${theme === 'dark' ? 'selected' : ''}`}
                onClick={() => {
                  onSelectTheme?.('dark')
                  setIsAppMenuOpen(false)
                }}
              >
                <span className="app-menu-item-label">
                  <Moon size={15} aria-hidden="true" />
                  <span>Dark</span>
                </span>
                {theme === 'dark' && <Check size={14} aria-hidden="true" />}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
