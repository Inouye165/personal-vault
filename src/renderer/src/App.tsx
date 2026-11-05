import { useState } from 'react'
import { EmptyState } from './components/EmptyState'
import { Header } from './components/Header'
import { Sidebar } from './components/Sidebar'
import { useVaultApi } from './hooks/useVaultApi'
import type { NavigationTab } from '../../shared/validation/ipc-schemas'

export function App() {
  const [currentTab, setCurrentTab] = useState<NavigationTab>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const { state, notifyTab } = useVaultApi()

  const selectTab = (tab: NavigationTab) => {
    setCurrentTab(tab)
    void notifyTab(tab)
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
            <EmptyState currentTab={currentTab} />
          )}
        </div>
      </main>
    </div>
  )
}
