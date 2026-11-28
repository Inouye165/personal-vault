// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const registered = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => registered.set(channel, fn)
  },
  app: { getVersion: () => '0.1.0' },
  dialog: {}
}))

import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import {
  OriginalPhotoResultSchema,
  ThumbnailResultSchema
} from '../../src/shared/validation/ipc-schemas'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import { createSenderValidator } from '../../src/main/ipc/sender'
import { resolveAppLocation } from '../../src/main/navigation'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import { initializeVault } from '../../src/main/services/vault/identity'

const documentPath = resolve('app', 'out', 'renderer', 'index.html')
const documentUrl = pathToFileURL(documentPath).href
const TRUSTED_ID = 42
const trusted = { sender: { id: TRUSTED_ID }, senderFrame: { url: documentUrl, parent: null } }

function invoke(channel: string, event: unknown, payload: unknown): Promise<unknown> {
  const fn = registered.get(channel)
  if (!fn) throw new Error(`Missing handler for ${channel}`)
  return Promise.resolve(fn(event, payload))
}

describe('Stage 8D: photos:get-original IPC validation and error branches', () => {
  const location = resolveAppLocation({
    isPackaged: true,
    rendererUrl: undefined,
    documentPath
  })
  const validateSender = createSenderValidator({
    getTrustedWebContentsId: () => TRUSTED_ID,
    location
  })

  beforeEach(() => {
    registered.clear()
  })

  it('returns Zod-validated missing result when catalog or thumbnailCoordinator is unavailable', async () => {
    registerIpcHandlers({ validateSender, catalog: undefined })
    const res = await invoke(IPC_CHANNELS.PHOTOS_GET_ORIGINAL, trusted, { locationId: 1 })
    expect(OriginalPhotoResultSchema.safeParse(res).success).toBe(true)
    expect(res).toEqual({
      status: 'missing',
      locationId: 1,
      reason: 'Thumbnail coordinator or catalog unavailable'
    })
  })

  it('returns Zod-validated missing result for unknown locationId or non-photo category', async () => {
    const mockCatalog = {
      getFileLocationById: vi.fn((id: number) =>
        id === 99 ? { id: 99, category: 'document', originalPath: 'C:\\Docs\\doc.pdf' } : undefined
      )
    } as unknown as CatalogDatabase
    const mockThumb = {
      getOriginalPhoto: vi.fn()
    } as unknown as ThumbnailCoordinator

    registerIpcHandlers({
      validateSender,
      catalog: mockCatalog,
      thumbnailCoordinator: mockThumb
    })

    const unknownRes = await invoke(IPC_CHANNELS.PHOTOS_GET_ORIGINAL, trusted, { locationId: 777 })
    expect(OriginalPhotoResultSchema.safeParse(unknownRes).success).toBe(true)
    expect(unknownRes).toEqual({
      status: 'missing',
      locationId: 777,
      reason: 'Photograph location ID 777 not found in catalog'
    })

    const docRes = await invoke(IPC_CHANNELS.PHOTOS_GET_ORIGINAL, trusted, { locationId: 99 })
    expect(OriginalPhotoResultSchema.safeParse(docRes).success).toBe(true)
    expect(docRes).toEqual({
      status: 'missing',
      locationId: 99,
      reason: 'Photograph location ID 99 not found in catalog'
    })
    expect(mockThumb.getOriginalPhoto).not.toHaveBeenCalled()
  })

  it('returns Zod-validated missing result when resolveReadableFileLocation cannot find the file', async () => {
    const mockCatalog = {
      getFileLocationById: vi.fn(() => ({
        id: 5,
        sourceId: 1,
        category: 'photo',
        originalPath: 'C:\\Missing\\photo.jpg'
      })),
      getLocationReadResolutionContext: vi.fn(() => undefined)
    } as unknown as CatalogDatabase
    const mockThumb = {
      getOriginalPhoto: vi.fn(),
      getCachedPreviewForOriginal: vi.fn().mockResolvedValue(null)
    } as unknown as ThumbnailCoordinator

    registerIpcHandlers({
      validateSender,
      catalog: mockCatalog,
      thumbnailCoordinator: mockThumb
    })

    const res = await invoke(IPC_CHANNELS.PHOTOS_GET_ORIGINAL, trusted, { locationId: 5 })
    expect(OriginalPhotoResultSchema.safeParse(res).success).toBe(true)
    expect((res as { status: string }).status).toBe('missing')
    expect(mockThumb.getOriginalPhoto).not.toHaveBeenCalled()
  })

  it('serves cached preview with explanation when original and vault copy are unavailable', async () => {
    const mockCatalog = {
      getFileLocationById: vi.fn(() => ({
        id: 6,
        sourceId: 1,
        category: 'photo',
        originalPath: 'C:\\Offline\\photo.jpg',
        byteSize: 4096,
        filesystemMtimeMs: 1700000000000,
        activeHash: 'a'.repeat(64)
      })),
      getLocationReadResolutionContext: vi.fn(() => undefined)
    } as unknown as CatalogDatabase
    const mockThumb = {
      getOriginalPhoto: vi.fn(),
      getCachedPreviewForOriginal: vi.fn().mockResolvedValue({
        dataUrl: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=',
        mimeType: 'image/webp',
        width: 512,
        height: 384
      })
    } as unknown as ThumbnailCoordinator

    registerIpcHandlers({
      validateSender,
      catalog: mockCatalog,
      thumbnailCoordinator: mockThumb
    })

    const res = OriginalPhotoResultSchema.parse(
      await invoke(IPC_CHANNELS.PHOTOS_GET_ORIGINAL, trusted, { locationId: 6 })
    )
    expect(res.status).toBe('ready')
    if (res.status === 'ready') {
      expect(res.sourceKind).toBe('cached_preview')
      expect(res.notice).toMatch(/original file is currently unavailable/i)
    }
  })

  it('prefers verified vault copy for thumbnails and full-size viewing when online and offline, while keeping scanned-only offline warning', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'pv-thumb-vault-ipc-'))
    const sourceDir = join(workDir, 'sources')
    const vaultDir = join(workDir, 'vault')
    const cacheDir = join(workDir, 'thumbnails')
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })

    const importedBytes = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 20, g: 110, b: 220 } }
    })
      .jpeg()
      .toBuffer()
    const scannedBytes = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 80, b: 40 } }
    })
      .jpeg()
      .toBuffer()

    const importedPath = join(sourceDir, 'imported.jpg')
    const scannedPath = join(sourceDir, 'scanned.jpg')
    writeFileSync(importedPath, importedBytes)
    writeFileSync(scannedPath, scannedBytes)

    const importedSha = createHash('sha256').update(importedBytes).digest('hex').toLowerCase()
    const scannedSha = createHash('sha256').update(scannedBytes).digest('hex').toLowerCase()
    const importedSt = statSync(importedPath)
    const scannedSt = statSync(scannedPath)

    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'IPC Vault' })
    const catalog = CatalogDatabase.open({ catalogPath: join(workDir, 'catalog.db') })
    const thumbCoord = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: () => catalog.getAllSourceRoots(),
      vaultPath: () => catalog.getActiveVault()?.vaultPath ?? null,
      maxActiveJobs: 2,
      jobTimeoutMs: 5000
    })

    try {
      catalog.registerSource(sourceDir)
      catalog.persistDiscoveryBatch(sourceDir, [
        {
          originalPath: importedPath,
          fileName: 'imported.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: importedBytes.length,
          birthtimeMs: Math.round(importedSt.birthtimeMs),
          mtimeMs: Math.round(importedSt.mtimeMs),
          discoveredAtMs: Date.now()
        },
        {
          originalPath: scannedPath,
          fileName: 'scanned.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: scannedBytes.length,
          birthtimeMs: Math.round(scannedSt.birthtimeMs),
          mtimeMs: Math.round(scannedSt.mtimeMs),
          discoveredAtMs: Date.now()
        }
      ])
      catalog.recordHashObservation({
        originalPath: importedPath,
        sha256: importedSha,
        observedByteSize: importedBytes.length,
        observedMtimeMs: Math.round(importedSt.mtimeMs),
        hashedAtMs: Date.now()
      })
      catalog.recordHashObservation({
        originalPath: scannedPath,
        sha256: scannedSha,
        observedByteSize: scannedBytes.length,
        observedMtimeMs: Math.round(scannedSt.mtimeMs),
        hashedAtMs: Date.now()
      })
      catalog.registerVault({
        vaultId: identity.vaultId,
        vaultPath: vaultDir,
        name: identity.vaultName,
        createdAtMs: identity.createdAtMs
      })
      catalog.setActiveVault(vaultDir)

      const relPayload = `files/${importedSha.slice(0, 2)}/${importedSha}/imported.jpg`
      mkdirSync(join(vaultDir, 'files', importedSha.slice(0, 2), importedSha), { recursive: true })
      writeFileSync(join(vaultDir, relPayload), importedBytes)
      catalog.recordVaultCopy({
        vaultId: identity.vaultId,
        sha256: importedSha,
        byteSize: importedBytes.length,
        relativePath: relPayload,
        manifestRelativePath: `manifests/${importedSha.slice(0, 2)}/${importedSha}.json`,
        verifiedAtMs: Date.now()
      })

      const importedLoc = catalog.getFileLocationByPath(importedPath)!
      const scannedLoc = catalog.getFileLocationByPath(scannedPath)!

      registerIpcHandlers({
        validateSender,
        catalog,
        thumbnailCoordinator: thumbCoord
      })

      // 1. With sources online: imported item opens from verified vault copy without unavailable wording
      const onlineOrig = OriginalPhotoResultSchema.parse(
        await invoke(IPC_CHANNELS.PHOTOS_GET_ORIGINAL, trusted, { locationId: importedLoc.id })
      )
      expect(onlineOrig.status).toBe('ready')
      if (onlineOrig.status === 'ready') {
        expect(onlineOrig.sourceKind).toBe('vault_copy')
        expect(onlineOrig.notice).toBe('Showing your verified vault copy.')
      }

      const onlineThumb = ThumbnailResultSchema.parse(
        await invoke(IPC_CHANNELS.PHOTOS_GET_THUMBNAIL, trusted, { locationId: importedLoc.id })
      )
      expect(onlineThumb.status).toBe('ready')
      if (onlineThumb.status === 'ready') {
        expect(onlineThumb.originalUnavailable).not.toBe(true)
      }

      // Warm scanned-only thumbnail too before unplugging
      const scannedWarm = ThumbnailResultSchema.parse(
        await invoke(IPC_CHANNELS.PHOTOS_GET_THUMBNAIL, trusted, { locationId: scannedLoc.id })
      )
      expect(scannedWarm.status).toBe('ready')

      // 2. Remove both originals from disk -> imported photo STILL renders cleanly with no originalUnavailable badge
      unlinkSync(importedPath)
      unlinkSync(scannedPath)

      const offlineThumbImported = ThumbnailResultSchema.parse(
        await invoke(IPC_CHANNELS.PHOTOS_GET_THUMBNAIL, trusted, { locationId: importedLoc.id })
      )
      expect(offlineThumbImported.status).toBe('ready')
      if (offlineThumbImported.status === 'ready') {
        expect(offlineThumbImported.originalUnavailable).not.toBe(true)
      }

      const offlineOrigImported = OriginalPhotoResultSchema.parse(
        await invoke(IPC_CHANNELS.PHOTOS_GET_ORIGINAL, trusted, { locationId: importedLoc.id })
      )
      expect(offlineOrigImported.status).toBe('ready')
      if (offlineOrigImported.status === 'ready') {
        expect(offlineOrigImported.sourceKind).toBe('vault_copy')
        expect(offlineOrigImported.notice).toBe(
          'Showing your verified vault copy (original source file is currently unavailable).'
        )
      }

      // Scanned-only offline item honestly reports originalUnavailable on its cached thumbnail
      const offlineThumbScanned = ThumbnailResultSchema.parse(
        await invoke(IPC_CHANNELS.PHOTOS_GET_THUMBNAIL, trusted, { locationId: scannedLoc.id })
      )
      expect(offlineThumbScanned.status).toBe('ready')
      if (offlineThumbScanned.status === 'ready') {
        expect(offlineThumbScanned.originalUnavailable).toBe(true)
      }
    } finally {
      await thumbCoord.shutdown()
      catalog.close()
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})
