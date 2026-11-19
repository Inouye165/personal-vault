/**
 * @vitest-environment node
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import { SemanticModelManager } from '../../src/main/services/semantic/model-manager'
import { SemanticSearchCoordinator } from '../../src/main/services/semantic/search-coordinator'
import { DocumentExtractionCoordinator } from '../../src/main/services/documents/coordinator'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'

type IpcHandler = (...args: unknown[]) => unknown
const ipcHandlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      ipcHandlers.set(channel, handler)
    }
  }
}))

describe('Photos IPC Handlers', () => {
  let tempDir: string
  let catalog: CatalogDatabase
  let thumbnailCoordinator: ThumbnailCoordinator

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-photos-ipc-test-'))
    const catalogPath = join(tempDir, 'catalog.db')
    const cacheDir = join(tempDir, 'cache')
    catalog = CatalogDatabase.open({ catalogPath })
    thumbnailCoordinator = new ThumbnailCoordinator({ cacheDir })
    ipcHandlers.clear()
  })

  afterEach(async () => {
    try {
      await thumbnailCoordinator.shutdown()
      catalog.close()
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('rejects unauthorized senders for PHOTOS channels', async () => {
    const validateSender = vi.fn().mockReturnValue(false)
    registerIpcHandlers({
      validateSender,
      catalog,
      thumbnailCoordinator
    })

    const pageHandler = ipcHandlers.get(IPC_CHANNELS.PHOTOS_GET_PAGE)
    expect(pageHandler).toBeDefined()

    await expect(pageHandler!({} as never, { offset: 0, limit: 10 })).rejects.toThrow(
      /Unauthorized IPC sender/i
    )

    const thumbHandler = ipcHandlers.get(IPC_CHANNELS.PHOTOS_GET_THUMBNAIL)
    expect(thumbHandler).toBeDefined()

    await expect(thumbHandler!({} as never, { locationId: 1 })).rejects.toThrow(
      /Unauthorized IPC sender/i
    )
  })

  it('returns paginated photos for authorized sender', async () => {
    const validateSender = vi.fn().mockReturnValue(true)
    registerIpcHandlers({
      validateSender,
      catalog,
      thumbnailCoordinator
    })

    catalog.registerSource('C:\\photos')
    catalog.persistDiscoveryBatch('C:\\photos', [
      {
        originalPath: 'C:\\photos\\img1.jpg',
        fileName: 'img1.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 1024,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000005000,
        discoveredAtMs: 1700000010000
      }
    ])

    const pageHandler = ipcHandlers.get(IPC_CHANNELS.PHOTOS_GET_PAGE)
    const result = (await pageHandler!({} as never, { offset: 0, limit: 10 })) as {
      totalCount: number
      items: Array<{ fileName: string }>
    }
    expect(result.totalCount).toBe(1)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.fileName).toBe('img1.jpg')
  })

  it('returns missing for non-existent photo location ID', async () => {
    const validateSender = vi.fn().mockReturnValue(true)
    registerIpcHandlers({
      validateSender,
      catalog,
      thumbnailCoordinator
    })

    const thumbHandler = ipcHandlers.get(IPC_CHANNELS.PHOTOS_GET_THUMBNAIL)
    const result = (await thumbHandler!({} as never, { locationId: 9999 })) as {
      status: string
      locationId: number
    }
    expect(result.status).toBe('missing')
    expect(result.locationId).toBe(9999)
  })

  it('includes semantic search worker diagnostics and totalAppLiveWorkers in PHOTOS_GET_DIAGNOSTICS', async () => {
    const validateSender = vi.fn().mockReturnValue(true)
    const modelManager = new SemanticModelManager({
      modelsRootDir: join(tempDir, 'models'),
      getApprovedRoots: () => [],
      getVaultRoot: () => null
    })
    const semanticSearchCoordinator = new SemanticSearchCoordinator({
      catalog,
      modelManager
    })

    const documentExtractionCoordinator = new DocumentExtractionCoordinator({ catalog })
    registerIpcHandlers({
      validateSender,
      catalog,
      thumbnailCoordinator,
      semanticSearchCoordinator,
      documentExtractionCoordinator
    })

    const diagHandler = ipcHandlers.get(IPC_CHANNELS.PHOTOS_GET_DIAGNOSTICS)
    expect(diagHandler).toBeDefined()

    const diag = (await diagHandler!({} as never)) as {
      activeWorkers: number
      liveWorkers?: number
      searchActiveWorkers?: number
      searchTerminatingWorkers?: number
      searchLiveWorkers?: number
      searchPendingRequests?: number
      searchActiveCalls?: number
      searchMaxPendingRequests?: number
      documentActiveWorkers?: number
      documentTerminatingWorkers?: number
      documentLiveWorkers?: number
      totalAppLiveWorkers?: number
    }

    expect(diag.searchActiveWorkers).toBe(0)
    expect(diag.searchTerminatingWorkers).toBe(0)
    expect(diag.searchLiveWorkers).toBe(0)
    expect(diag.searchPendingRequests).toBe(0)
    expect(diag.searchActiveCalls).toBe(0)
    expect(diag.searchMaxPendingRequests).toBe(16)
    expect(diag.documentActiveWorkers).toBe(0)
    expect(diag.documentTerminatingWorkers).toBe(0)
    expect(diag.documentLiveWorkers).toBe(0)
    expect(diag.totalAppLiveWorkers).toBe(0)

    await semanticSearchCoordinator.shutdown()
    await documentExtractionCoordinator.shutdown()
  })

  it('includes OCR worker diagnostics and sums totalAppLiveWorkers without double-counting', async () => {
    const validateSender = vi.fn().mockReturnValue(true)
    const mockOcrCoordinator = {
      getDiagnostics: vi.fn().mockReturnValue({
        activeWorkers: 1,
        terminatingWorkers: 1,
        liveWorkers: 2,
        budgetLiveCount: 3,
        budgetReservedCount: 3,
        activeJobId: 'job-1',
        activeFileLocationId: 42
      })
    }

    registerIpcHandlers({
      validateSender,
      catalog,
      thumbnailCoordinator,
      documentOcrCoordinator: mockOcrCoordinator as never
    })

    const diagHandler = ipcHandlers.get(IPC_CHANNELS.PHOTOS_GET_DIAGNOSTICS)
    expect(diagHandler).toBeDefined()

    const diag = (await diagHandler!({} as never)) as {
      ocrActiveWorkers?: number
      ocrTerminatingWorkers?: number
      ocrLiveWorkers?: number
      totalAppLiveWorkers?: number
    }

    expect(diag.ocrActiveWorkers).toBe(1)
    expect(diag.ocrTerminatingWorkers).toBe(1)
    expect(diag.ocrLiveWorkers).toBe(2)
    // Must add ocrLiveWorkers (2) to thumbnail liveWorkers (0), NOT budgetLiveCount (3)
    expect(diag.totalAppLiveWorkers).toBe(2)
  })
})
