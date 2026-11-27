import { useCallback, useEffect, useState } from 'react'
import type { UpdateStateDto } from '../../../shared/validation/update-ipc-schemas'

export interface UseAppUpdaterResult {
  readonly updateState: UpdateStateDto | null
  readonly checkForUpdates: () => Promise<void>
  readonly installUpdateNow: () => Promise<void>
  readonly deferUpdate: () => Promise<void>
  readonly dismissUpdateError: () => Promise<void>
}

export function useAppUpdater(): UseAppUpdaterResult {
  const [updateState, setUpdateState] = useState<UpdateStateDto | null>(null)

  useEffect(() => {
    const api = window.api
    if (typeof api?.getUpdateState !== 'function' || typeof api?.onUpdateState !== 'function') {
      return
    }

    let cancelled = false
    const unsubscribe = api.onUpdateState((nextState) => {
      if (!cancelled) {
        setUpdateState(nextState)
      }
    })

    void api
      .getUpdateState()
      .then((initialState) => {
        if (!cancelled) {
          setUpdateState(initialState)
        }
      })
      .catch(() => {
        // Ignore bridge startup failures; main bridge error handling covers fatal issues.
      })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const checkForUpdates = useCallback(async () => {
    if (typeof window.api?.checkForUpdates !== 'function') return
    const res = await window.api.checkForUpdates()
    setUpdateState(res.state)
  }, [])

  const installUpdateNow = useCallback(async () => {
    if (typeof window.api?.installUpdateNow !== 'function') return
    const res = await window.api.installUpdateNow()
    setUpdateState(res.state)
  }, [])

  const deferUpdate = useCallback(async () => {
    if (typeof window.api?.deferUpdate !== 'function') return
    const res = await window.api.deferUpdate()
    setUpdateState(res.state)
  }, [])

  const dismissUpdateError = useCallback(async () => {
    if (typeof window.api?.dismissUpdateError !== 'function') return
    const res = await window.api.dismissUpdateError()
    setUpdateState(res.state)
  }, [])

  return {
    updateState,
    checkForUpdates,
    installUpdateNow,
    deferUpdate,
    dismissUpdateError
  }
}
