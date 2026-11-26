import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/contracts/channels'
import {
  UpdateActionResponseSchema,
  UpdateStateSchema,
  type UpdateStateDto
} from '../../shared/validation/update-ipc-schemas'
import type { UpdateCoordinator } from '../services/updater'

type RegisterHandleFn = (
  channel: string,
  handler: (...args: unknown[]) => Promise<unknown> | unknown
) => void

export interface UpdateIpcHandlerDeps {
  readonly handle: RegisterHandleFn
  readonly updateCoordinator?: UpdateCoordinator
  readonly currentVersion?: string
  readonly getCurrentVersion?: () => string
  readonly getMainWindow?: () => BrowserWindow | null
}

function defaultUnconfiguredState(currentVersion: string): UpdateStateDto {
  return {
    phase: 'idle',
    configured: false,
    currentVersion,
    availableVersion: null,
    releaseDate: null,
    downloadProgress: null,
    activeJobs: {
      vaultImportActive: false,
      backupActive: false
    },
    errorMessage: null,
    failedStage: null,
    lastCheckedAtMs: null
  }
}

export function registerUpdateIpcHandlers(deps: UpdateIpcHandlerDeps): void {
  const { handle, updateCoordinator, currentVersion, getCurrentVersion, getMainWindow } = deps
  const resolveDefaultState = () =>
    defaultUnconfiguredState(currentVersion ?? getCurrentVersion?.() ?? '0.0.0')

  handle(IPC_CHANNELS.UPDATE_GET_STATE, () => {
    const state = updateCoordinator ? updateCoordinator.getState() : resolveDefaultState()
    return UpdateStateSchema.parse(state)
  })

  handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    const response = updateCoordinator
      ? await updateCoordinator.checkForUpdates({ background: false })
      : { accepted: false, state: resolveDefaultState() }
    return UpdateActionResponseSchema.parse(response)
  })

  handle(IPC_CHANNELS.UPDATE_INSTALL_NOW, () => {
    const response = updateCoordinator
      ? updateCoordinator.installUpdateNow()
      : { accepted: false, state: resolveDefaultState() }
    return UpdateActionResponseSchema.parse(response)
  })

  handle(IPC_CHANNELS.UPDATE_DEFER, () => {
    const response = updateCoordinator
      ? updateCoordinator.deferUpdate()
      : { accepted: false, state: resolveDefaultState() }
    return UpdateActionResponseSchema.parse(response)
  })

  handle(IPC_CHANNELS.UPDATE_DISMISS_ERROR, () => {
    const response = updateCoordinator
      ? updateCoordinator.dismissError()
      : { accepted: false, state: resolveDefaultState() }
    return UpdateActionResponseSchema.parse(response)
  })

  handle(IPC_CHANNELS.UPDATE_STATE_EVENT, (): never => {
    throw new Error('Event-only channel cannot be invoked')
  })

  if (updateCoordinator && getMainWindow) {
    updateCoordinator.onStateChange((state) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        const parsed = UpdateStateSchema.safeParse(state)
        if (parsed.success) {
          win.webContents.send(IPC_CHANNELS.UPDATE_STATE_EVENT, parsed.data)
        }
      }
    })
  }
}
