import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, NavigationTab, VaultStatus } from '../../../shared/validation/ipc-schemas'

export type BridgeState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly appInfo: AppInfo; readonly vaultStatus: VaultStatus }
  | { readonly phase: 'error'; readonly message: string }

const MISSING_BRIDGE_MESSAGE =
  'Personal Vault could not connect to its application services. Restart the application. If the problem continues, check the application log.'

const failure = (error: unknown): BridgeState => ({
  phase: 'error',
  message:
    error instanceof Error && error.message
      ? `Personal Vault could not complete a request to its application services: ${error.message}`
      : MISSING_BRIDGE_MESSAGE
})

/**
 * Connects to the preload bridge. Never substitutes default values: the state is
 * `loading` until the bridge answers, `ready` only with real responses, and
 * `error` if the bridge is missing, rejects, or fails to acknowledge a request.
 */
export function useVaultApi(): {
  state: BridgeState
  notifyTab: (tab: NavigationTab) => Promise<void>
} {
  const [state, setState] = useState<BridgeState>({ phase: 'loading' })

  useEffect(() => {
    let active = true
    const api = window.api
    if (!api) {
      setState({ phase: 'error', message: MISSING_BRIDGE_MESSAGE })
      return
    }

    Promise.all([api.getAppInfo(), api.getVaultStatus()]).then(
      ([appInfo, vaultStatus]) => {
        if (active) setState({ phase: 'ready', appInfo, vaultStatus })
      },
      (error: unknown) => {
        if (active) setState(failure(error))
      }
    )

    return () => {
      active = false
    }
  }, [])

  const notifyTab = useCallback(async (tab: NavigationTab) => {
    const api = window.api
    if (!api) {
      setState({ phase: 'error', message: MISSING_BRIDGE_MESSAGE })
      return
    }
    try {
      if (!(await api.setTab(tab))) {
        setState({
          phase: 'error',
          message: 'Personal Vault’s application services did not accept the requested view.'
        })
      }
    } catch (error) {
      setState(failure(error))
    }
  }, [])

  return { state, notifyTab }
}
