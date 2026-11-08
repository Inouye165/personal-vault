/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'

describe('Main Process — Stage 4 Vault IPC Security and Registration', () => {
  it('registers handlers for vault channels', async () => {
    const registeredChannels: string[] = []
    const mockIpcMain = {
      handle: (channel: string) => {
        registeredChannels.push(channel)
      },
      on: vi.fn()
    }

    vi.doMock('electron', () => ({
      ipcMain: mockIpcMain,
      dialog: { showOpenDialog: vi.fn() }
    }))

    const { registerIpcHandlers } = await import('../../src/main/ipc/handlers')
    const mockCatalog = {} as unknown as import('../../src/main/services/catalog').CatalogDatabase
    const mockJobCoordinator =
      {} as unknown as import('../../src/main/services/jobs').ScanJobCoordinator
    const mockVaultCoordinator =
      {} as unknown as import('../../src/main/services/vault').VaultImportCoordinator

    registerIpcHandlers({
      validateSender: () => true,
      catalog: mockCatalog,
      coordinator: mockJobCoordinator,
      vaultCoordinator: mockVaultCoordinator
    })

    expect(registeredChannels).toContain(IPC_CHANNELS.VAULT_SELECT_DIRECTORY)
    expect(registeredChannels).toContain(IPC_CHANNELS.VAULT_INITIALIZE)
    expect(registeredChannels).toContain(IPC_CHANNELS.VAULT_GET_ACTIVE)
    expect(registeredChannels).toContain(IPC_CHANNELS.VAULT_GET_IMPORT_CANDIDATES)
    expect(registeredChannels).toContain(IPC_CHANNELS.VAULT_START_IMPORT)
  })
})
