import { useEffect, useState } from 'react'
import type { AppInfo, VaultStatus, NavigationTab } from '../../../shared/validation/ipc-schemas.js'

export function useVaultApi() {
  const [appInfo, setAppInfo] = useState<AppInfo>({
    name: 'Personal Vault',
    version: '0.1.0',
    platform: 'desktop',
    isPackaged: false
  })

  const [vaultStatus, setVaultStatus] = useState<VaultStatus>({
    sourceCount: 0,
    itemCount: 0,
    isReady: true
  })

  useEffect(() => {
    let isMounted = true

    if (typeof window !== 'undefined' && window.api) {
      window.api
        .getAppInfo()
        .then((info) => {
          if (isMounted) setAppInfo(info)
        })
        .catch((err) => {
          console.error('Error fetching app info:', err)
        })

      window.api
        .getVaultStatus()
        .then((status) => {
          if (isMounted) setVaultStatus(status)
        })
        .catch((err) => {
          console.error('Error fetching vault status:', err)
        })
    }

    return () => {
      isMounted = false
    }
  }, [])

  const setTab = async (tab: NavigationTab) => {
    if (typeof window !== 'undefined' && window.api) {
      try {
        await window.api.setTab(tab)
      } catch (err) {
        console.error('Failed to notify tab change via IPC:', err)
      }
    }
  }

  return {
    appInfo,
    vaultStatus,
    setTab
  }
}
