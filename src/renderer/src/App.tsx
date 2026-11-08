import { useEffect, useState } from 'react'
import { DuplicateReviewPanel } from './components/DuplicateReviewPanel'
import { EmptyState } from './components/EmptyState'
import { Header } from './components/Header'
import { ScanJobsPanel } from './components/ScanJobsPanel'
import { Sidebar } from './components/Sidebar'
import { VaultImportPanel } from './components/VaultImportPanel'
import { useScanJobs } from './hooks/useScanJobs'
import { useVaultApi } from './hooks/useVaultApi'
import type { NavigationTab } from '../../shared/validation/ipc-schemas'

export function App() {
  const [currentTab, setCurrentTab] = useState<NavigationTab>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const { state, notifyTab, refreshStatus } = useVaultApi()
  const scanJobs = useScanJobs()

  const selectTab = (tab: NavigationTab) => {
    setCurrentTab(tab)
    void notifyTab(tab)
  }

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
      />
      <main className="main-wrapper">
        <Header searchQuery={searchQuery} onSearchChange={setSearchQuery} state={state} />
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
          {state.phase === 'ready' && state.vaultStatus.sourceCount === 0 && (
            <EmptyState currentTab={currentTab} scanJobsProps={scanPanelProps} />
          )}
          {state.phase === 'ready' &&
            state.vaultStatus.sourceCount > 0 &&
            currentTab === 'duplicates' && <DuplicateReviewPanel />}
          {state.phase === 'ready' &&
            state.vaultStatus.sourceCount > 0 &&
            currentTab === 'review' && <VaultImportPanel />}
          {state.phase === 'ready' &&
            state.vaultStatus.sourceCount > 0 &&
            currentTab !== 'duplicates' &&
            currentTab !== 'review' && (
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
            )}
        </div>
      </main>
    </div>
  )
}
