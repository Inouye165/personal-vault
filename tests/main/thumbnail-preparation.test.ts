/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { CatalogDatabase } from '../../src/main/services/catalog'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import { ThumbnailPrepCoordinator } from '../../src/main/services/thumbnails/prep-coordinator'
import { VaultImportCoordinator } from '../../src/main/services/vault/coordinator'
import { initializeVault } from '../../src/main/services/vault/identity'

async function makeJpeg(
  width = 800,
  height = 600,
  color = { r: 40, g: 120, b: 200 }
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: color }
  })
    .jpeg({ quality: 85 })
    .toBuffer()
}

function seedPhoto(
  catalog: CatalogDatabase,
  sourceRoot: string,
  filePath: string,
  fileName: string,
  buf: Buffer
): number {
  writeFileSync(filePath, buf)
  const st = statSync(filePath)
  const sha256 = createHash('sha256').update(buf).digest('hex')
  catalog.persistDiscoveryBatch(sourceRoot, [
    {
      originalPath: filePath,
      fileName,
      extension: fileName.slice(fileName.lastIndexOf('.')).toLowerCase(),
      byteSize: st.size,
      birthtimeMs: Math.round(st.birthtimeMs),
      mtimeMs: Math.round(st.mtimeMs),
      discoveredAtMs: Date.now(),
      category: 'photo'
    }
  ])
  const hashObs = catalog.recordHashObservation({
    originalPath: filePath,
    sha256,
    observedByteSize: st.size,
    observedMtimeMs: Math.round(st.mtimeMs),
    hashedAtMs: Date.now()
  })
  return hashObs.fileLocationId
}

