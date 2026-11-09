/**
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import { SimilarityCoordinator } from '../../src/main/services/similarity/coordinator'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import type {
  SimilarityAnalysisProgress,
  SimilarityGetPairsResponse,
  SimilarityDecisionResult
} from '../../src/shared/validation/ipc-schemas'

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

describe('Stage 5C — Similarity IPC Handlers', () => {
  let tempDir: string
  let catalog: CatalogDatabase
  let thumbnailCoordinator: ThumbnailCoordinator
  let similarityCoordinator: SimilarityCoordinator
  const validEvent = { senderFrame: { url: 'http://localhost:5173' } }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-similarity-ipc-test-'))
    const catalogPath = join(tempDir, 'catalog.db')
    const cacheDir = join(tempDir, 'cache')
    const photosDir = join(tempDir, 'photos')

    catalog = CatalogDatabase.open({ catalogPath })
    thumbnailCoordinator = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: [photosDir]
    })
    similarityCoordinator = new SimilarityCoordinator({
      catalog,
      thumbnailCoordinator
    })

    ipcHandlers.clear()

    registerIpcHandlers({
      validateSender: (event: { senderFrame?: { url?: string } }) => {
        return event?.senderFrame?.url === 'http://localhost:5173'
      },
      catalog,
      thumbnailCoordinator,
      similarityCoordinator
    })
  })

  afterEach(async () => {
    await similarityCoordinator.shutdown()
    await thumbnailCoordinator.shutdown()
    try {
      catalog.close()
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('rejects calls from untrusted sender frame', async () => {
    const invalidEvent = { senderFrame: { url: 'http://malicious.site' } }
    const startHandler = ipcHandlers.get(IPC_CHANNELS.SIMILARITY_START_ANALYSIS)
    expect(startHandler).toBeDefined()

    await expect(startHandler!(invalidEvent)).rejects.toThrow('Unauthorized IPC sender')
  })

  it('returns valid initial progress across IPC', async () => {
    const getProgressHandler = ipcHandlers.get(IPC_CHANNELS.SIMILARITY_GET_PROGRESS)
    expect(getProgressHandler).toBeDefined()

    const res = (await getProgressHandler!(validEvent)) as SimilarityAnalysisProgress
    expect(res.status).toBe('idle')
    expect(res.totalPhotos).toBe(0)
    expect(res.processedPhotos).toBe(0)
  })

  it('handles get-pairs with pagination across IPC', async () => {
    const getPairsHandler = ipcHandlers.get(IPC_CHANNELS.SIMILARITY_GET_PAIRS)
    expect(getPairsHandler).toBeDefined()

    const res = (await getPairsHandler!(validEvent, {
      page: 1,
      pageSize: 10,
      filter: 'all'
    })) as SimilarityGetPairsResponse
    expect(res.pairs).toEqual([])
    expect(res.totalCount).toBe(0)
    expect(res.page).toBe(1)
    expect(res.pageSize).toBe(10)
  })

  it('persists and returns similarity decision across IPC', async () => {
    catalog.persistDiscoveryBatch('C:\\photos', [
      {
        originalPath: 'C:\\photos\\1.jpg',
        fileName: '1.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 100,
        birthtimeMs: 1000,
        mtimeMs: 1000,
        discoveredAtMs: 1000
      },
      {
        originalPath: 'C:\\photos\\2.jpg',
        fileName: '2.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 100,
        birthtimeMs: 1000,
        mtimeMs: 1000,
        discoveredAtMs: 1000
      }
    ])
    const loc1 = catalog.getFileLocationByPath('C:\\photos\\1.jpg')!
    const loc2 = catalog.getFileLocationByPath('C:\\photos\\2.jpg')!

    const rev1 = `rev:${loc1.discoveryObservationId}:${loc1.byteSize}:${loc1.filesystemMtimeMs ?? 'null'}:${loc1.activeHash ?? 'unhashed'}`
    const rev2 = `rev:${loc2.discoveryObservationId}:${loc2.byteSize}:${loc2.filesystemMtimeMs ?? 'null'}:${loc2.activeHash ?? 'unhashed'}`

    const setDecisionHandler = ipcHandlers.get(IPC_CHANNELS.SIMILARITY_SET_DECISION)
    expect(setDecisionHandler).toBeDefined()

    const res = (await setDecisionHandler!(validEvent, {
      locationIdA: loc1.id,
      locationIdB: loc2.id,
      expectedRevisionA: rev1,
      expectedRevisionB: rev2,
      decision: 'similar_scene'
    })) as SimilarityDecisionResult

    expect(res.success).toBe(true)
    expect(res.decision).toBe('similar_scene')
    expect(res.version).toBe(1)
    expect(res.persistencePending).toBe(false)
  })
})
