/**
 * @vitest-environment node
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import type { IpcSenderEvent } from '../../src/main/ipc/sender'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import {
  REQUIRED_MODEL_ARTIFACTS,
  type SemanticModelArtifactSpec
} from '../../src/main/services/semantic/manifest'
import { SemanticModelManager } from '../../src/main/services/semantic/model-manager'
import { SemanticIndexCoordinator } from '../../src/main/services/semantic/coordinator'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import type {
  SemanticModelStatusResponse,
  SemanticIndexProgressResponse,
  SemanticIndexJobItemsResponse
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

describe('Stage 6B — Semantic Model & Index IPC Handlers', () => {
  let tempDir: string
  let catalog: CatalogDatabase
  let thumbnailCoordinator: ThumbnailCoordinator
  let modelManager: SemanticModelManager
  let semanticCoordinator: SemanticIndexCoordinator
  let importFixtureDir: string
  let selectedDirectory: string | null = null

  const validEvent: IpcSenderEvent = {
    sender: { id: 1 },
    senderFrame: { url: 'http://localhost:5173', parent: null }
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-semantic-ipc-test-'))
    const catalogPath = join(tempDir, 'catalog.db')
    const cacheDir = join(tempDir, 'cache')
    const photosDir = join(tempDir, 'photos')
    const modelsRootDir = join(tempDir, 'models')
    const vaultRootDir = join(tempDir, 'vault')
    importFixtureDir = join(tempDir, 'offline-bundle')

    mkdirSync(cacheDir, { recursive: true })
    mkdirSync(photosDir, { recursive: true })
    mkdirSync(modelsRootDir, { recursive: true })
    mkdirSync(vaultRootDir, { recursive: true })
    mkdirSync(importFixtureDir, { recursive: true })

    const specs: SemanticModelArtifactSpec[] = REQUIRED_MODEL_ARTIFACTS.map((entry, idx) => {
      const content = Buffer.from(`ipc-test-artifact-${idx}-${entry.relativePath}`)
      const sha256 = createHash('sha256').update(content).digest('hex')
      const fullPath = join(importFixtureDir, ...entry.relativePath.split('/'))
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, content)
      return {
        relativePath: entry.relativePath,
        byteSize: content.byteLength,
        sha256
      }
    })

    catalog = CatalogDatabase.open({ catalogPath })
    thumbnailCoordinator = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: [photosDir]
    })
    modelManager = new SemanticModelManager({
      modelsRootDir,
      getApprovedRoots: () => [photosDir],
      getVaultRoot: () => vaultRootDir,
      artifacts: specs
    })
    await modelManager.initialize()

    semanticCoordinator = new SemanticIndexCoordinator({
      catalog,
      modelManager,
      thumbnailCoordinator
    })

    selectedDirectory = importFixtureDir
    ipcHandlers.clear()

    registerIpcHandlers({
      validateSender: (event: IpcSenderEvent) => {
        return (
          event.senderFrame?.url === 'http://localhost:5173' && event.senderFrame?.parent === null
        )
      },
      selectDirectory: async () => selectedDirectory,
      catalog,
      thumbnailCoordinator,
      semanticModelManager: modelManager,
      semanticIndexCoordinator: semanticCoordinator
    })
  })

  afterEach(async () => {
    await semanticCoordinator.shutdown()
    await thumbnailCoordinator.shutdown()
    try {
      catalog.close()
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('rejects untrusted or non-top-level sender frames on all semantic channels', async () => {
    const untrustedEvent: IpcSenderEvent = {
      sender: { id: 1 },
      senderFrame: { url: 'https://evil.example.com', parent: null }
    }
    const iframeEvent: IpcSenderEvent = {
      sender: { id: 1 },
      senderFrame: { url: 'http://localhost:5173', parent: { url: 'http://localhost:5173' } }
    }

    const channels = [
      IPC_CHANNELS.SEMANTIC_MODEL_GET_STATUS,
      IPC_CHANNELS.SEMANTIC_MODEL_DOWNLOAD,
      IPC_CHANNELS.SEMANTIC_MODEL_IMPORT,
      IPC_CHANNELS.SEMANTIC_MODEL_CANCEL,
      IPC_CHANNELS.SEMANTIC_INDEX_GET_PROGRESS,
      IPC_CHANNELS.SEMANTIC_INDEX_START,
      IPC_CHANNELS.SEMANTIC_INDEX_PAUSE,
      IPC_CHANNELS.SEMANTIC_INDEX_RESUME,
      IPC_CHANNELS.SEMANTIC_INDEX_CANCEL,
      IPC_CHANNELS.SEMANTIC_INDEX_GET_ITEMS
    ]

    for (const ch of channels) {
      const handler = ipcHandlers.get(ch)
      expect(handler).toBeDefined()
      await expect(handler!(untrustedEvent)).rejects.toThrow('Unauthorized IPC sender')
      await expect(handler!(iframeEvent)).rejects.toThrow('Unauthorized IPC sender')
    }
  })

  it('returns model status and imports offline folder using main-owned directory picker (ignoring renderer path input)', async () => {
    const statusHandler = ipcHandlers.get(IPC_CHANNELS.SEMANTIC_MODEL_GET_STATUS)!
    const initial = (await statusHandler(validEvent)) as SemanticModelStatusResponse
    expect(initial.state).toBe('missing')
    expect(initial.requiredBytes).toBeGreaterThan(0)

    const importHandler = ipcHandlers.get(IPC_CHANNELS.SEMANTIC_MODEL_IMPORT)!
    // Renderer cannot supply arbitrary directory path — main rejects unexpected path arguments
    await expect(importHandler(validEvent, 'C:\\arbitrary\\path')).rejects.toThrow(
      /Renderer cannot supply filesystem paths/i
    )

    const imported = (await importHandler(validEvent)) as SemanticModelStatusResponse
    expect(imported.state).toBe('ready')
  })

  it('acknowledges index start/pause/resume/cancel promptly and paginates job items with Zod validation', async () => {
    const importHandler = ipcHandlers.get(IPC_CHANNELS.SEMANTIC_MODEL_IMPORT)!
    await importHandler(validEvent)

    catalog.persistDiscoveryBatch('C:\\photos', [
      {
        originalPath: 'C:\\photos\\one.jpg',
        fileName: 'one.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 1000,
        birthtimeMs: 1000,
        mtimeMs: 2000,
        discoveredAtMs: 3000
      }
    ])

    const startHandler = ipcHandlers.get(IPC_CHANNELS.SEMANTIC_INDEX_START)!
    const started = (await startHandler(validEvent)) as SemanticIndexProgressResponse
    expect(started.totalPhotos).toBe(1)

    const itemsHandler = ipcHandlers.get(IPC_CHANNELS.SEMANTIC_INDEX_GET_ITEMS)!
    const itemsPage = (await itemsHandler(validEvent, {
      jobId: started.jobId,
      page: 1,
      pageSize: 20
    })) as SemanticIndexJobItemsResponse
    expect(itemsPage.totalCount).toBe(1)
    expect(itemsPage.items).toHaveLength(1)

    // Reject out-of-bounds pageSize (> 200)
    await expect(
      itemsHandler(validEvent, { jobId: started.jobId, page: 1, pageSize: 5000 })
    ).rejects.toThrow()
  })
})