describe('Thumbnail Coalescing, Unavailable Originals & Background Preparation', () => {
  let tempDir: string
  let sourceRoot: string
  let cacheDir: string
  let catalogPath: string
  let catalog: CatalogDatabase
  let coordinator: ThumbnailCoordinator

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-thumb-prep-test-'))
    sourceRoot = join(tempDir, 'sources')
    cacheDir = join(tempDir, 'thumbnails')
    catalogPath = join(tempDir, 'catalog.db')
    mkdirSync(sourceRoot, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
    catalog = CatalogDatabase.open({ catalogPath })
    coordinator = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: () => catalog.getAllSourceRoots(),
      vaultPath: () => catalog.getActiveVault()?.vaultPath ?? null,
      maxActiveJobs: 2,
      maxQueuedJobs: 64,
      jobTimeoutMs: 5000
    })
  })

  afterEach(async () => {
    await coordinator.shutdown()
    if (!catalog.isClosed()) {
      catalog.close()
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('coalesces duplicate thumbnail requests and protects background work from UI scroll cancellation', async () => {
    const imgBuf = await makeJpeg(900, 600, { r: 200, g: 80, b: 40 })
    const imgPath = join(sourceRoot, 'yellowstone_coalesce.jpg')
    const locId = seedPhoto(catalog, sourceRoot, imgPath, 'yellowstone_coalesce.jpg', imgBuf)
    const loc = catalog.getFileLocationById(locId)!

    const beforeDiag = coordinator.getDiagnostics()

    const bgPromise = coordinator.requestThumbnail({
      locationId: loc.id,
      sourcePath: loc.originalPath,
      expectedByteSize: loc.byteSize,
      expectedMtimeMs: loc.filesystemMtimeMs,
      expectedSha256: loc.activeHash,
      priority: 'low',
      consumerType: 'background'
    })

    const uiPromise = coordinator.requestThumbnail({
      locationId: loc.id,
      sourcePath: loc.originalPath,
      expectedByteSize: loc.byteSize,
      expectedMtimeMs: loc.filesystemMtimeMs,
      expectedSha256: loc.activeHash,
      priority: 'high',
      consumerType: 'ui'
    })

    // Simulate scrolling away in UI while background pass still needs the thumbnail
    const cancelledUi = coordinator.cancelRequest(loc.id, {
      queuedOnly: true,
      consumerType: 'ui'
    })
    expect(cancelledUi).toBe(true)

    const [uiRes, bgRes] = await Promise.all([uiPromise, bgPromise])
    expect(uiRes.status).toBe('error')
    if (uiRes.status === 'error') {
      expect(uiRes.code).toBe('CANCELLED')
    }
    expect(bgRes.status).toBe('ready')

    const afterDiag = coordinator.getDiagnostics()
    expect(afterDiag.totalDecodes - beforeDiag.totalDecodes).toBe(1)
  })

  it('serves authorized cached preview with originalUnavailable=true when source is unplugged, while still rejecting modified or removed sources', async () => {
    const imgBuf = await makeJpeg(800, 600, { r: 10, g: 140, b: 90 })
    const imgPath = join(sourceRoot, 'yellowstone_offline.jpg')
    const locId = seedPhoto(catalog, sourceRoot, imgPath, 'yellowstone_offline.jpg', imgBuf)
    const loc = catalog.getFileLocationById(locId)!

    // Warm cache while source is online
    const warmRes = await coordinator.requestThumbnail({
      locationId: loc.id,
      sourcePath: loc.originalPath,
      expectedByteSize: loc.byteSize,
      expectedMtimeMs: loc.filesystemMtimeMs,
      expectedSha256: loc.activeHash,
      priority: 'high'
    })
    expect(warmRes.status).toBe('ready')

    // 1. Unplug / remove original source file on disk while catalog entry remains authorized
    unlinkSync(imgPath)
    const offlineRes = await coordinator.requestThumbnail({
      locationId: loc.id,
      sourcePath: loc.originalPath,
      expectedByteSize: loc.byteSize,
      expectedMtimeMs: loc.filesystemMtimeMs,
      expectedSha256: loc.activeHash,
      priority: 'high'
    })
    expect(offlineRes.status).toBe('ready')
    if (offlineRes.status === 'ready') {
      expect(offlineRes.originalUnavailable).toBe(true)
    }

    // 2. Restore modified file (tampered size/bytes) -> MUST reject as SOURCE_MODIFIED, not serve cached preview
    writeFileSync(imgPath, Buffer.concat([imgBuf, Buffer.from('TAMPERED')]))
    const modifiedRes = await coordinator.requestThumbnail({
      locationId: loc.id,
      sourcePath: loc.originalPath,
      expectedByteSize: loc.byteSize,
      expectedMtimeMs: loc.filesystemMtimeMs,
      expectedSha256: loc.activeHash,
      priority: 'high'
    })
    expect(modifiedRes.status).toBe('error')
    if (modifiedRes.status === 'error') {
      expect(modifiedRes.code).toBe('SOURCE_MODIFIED')
    }
  })

  it('prepares existing cataloged photos in background, reuses valid cache across restarts, and skips unavailable/unsupported files without retry loops', async () => {
    const jpg1 = await makeJpeg(700, 500, { r: 255, g: 100, b: 50 })
    const jpg2 = await makeJpeg(700, 500, { r: 50, g: 100, b: 255 })
    const id1 = seedPhoto(catalog, sourceRoot, join(sourceRoot, 'a.jpg'), 'a.jpg', jpg1)
    seedPhoto(catalog, sourceRoot, join(sourceRoot, 'b.jpg'), 'b.jpg', jpg2)
    const rawBuf = Buffer.from('II*\0\x10\0\0\0CR\x02\0', 'latin1')
    seedPhoto(catalog, sourceRoot, join(sourceRoot, 'c.cr2'), 'c.cr2', rawBuf)
    seedPhoto(catalog, sourceRoot, join(sourceRoot, 'd.jpg'), 'd.jpg', jpg1)
    unlinkSync(join(sourceRoot, 'd.jpg'))

    // Pre-warm id1 so background pass must reuse it without re-decoding
    const loc1 = catalog.getFileLocationById(id1)!
    await coordinator.requestThumbnail({
      locationId: loc1.id,
      sourcePath: loc1.originalPath,
      expectedByteSize: loc1.byteSize,
      expectedMtimeMs: loc1.filesystemMtimeMs,
      expectedSha256: loc1.activeHash
    })
    const decodesBeforePrep = coordinator.getDiagnostics().totalDecodes

    const prep = new ThumbnailPrepCoordinator({
      catalog,
      thumbnailCoordinator: coordinator,
      startupDelayMs: 0
    })
    prep.initialize()
    const progress = await prep.waitForCompletion()

    expect(progress.status).toBe('completed')
    expect(progress.totalPhotos).toBe(4)
    expect(progress.preparedPhotos).toBe(2) // id1 (reused) + id2 (decoded)
    expect(progress.unsupportedPhotos).toBe(1) // idRaw
    expect(progress.unavailablePhotos).toBe(1) // idMissing
    expect(progress.pendingPhotos).toBe(0)
    // id1 was reused from disk cache without decoding, and idMissing was skipped without worker dispatch (only id2 + idRaw entered worker)
    expect(coordinator.getDiagnostics().totalDecodes - decodesBeforePrep).toBe(2)
    await prep.shutdown()

    // Restart coordinator & prep on same catalog + disk cache -> 0 new decodes, 0 retries of unavailable/unsupported
    await coordinator.shutdown()
    coordinator = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: () => catalog.getAllSourceRoots(),
      vaultPath: () => catalog.getActiveVault()?.vaultPath ?? null,
      maxActiveJobs: 2,
      maxQueuedJobs: 64,
      jobTimeoutMs: 5000
    })
    const prep2 = new ThumbnailPrepCoordinator({
      catalog,
      thumbnailCoordinator: coordinator,
      startupDelayMs: 0
    })
    prep2.initialize()
    const progress2 = await prep2.waitForCompletion()
    expect(progress2.status).toBe('completed')
    expect(progress2.preparedPhotos).toBe(2)
    expect(progress2.unsupportedPhotos).toBe(1)
    expect(progress2.unavailablePhotos).toBe(1)
    expect(coordinator.getDiagnostics().totalDecodes).toBe(0)
    await prep2.shutdown()
  })

  it('automatically prepares newly scanned and vault-imported photos via coordinator hooks and regenerates evicted disk cache entries', async () => {
    const prep = new ThumbnailPrepCoordinator({
      catalog,
      thumbnailCoordinator: coordinator,
      startupDelayMs: 60000,
      scanSettleDelayMs: 0
    })

    const jpgNew = await makeJpeg(600, 450, { r: 30, g: 200, b: 120 })
    const newId = seedPhoto(
      catalog,
      sourceRoot,
      join(sourceRoot, 'new_scan.jpg'),
      'new_scan.jpg',
      jpgNew
    )

    // Simulate scan completion event
    prep.onScanProgress({ jobId: 1, status: 'completed', phase: 'completed', hashedCount: 1 })
    const scanProg = await prep.waitForCompletion()
    expect(scanProg.status).toBe('completed')
    expect(scanProg.preparedPhotos).toBe(1)

    const locNew = catalog.getFileLocationById(newId)!
    const cacheKey = coordinator.getCache().computeCacheKey({
      locationId: locNew.id,
      sourcePath: locNew.originalPath,
      sha256: locNew.activeHash,
      byteSize: locNew.byteSize,
      mtimeMs: locNew.filesystemMtimeMs
    })
    expect(coordinator.getCache().has(cacheKey)).toBe(true)

    // Simulate disk cache eviction of that .thumb file and trigger via vault import completion
    coordinator.getCache().delete(cacheKey)
    expect(coordinator.getCache().has(cacheKey)).toBe(false)

    prep.onVaultImportProgress({ status: 'completed' })
    const importProg = await prep.waitForCompletion()
    expect(importProg.status).toBe('completed')
    expect(importProg.preparedPhotos).toBe(1)
    expect(coordinator.getCache().has(cacheKey)).toBe(true)
    await prep.shutdown()
  })

  it('re-prepares newly vault-imported photos under the vault-copy cache key so thumbnails stay ready without originalUnavailable when originals disconnect', async () => {
    const prep = new ThumbnailPrepCoordinator({
      catalog,
      thumbnailCoordinator: coordinator,
      startupDelayMs: 60000,
      scanSettleDelayMs: 0
    })

    const vaultDir = join(tempDir, 'active-vault')
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Prep Vault' })
    catalog.registerSource(sourceRoot)
    catalog.registerVault({
      vaultId: identity.vaultId,
      vaultPath: vaultDir,
      name: identity.vaultName,
      createdAtMs: identity.createdAtMs
    })
    catalog.setActiveVault(vaultDir)

    const jpgBuf = await makeJpeg(640, 480, { r: 80, g: 150, b: 220 })
    const origPath = join(sourceRoot, 'vaulted_trip.jpg')
    const locId = seedPhoto(catalog, sourceRoot, origPath, 'vaulted_trip.jpg', jpgBuf)

    // 1. Scan completes before import -> background prep caches under source key
    prep.onScanProgress({ jobId: 1, status: 'completed', phase: 'completed', hashedCount: 1 })
    const scanProg = await prep.waitForCompletion()
    expect(scanProg.preparedPhotos).toBe(1)

    const locBeforeImport = catalog.getFileLocationById(locId)!
    const sourceCacheKey = coordinator.getCache().computeCacheKey({
      locationId: locBeforeImport.id,
      sourcePath: locBeforeImport.originalPath,
      sha256: locBeforeImport.activeHash,
      byteSize: locBeforeImport.byteSize,
      mtimeMs: locBeforeImport.filesystemMtimeMs
    })
    expect(coordinator.getCache().has(sourceCacheKey)).toBe(true)

    // 2. Verified import into vault
    const importCoord = new VaultImportCoordinator({ catalog })
    await importCoord.startImport({
      vaultId: identity.vaultId,
      fileLocationIds: [locId]
    })
    const completedJob = await importCoord.waitForCompletion()
    expect(completedJob.status).toBe('completed')

    // 3. Import completion triggers vault-first prep reconciliation -> switches cacheKey to vault copy
    prep.onVaultImportProgress({ status: 'completed' })
    const postImportProg = await prep.waitForCompletion()
    expect(postImportProg.status).toBe('completed')
    expect(postImportProg.preparedPhotos).toBe(1)

    const vaultCopy = catalog.getVaultCopy(
      identity.vaultId,
      locBeforeImport.activeHash!,
      locBeforeImport.byteSize
    )!
    const vaultFilePath = join(vaultDir, vaultCopy.relativePath)
    const vaultStat = statSync(vaultFilePath)
    const vaultCacheKey = coordinator.getCache().computeCacheKey({
      locationId: locId,
      sourcePath: vaultFilePath,
      sha256: vaultCopy.sha256,
      byteSize: vaultCopy.byteSize,
      mtimeMs: Number.isFinite(vaultStat.mtimeMs) ? vaultStat.mtimeMs : null
    })
    expect(vaultCacheKey).not.toBe(sourceCacheKey)
    expect(coordinator.getCache().has(vaultCacheKey)).toBe(true)

    // 4. Delete original source on disk -> vault-copy thumbnail request succeeds without originalUnavailable
    unlinkSync(origPath)
    const afterDisconnect = await coordinator.requestThumbnail({
      locationId: locId,
      sourcePath: vaultFilePath,
      expectedByteSize: vaultCopy.byteSize,
      expectedMtimeMs: Number.isFinite(vaultStat.mtimeMs) ? vaultStat.mtimeMs : null,
      expectedSha256: vaultCopy.sha256,
      approvedRootsOverride: [
        join(vaultDir, 'files', vaultCopy.sha256.slice(0, 2), vaultCopy.sha256)
      ],
      verifySourceBeforeCacheHit: true
    })
    expect(afterDisconnect.status).toBe('ready')
    if (afterDisconnect.status === 'ready') {
      expect(afterDisconnect.originalUnavailable).not.toBe(true)
    }
    await prep.shutdown()
  })
})
