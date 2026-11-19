// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'

type IpcHandler = (...args: unknown[]) => unknown
const ipcHandlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.1.0', isPackaged: false },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      ipcHandlers.set(channel, handler)
    }
  }
}))

describe('Stage 7F Slice 1: Unified Search IPC Handlers & Sender Validation', () => {
  let tempDir: string
  let catalog: CatalogDatabase

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-unified-ipc-'))
    catalog = CatalogDatabase.open({ catalogPath: join(tempDir, 'catalog.sqlite') })
    ipcHandlers.clear()
  })

  afterEach(() => {
    try {
      catalog.close()
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('rejects unauthorized senders across unified search and cancel channels', async () => {
    registerIpcHandlers({
      validateSender: vi.fn().mockReturnValue(false),
      catalog
    })

    await expect(
      ipcHandlers.get(IPC_CHANNELS.UNIFIED_SEARCH_PHOTOS)!(
        {},
        {
          query: 'beach',
          ownerSurface: 'unified',
          ownerGen: 1
        }
      )
    ).rejects.toThrow(/Unauthorized IPC sender/i)

    await expect(
      ipcHandlers.get(IPC_CHANNELS.UNIFIED_SEARCH_DOCUMENTS)!(
        {},
        {
          query: 'invoice',
          ownerSurface: 'unified',
          ownerGen: 1
        }
      )
    ).rejects.toThrow(/Unauthorized IPC sender/i)

    await expect(
      ipcHandlers.get(IPC_CHANNELS.UNIFIED_SEARCH_CANCEL)!(
        {},
        {
          ownerSurface: 'unified',
          ownerGen: 1
        }
      )
    ).rejects.toThrow(/Unauthorized IPC sender/i)
  })

  it('validates unified requests and enforces tab ownership across unified and tab cancel channels', async () => {
    registerIpcHandlers({
      validateSender: vi.fn().mockReturnValue(true),
      catalog
    })

    await expect(
      ipcHandlers.get(IPC_CHANNELS.UNIFIED_SEARCH_PHOTOS)!(
        {},
        {
          query: '   ',
          ownerSurface: 'unified',
          ownerGen: 1
        }
      )
    ).rejects.toThrow(/Invalid incoming UnifiedSearchPhotosRequest/i)

    await expect(
      ipcHandlers.get(IPC_CHANNELS.UNIFIED_SEARCH_DOCUMENTS)!(
        {},
        {
          query: 'invoice',
          ownerSurface: 'documents-tab',
          ownerGen: 1
        }
      )
    ).rejects.toThrow(/Invalid incoming UnifiedSearchDocumentsRequest/i)

    const photoRes = await ipcHandlers.get(IPC_CHANNELS.UNIFIED_SEARCH_PHOTOS)!(
      {},
      {
        query: 'beach',
        ownerSurface: 'unified',
        ownerGen: 1
      }
    )
    expect(photoRes).toMatchObject({
      status: 'unprovisioned',
      modelId: 'Xenova/clip-vit-base-patch32',
      result: null
    })

    const docRes = await ipcHandlers.get(IPC_CHANNELS.UNIFIED_SEARCH_DOCUMENTS)!(
      {},
      {
        query: 'invoice',
        ownerSurface: 'unified',
        ownerGen: 1
      }
    )
    expect(docRes).toMatchObject({
      status: 'unprovisioned',
      modelId: 'Xenova/bge-small-en-v1.5',
      result: null
    })

    // Delayed tab cancel from 'photos-tab' must not cancel 'unified' owner
    const delayedPhotoTabCancel = await ipcHandlers.get(IPC_CHANNELS.SEMANTIC_SEARCH_CANCEL)!(
      {},
      {}
    )
    expect(delayedPhotoTabCancel).toEqual({ cancelled: false })

    // Matching unified cancel cancels active unified ownership
    const unifiedCancel = await ipcHandlers.get(IPC_CHANNELS.UNIFIED_SEARCH_CANCEL)!(
      {},
      {
        ownerSurface: 'unified',
        ownerGen: 1,
        modality: 'all'
      }
    )
    expect(unifiedCancel).toEqual({ cancelled: true })
  })
})
