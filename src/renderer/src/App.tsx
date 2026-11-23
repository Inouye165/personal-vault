import { useCallback, useEffect, useRef, useState } from 'react'
import { DuplicateReviewPanel } from './components/DuplicateReviewPanel'
import { DocumentsPanel } from './components/DocumentsPanel'
import { EmptyState } from './components/EmptyState'
import { Header } from './components/Header'
import { PhotosPanel } from './components/PhotosPanel'
import { ScanJobsPanel } from './components/ScanJobsPanel'
import { Sidebar } from './components/Sidebar'
import { UnifiedSearchPanel } from './components/UnifiedSearchPanel'
import { VaultImportPanel } from './components/VaultImportPanel'
import { BackupRestorePanel } from './components/BackupRestorePanel'
import { useScanJobs } from './hooks/useScanJobs'
import { useMediaQuery } from './hooks/useMediaQuery'
import { useTheme } from './hooks/useTheme'
import { useUnifiedSearch } from './hooks/useUnifiedSearch'
import { useVaultApi } from './hooks/useVaultApi'
import type { NavigationTab } from '../../shared/validation/ipc-schemas'

export function App() {
  const [currentTab, setCurrentTab] = useState<NavigationTab>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false)
  const isMobileViewport = useMediaQuery('(max-width: 767px)')
  const mobileNavTriggerRef = useRef<HTMLButtonElement>(null)
  const headerSearchInputRef = useRef<HTMLInputElement>(null)
  const { state, notifyTab, refreshStatus } = useVaultApi()
  const { theme, setTheme } = useTheme()
  const scanJobs = useScanJobs()
  const isAllSurfaceActive =
    state.phase === 'ready' && state.vaultStatus.sourceCount > 0 && currentTab === 'all'
  const unifiedSearch = useUnifiedSearch({ isSurfaceActive: isAllSurfaceActive })

  const closeMobileNav = useCallback(() => {
    setIsMobileNavOpen(false)
  }, [])

  const selectTab = (tab: NavigationTab) => {
    setCurrentTab(tab)
    setIsMobileNavOpen(false)
    void notifyTab(tab)
  }

  // Close mobile drawer only when viewport transitions from mobile to desktop
  const prevMobileRef = useRef(isMobileViewport)
  useEffect(() => {
    if (prevMobileRef.current && !isMobileViewport && isMobileNavOpen) {
      setIsMobileNavOpen(false)
    }
    prevMobileRef.current = isMobileViewport
  }, [isMobileViewport, isMobileNavOpen])

  // When a scan completes, refresh vault status counts
  useEffect(() => {
    if (scanJobs.job?.status === 'completed') {
      void refreshStatus()
    }
  }, [scanJobs.job?.status, refreshStatus])

  const scanPanelProps = {
    job: scanJobs.job,
    selectedRoots: scanJobs.selectedRoots,
    actionError: scanJobs.actionError,
    onSelectRoots: scanJobs.selectRoots,
    onStartScan: scanJobs.startScan,
    onPauseScan: scanJobs.pauseScan,
    onResumeScan: scanJobs.resumeScan,
    onCancelScan: scanJobs.cancelScan,
    onDismissJob: scanJobs.dismissJob,
    onClearRoots: scanJobs.clearRoots,
    onClearJob: scanJobs.clearJob
  }

  return (
    <div className="app-container">
      <Sidebar
        currentTab={currentTab}
        onSelectTab={selectTab}
        appVersion={state.phase === 'ready' ? state.appInfo.version : undefined}
        isOpen={isMobileNavOpen}
        isMobileViewport={isMobileViewport}
        onClose={closeMobileNav}
        restoreFocusTo={() => mobileNavTriggerRef.current}
      />
      <main className="main-wrapper">
        <Header
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSearchSubmit={(query) => {
            if (currentTab !== 'all') {
              selectTab('all')
            }
            unifiedSearch.submitSearch(query)
          }}
          onClearSearch={() => {
            setSearchQuery('')
            unifiedSearch.clearSearch()
          }}
          hasActiveUnifiedSearch={unifiedSearch.hasActiveSearch}
          searchInputRef={headerSearchInputRef}
          state={state}
          currentTab={currentTab}
          isNavOpen={isMobileNavOpen}
          onToggleNav={() => setIsMobileNavOpen((prev) => !prev)}
          navToggleRef={mobileNavTriggerRef}
          theme={theme}
          onSelectTheme={setTheme}
        />
        <div className="content-area">
          {state.phase === 'loading' && (
            <div className="notice" role="status">
              Connecting to Personal Vault…
            </div>
          )}
          {state.phase === 'error' && (
            <div className="notice notice-error" role="alert">
              <strong>Something went wrong</strong>
              <p>{state.message}</p>
            </div>
          )}
          {state.phase === 'ready' && currentTab === 'backup' && <BackupRestorePanel />}
          {state.phase === 'ready' &&
            currentTab !== 'backup' &&
            state.vaultStatus.sourceCount === 0 && (
              <EmptyState currentTab={currentTab} scanJobsProps={scanPanelProps} />
            )}
          {state.phase === 'ready' &&
            state.vaultStatus.sourceCount > 0 &&
            currentTab === 'photos' && <PhotosPanel scanJobs={scanPanelProps} />}
          {state.phase === 'ready' &&
            state.vaultStatus.sourceCount > 0 &&
            currentTab === 'documents' && <DocumentsPanel />}
          {state.phase === 'ready' &&
            state.vaultStatus.sourceCount > 0 &&
            currentTab === 'duplicates' && <DuplicateReviewPanel />}
          {state.phase === 'ready' &&
            state.vaultStatus.sourceCount > 0 &&
            currentTab === 'review' && <VaultImportPanel />}
          {state.phase === 'ready' &&
            state.vaultStatus.sourceCount > 0 &&
            currentTab !== 'photos' &&
            currentTab !== 'documents' &&
            currentTab !== 'duplicates' &&
            currentTab !== 'review' &&
            currentTab !== 'backup' &&
            (unifiedSearch.hasActiveSearch ? (
              <UnifiedSearchPanel
                search={unifiedSearch}
                isMobileViewport={isMobileViewport}
                onNavigateTab={selectTab}
              />
            ) : (
              <div className="catalog-populated-view">
                <ScanJobsPanel {...scanPanelProps} />
                <div className="populated-summary-card">
                  <h2>Catalog Inventory</h2>
                  <p>
                    Connected Sources: <strong>{state.vaultStatus.sourceCount}</strong>
                  </p>
                  <p>
                    Cataloged Files: <strong>{state.vaultStatus.itemCount}</strong>
                  </p>
                </div>
              </div>
            ))}
        </div>
      </main>
    </div>
  )
}
