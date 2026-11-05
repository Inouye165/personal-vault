import React, { useState } from 'react'
import { Sidebar } from './components/Sidebar.js'
import { Header } from './components/Header.js'
import { EmptyState } from './components/EmptyState.js'
import { useVaultApi } from './hooks/useVaultApi.js'
import type { NavigationTab } from '../../shared/validation/ipc-schemas.js'

export const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState<NavigationTab>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const { appInfo, vaultStatus, setTab } = useVaultApi()

  const handleTabSelect = (tab: NavigationTab) => {
    setCurrentTab(tab)
    setTab(tab)
  }

  return (
    <div className="app-container">
      <Sidebar currentTab={currentTab} onSelectTab={handleTabSelect} appVersion={appInfo.version} />
      <main className="main-wrapper" role="main">
        <Header searchQuery={searchQuery} onSearchChange={setSearchQuery} status={vaultStatus} />
        <div className="content-area">
          <EmptyState currentTab={currentTab} />
        </div>
      </main>
    </div>
  )
}
