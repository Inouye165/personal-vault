// @vitest-environment node

import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { recoverCatalogFromVaultManifests } from '../../src/main/services/backup/catalog-recovery'
import { resolveReadableFileLocation } from '../../src/main/services/backup/recovered-file-resolver'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { DocumentExtractionCoordinator } from '../../src/main/services/documents/coordinator'
import { ThumbnailDiskCache } from '../../src/main/services/thumbnails/cache'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import { VaultImportCoordinator } from '../../src/main/services/vault/coordinator'
import { initializeVault } from '../../src/main/services/vault/identity'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').toLowerCase()
}

async function waitForExtractionDone(docCoord: DocumentExtractionCoordinator) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const p = docCoord.getProgress()
    if (p.status === 'completed' || p.status === 'failed' || p.status === 'cancelled') {
      return p
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(
    `Document extraction did not finish within 10s (status=${docCoord.getProgress().status})`
  )
}

function writeVaultEntry(params: {
  vaultDir: string
  vaultId: string
  payload: Buffer
  fileName: string
  extension: string
  category: 'photo' | 'document'
  originalPath: string
}): { sha256: string; payloadPath: string; manifestPath: string } {
  const sha = sha256Hex(params.payload)
  const prefix = sha.slice(0, 2)
  const contentDir = join(params.vaultDir, 'files', prefix, sha)
  mkdirSync(contentDir, { recursive: true })

  const relPayload = `files/${prefix}/${sha}/${params.fileName}`
  const payloadPath = join(contentDir, params.fileName)
  writeFileSync(payloadPath, params.payload)

  const manifest = {
    formatVersion: 1 as const,
    vaultId: params.vaultId,
    sha256: sha,
    byteSize: params.payload.length,
    managedCopy: {
      relativePath: relPayload,
      fileName: params.fileName,
      publishedAtMs: 1_700_000_001_000,
      verifiedSha256: sha,
      verifiedByteSize: params.payload.length
    },
    sources: [
      {
        fileLocationId: 1,
        originalPath: params.originalPath,
        fileName: params.fileName,
        extension: params.extension,
        category: params.category,
        recordedFacts: {
          byteSize: params.payload.length,
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: 1_700_000_000_500,
          firstDiscoveredAtMs: 1_700_000_000_800,
          lastSeenAtMs: 1_700_000_000_900,
          discoveryObservationId: 100,
          hashObservationId: 200,
          hashVerifiedAtMs: 1_700_000_000_950
        },
        inferredMetadata: {
          inferredCaptureTimeMs: null
        },
        reviewDecisions: {
          isPreferred: false,
          duplicateReviewStatus: null
        },
        importResult: {
          importJobId: 'import-job-1',
          importedAtMs: 1_700_000_001_000,
          verifiedSourceSha256: sha,
          verifiedSourceByteSize: params.payload.length,
          sourceStability: {
            preCopyMtimeMs: 1_700_000_000_500,
            postCopyMtimeMs: 1_700_000_000_500,
            preCopyByteSize: params.payload.length,
            postCopyByteSize: params.payload.length
          }
        }
      }
    ]
  }

  const manifestPath = join(contentDir, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return { sha256: sha, payloadPath, manifestPath }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Stage 8B Slice 2: Read-Only Access to Recovered Photos & Documents', () => {
  it('opens recovered photos and documents from the read-only vault with originals unavailable, preserves provenance, and leaves vault untouched', async () => {
    const root = makeTempDir('pv-rec-read-')
    const vaultDir = join(root, 'surviving-vault')
    const targetProfileDir = join(root, 'recovered-profile')
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Read-Only Vault' })

    const jpegBytes = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 40, g: 120, b: 200 } }
    })
      .jpeg()
      .toBuffer()

    const docBytes = Buffer.from('Recovered vault document text: quarterly ledger 2026.')

    const missingPhotoOriginal = join(root, 'gone-originals', 'photo.jpg')
    const existingDecoyDocOriginal = join(root, 'still-here-originals', 'note.txt')
    mkdirSync(join(root, 'still-here-originals'), { recursive: true })
    writeFileSync(existingDecoyDocOriginal, 'DECOY CONTENT ON DISK — MUST NOT BE READ')

    const photoEntry = writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: jpegBytes,
      fileName: 'photo.jpg',
      extension: '.jpg',
      category: 'photo',
      originalPath: missingPhotoOriginal
    })

    const docEntry = writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: docBytes,
      fileName: 'note.txt',
      extension: '.txt',
      category: 'document',
      originalPath: existingDecoyDocOriginal
    })

    const photoMtimeBefore = statSync(photoEntry.payloadPath).mtimeMs
    const docMtimeBefore = statSync(docEntry.payloadPath).mtimeMs

    const report = await recoverCatalogFromVaultManifests({
      sourceVaultDir: vaultDir,
      targetProfileDir
    })

    const catalog = CatalogDatabase.open({ catalogPath: report.catalogPath })
    const thumbCoord = new ThumbnailCoordinator({
      cacheDir: join(targetProfileDir, 'thumbnails'),
      approvedRoots: () => catalog.getAllSourceRoots(),
      vaultPath: () => catalog.getActiveVault()?.vaultPath ?? null
    })
    await thumbCoord.initialize()

    const docCoord = new DocumentExtractionCoordinator({ catalog })
    docCoord.initialize()

    try {
      // Recovery-generated sources stay out of scan authorization
      expect(catalog.getAllSourceRoots()).toEqual([])

      const rawDb = (catalog as unknown as { db: import('node:sqlite').DatabaseSync }).db
      const photoRow = rawDb
        .prepare("SELECT id, original_path FROM file_locations WHERE category = 'photo';")
        .get() as { id: number; original_path: string }
      const docRow = rawDb
        .prepare("SELECT id, original_path FROM file_locations WHERE category = 'document';")
        .get() as { id: number; original_path: string }

      expect(photoRow.original_path).toBe(missingPhotoOriginal)
      expect(docRow.original_path).toBe(existingDecoyDocOriginal)

      // 1. Photo thumbnail reads from vault copy even with original missing
      const resolvedPhoto = resolveReadableFileLocation(catalog, photoRow.id)
      expect(resolvedPhoto.ok).toBe(true)
      if (!resolvedPhoto.ok) throw new Error(resolvedPhoto.errorMessage)
      expect(resolvedPhoto.mode).toBe('vault_copy')
      expect(resolvedPhoto.originalPath).toBe(missingPhotoOriginal)

      const thumbRes = await thumbCoord.requestThumbnail({
        locationId: photoRow.id,
        sourcePath: resolvedPhoto.filePath,
        expectedByteSize: resolvedPhoto.expectedByteSize,
        expectedMtimeMs: resolvedPhoto.expectedMtimeMs,
        expectedSha256: resolvedPhoto.expectedSha256,
        approvedRootsOverride: resolvedPhoto.approvedRoots
      })
      expect(thumbRes.status).toBe('ready')

      // 2. Document extraction reads from vault copy EVEN THOUGH original_path exists with decoy bytes
      const resolvedDoc = resolveReadableFileLocation(catalog, docRow.id)
      expect(resolvedDoc.ok).toBe(true)
      if (!resolvedDoc.ok) throw new Error(resolvedDoc.errorMessage)
      expect(resolvedDoc.mode).toBe('vault_copy')
      expect(resolvedDoc.originalPath).toBe(existingDecoyDocOriginal)

      await docCoord.startExtraction({ scope: 'all' })
      const extractProgress = await waitForExtractionDone(docCoord)
      expect(extractProgress.processedDocuments).toBe(1)
      expect(extractProgress.extractedDocuments).toBe(1)

      const preview = catalog.getDocumentRepository().getDocumentPreview(docRow.id)
      expect(preview).not.toBeNull()
      expect(preview!.extractedText).toContain(
        'Recovered vault document text: quarterly ledger 2026.'
      )
      expect(catalog.getFileLocationById(docRow.id)?.originalPath).toBe(existingDecoyDocOriginal)

      // Surviving vault remains 100% bitwise untouched
      expect(readFileSync(photoEntry.payloadPath)).toEqual(jpegBytes)
      expect(statSync(photoEntry.payloadPath).mtimeMs).toBe(photoMtimeBefore)
      expect(readFileSync(docEntry.payloadPath)).toEqual(docBytes)
      expect(statSync(docEntry.payloadPath).mtimeMs).toBe(docMtimeBefore)
    } finally {
      await thumbCoord.shutdown()
      await docCoord.shutdown()
      catalog.close()
    }
  })

  it('fails closed on missing or altered vault copy without falling back to original_path', async () => {
    const root = makeTempDir('pv-rec-fault-read-')
    const vaultDir = join(root, 'vault')
    const targetProfileDir = join(root, 'recovered')
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Fault Read Vault' })

    const origDoc = join(root, 'orig', 'secret.txt')
    mkdirSync(join(root, 'orig'), { recursive: true })
    writeFileSync(origDoc, 'ORIGINAL DISK CONTENT')

    const docBytes = Buffer.from('VERIFIED VAULT CONTENT')
    const docEntry = writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: docBytes,
      fileName: 'secret.txt',
      extension: '.txt',
      category: 'document',
      originalPath: origDoc
    })

    const report = await recoverCatalogFromVaultManifests({
      sourceVaultDir: vaultDir,
      targetProfileDir
    })

    const catalog = CatalogDatabase.open({ catalogPath: report.catalogPath })
    const docCoord = new DocumentExtractionCoordinator({ catalog })
    docCoord.initialize()

    try {
      const rawDb = (catalog as unknown as { db: import('node:sqlite').DatabaseSync }).db
      const docRow = rawDb
        .prepare("SELECT id FROM file_locations WHERE category = 'document';")
        .get() as { id: number }

      // 1. Alter vault copy -> fails closed with VAULT_COPY_CORRUPT and does NOT read origDoc
      writeFileSync(docEntry.payloadPath, Buffer.from('VERIFIED VAULT CONTENt'))
      const corruptRes = resolveReadableFileLocation(catalog, docRow.id)
      expect(corruptRes.ok).toBe(false)
      if (corruptRes.ok) throw new Error('Expected failure')
      expect(corruptRes.errorCode).toBe('VAULT_COPY_CORRUPT')

      await docCoord.startExtraction({ scope: 'all' })
      const failedProgress = await waitForExtractionDone(docCoord)
      expect(failedProgress.failedDocuments).toBe(1)
      expect(failedProgress.extractedDocuments).toBe(0)

      // 2. Delete vault copy -> fails closed with VAULT_COPY_MISSING
      rmSync(docEntry.payloadPath)
      const missingRes = resolveReadableFileLocation(catalog, docRow.id)
      expect(missingRes.ok).toBe(false)
      if (missingRes.ok) throw new Error('Expected failure')
      expect(missingRes.errorCode).toBe('VAULT_COPY_MISSING')
    } finally {
      await docCoord.shutdown()
      catalog.close()
    }
  })

  it('keeps ordinary user-source profiles opening files from original_path as before', async () => {
    const root = makeTempDir('pv-ord-read-')
    const sourceDir = join(root, 'user-source')
    mkdirSync(sourceDir, { recursive: true })

    const docPath = join(sourceDir, 'ordinary.txt')
    const docBytes = Buffer.from('Ordinary user source document content.')
    writeFileSync(docPath, docBytes)
    const st = statSync(docPath)

    const catalog = CatalogDatabase.open({ catalogPath: join(root, 'vault-catalog.db') })
    const docCoord = new DocumentExtractionCoordinator({ catalog })
    docCoord.initialize()

    try {
      catalog.registerSource(sourceDir)
      expect(catalog.getAllSourceRoots()).toEqual([sourceDir])

      catalog.persistDiscoveryBatch(sourceDir, [
        {
          originalPath: docPath,
          fileName: 'ordinary.txt',
          extension: '.txt',
          category: 'document',
          byteSize: docBytes.length,
          birthtimeMs: st.birthtimeMs,
          mtimeMs: st.mtimeMs,
          discoveredAtMs: Date.now()
        }
      ])

      const rawDb = (catalog as unknown as { db: import('node:sqlite').DatabaseSync }).db
      const locRow = rawDb.prepare('SELECT id FROM file_locations LIMIT 1;').get() as { id: number }

      const resolved = resolveReadableFileLocation(catalog, locRow.id)
      expect(resolved.ok).toBe(true)
      if (!resolved.ok) throw new Error(resolved.errorMessage)
      expect(resolved.mode).toBe('source')
      expect(resolved.filePath).toBe(docPath)

      await docCoord.startExtraction({ scope: 'all' })
      const progress = await waitForExtractionDone(docCoord)
      expect(progress.extractedDocuments).toBe(1)
      const preview = catalog.getDocumentRepository().getDocumentPreview(locRow.id)
      expect(preview?.extractedText).toContain('Ordinary user source document content.')
    } finally {
      await docCoord.shutdown()
      catalog.close()
    }
  })

  it('preserves read-only binding when the recovered vault is re-registered or re-initialized and keeps vault files unchanged', async () => {
    const root = makeTempDir('pv-rec-rereg-')
    const vaultDir = join(root, 'surviving-vault')
    const targetProfileDir = join(root, 'recovered-profile')
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Reregister Vault' })

    const docBytes = Buffer.from('Reregister vault document bytes')
    const docEntry = writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: docBytes,
      fileName: 'doc.txt',
      extension: '.txt',
      category: 'document',
      originalPath: join(root, 'orig', 'doc.txt')
    })

    const vaultJsonPath = join(vaultDir, 'vault.json')
    const vaultJsonBefore = readFileSync(vaultJsonPath)
    const vaultJsonMtimeBefore = statSync(vaultJsonPath).mtimeMs
    const payloadMtimeBefore = statSync(docEntry.payloadPath).mtimeMs

    const report = await recoverCatalogFromVaultManifests({
      sourceVaultDir: vaultDir,
      targetProfileDir
    })

    const catalog = CatalogDatabase.open({ catalogPath: report.catalogPath })
    try {
      const reInitIdentity = initializeVault({ vaultPath: vaultDir, vaultName: 'Attempt Rename' })
      catalog.registerVault({
        vaultId: reInitIdentity.vaultId,
        vaultPath: vaultDir,
        name: reInitIdentity.vaultName,
        createdAtMs: reInitIdentity.createdAtMs
      })
      catalog.setActiveVault(vaultDir)

      const active = catalog.getActiveVault()
      expect(active).not.toBeNull()
      expect(active!.isReadOnly).toBe(true)

      const rawDb = (catalog as unknown as { db: import('node:sqlite').DatabaseSync }).db
      const loc = rawDb.prepare('SELECT id FROM file_locations LIMIT 1;').get() as { id: number }

      const importCoord = new VaultImportCoordinator({ catalog })
      await expect(
        importCoord.startImport({ vaultId: identity.vaultId, fileLocationIds: [loc.id] })
      ).rejects.toThrow(/read-only/i)

      expect(readFileSync(vaultJsonPath)).toEqual(vaultJsonBefore)
      expect(statSync(vaultJsonPath).mtimeMs).toBe(vaultJsonMtimeBefore)
      expect(readFileSync(docEntry.payloadPath)).toEqual(docBytes)
      expect(statSync(docEntry.payloadPath).mtimeMs).toBe(payloadMtimeBefore)
    } finally {
      catalog.close()
    }
  })

  it('verifies recovered vault payload off-main before serving a cached thumbnail when size and mtime are unchanged', async () => {
    const root = makeTempDir('pv-rec-cache-tamper-')
    const vaultDir = join(root, 'surviving-vault')
    const targetProfileDir = join(root, 'recovered-profile')
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Cache Tamper Vault' })

    const jpegBytes = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 20, g: 160, b: 90 } }
    })
      .jpeg()
      .toBuffer()

    // Put a decoy valid JPEG at original_path so fallback would succeed if attempted
    const origDir = join(root, 'orig')
    mkdirSync(origDir, { recursive: true })
    const origPath = join(origDir, 'photo.jpg')
    writeFileSync(origPath, jpegBytes)

    const photoEntry = writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: jpegBytes,
      fileName: 'photo.jpg',
      extension: '.jpg',
      category: 'photo',
      originalPath: origPath
    })

    const report = await recoverCatalogFromVaultManifests({
      sourceVaultDir: vaultDir,
      targetProfileDir
    })

    const catalog = CatalogDatabase.open({ catalogPath: report.catalogPath })
    const thumbCoord = new ThumbnailCoordinator({
      cacheDir: join(targetProfileDir, 'thumbnails'),
      approvedRoots: () => catalog.getAllSourceRoots(),
      vaultPath: () => catalog.getActiveVault()?.vaultPath ?? null
    })
    await thumbCoord.initialize()

    try {
      const rawDb = (catalog as unknown as { db: import('node:sqlite').DatabaseSync }).db
      const photoRow = rawDb
        .prepare("SELECT id FROM file_locations WHERE category = 'photo' LIMIT 1;")
        .get() as { id: number }

      // Pin an integer-second mtime before warming the cache so utimesSync after tampering
      // preserves the exact sub-millisecond timestamp on Windows and hits the exact same cache key.
      const initialStat = statSync(photoEntry.payloadPath)
      const pinnedTime = new Date(Math.floor(initialStat.mtimeMs / 1000) * 1000)
      utimesSync(photoEntry.payloadPath, pinnedTime, pinnedTime)

      // 1. Warm the thumbnail cache
      const firstResolved = resolveReadableFileLocation(catalog, photoRow.id, {
        verifyPayloadHash: false
      })
      expect(firstResolved.ok).toBe(true)
      if (!firstResolved.ok) throw new Error(firstResolved.errorMessage)

      const firstThumb = await thumbCoord.requestThumbnail({
        locationId: photoRow.id,
        sourcePath: firstResolved.filePath,
        expectedByteSize: firstResolved.expectedByteSize,
        expectedMtimeMs: firstResolved.expectedMtimeMs,
        expectedSha256: firstResolved.expectedSha256,
        approvedRootsOverride: firstResolved.approvedRoots,
        verifySourceBeforeCacheHit: true
      })
      expect(firstThumb.status).toBe('ready')

      const thumbCache = new ThumbnailDiskCache({
        cacheDir: join(targetProfileDir, 'thumbnails')
      })
      const firstCacheKey = thumbCache.computeCacheKey({
        locationId: photoRow.id,
        sourcePath: firstResolved.filePath,
        sha256: firstResolved.expectedSha256,
        byteSize: firstResolved.expectedByteSize,
        mtimeMs: firstResolved.expectedMtimeMs
      })
      expect(await thumbCache.get(firstCacheKey)).not.toBeNull()

      // 2. Flip 1 byte in the vault copy while preserving exact byte size and pinned mtime/atime
      const tampered = Buffer.from(jpegBytes)
      tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff
      expect(tampered.length).toBe(jpegBytes.length)
      writeFileSync(photoEntry.payloadPath, tampered)
      utimesSync(photoEntry.payloadPath, pinnedTime, pinnedTime)

      // 3. Next request hits identical cache key (size + mtime match) but MUST fail off-main SHA-256 check
      const secondResolved = resolveReadableFileLocation(catalog, photoRow.id, {
        verifyPayloadHash: false
      })
      expect(secondResolved.ok).toBe(true)
      if (!secondResolved.ok) throw new Error(secondResolved.errorMessage)

      expect(secondResolved.expectedByteSize).toBe(firstResolved.expectedByteSize)
      expect(secondResolved.expectedMtimeMs).toBe(firstResolved.expectedMtimeMs)
      expect(secondResolved.expectedSha256).toBe(firstResolved.expectedSha256)
      const secondCacheKey = thumbCache.computeCacheKey({
        locationId: photoRow.id,
        sourcePath: secondResolved.filePath,
        sha256: secondResolved.expectedSha256,
        byteSize: secondResolved.expectedByteSize,
        mtimeMs: secondResolved.expectedMtimeMs
      })
      expect(secondCacheKey).toBe(firstCacheKey)
      expect(await thumbCache.get(secondCacheKey)).not.toBeNull()

      const secondThumb = await thumbCoord.requestThumbnail({
        locationId: photoRow.id,
        sourcePath: secondResolved.filePath,
        expectedByteSize: secondResolved.expectedByteSize,
        expectedMtimeMs: secondResolved.expectedMtimeMs,
        expectedSha256: secondResolved.expectedSha256,
        approvedRootsOverride: secondResolved.approvedRoots,
        verifySourceBeforeCacheHit: true
      })
      expect(secondThumb.status).toBe('error')
      if (secondThumb.status === 'error') {
        expect(secondThumb.code).toBe('SOURCE_MODIFIED')
      }
      // Cache entry was exercised via validate_cache and evicted on source_invalid
      expect(await thumbCache.get(firstCacheKey)).toBeNull()
    } finally {
      await thumbCoord.shutdown()
      catalog.close()
    }
  })

  it('prefers verified vault copy for user-source files when preferVaultCopy is true, fails closed on corruption, and falls back to source when unimported', () => {
    const root = makeTempDir('pv-vault-first-res-')
    const sourceDir = join(root, 'sources')
    const vaultDir = join(root, 'vault')
    mkdirSync(sourceDir, { recursive: true })
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Vault First' })

    const importedBytes = Buffer.from('Imported photo verified payload bytes')
    const importedPath = join(sourceDir, 'imported.jpg')
    writeFileSync(importedPath, importedBytes)
    const importedStat = statSync(importedPath)
    const importedSha = sha256Hex(importedBytes)

    const scannedBytes = Buffer.from('Scanned only photo bytes')
    const scannedPath = join(sourceDir, 'scanned-only.jpg')
    writeFileSync(scannedPath, scannedBytes)
    const scannedStat = statSync(scannedPath)
    const scannedSha = sha256Hex(scannedBytes)

    const catalog = CatalogDatabase.open({ catalogPath: join(root, 'catalog.db') })
    try {
      catalog.registerSource(sourceDir)
      catalog.persistDiscoveryBatch(sourceDir, [
        {
          originalPath: importedPath,
          fileName: 'imported.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: importedBytes.length,
          birthtimeMs: Math.round(importedStat.birthtimeMs),
          mtimeMs: Math.round(importedStat.mtimeMs),
          discoveredAtMs: Date.now()
        },
        {
          originalPath: scannedPath,
          fileName: 'scanned-only.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: scannedBytes.length,
          birthtimeMs: Math.round(scannedStat.birthtimeMs),
          mtimeMs: Math.round(scannedStat.mtimeMs),
          discoveredAtMs: Date.now()
        }
      ])
      catalog.recordHashObservation({
        originalPath: importedPath,
        sha256: importedSha,
        observedByteSize: importedBytes.length,
        observedMtimeMs: Math.round(importedStat.mtimeMs),
        hashedAtMs: Date.now()
      })
      catalog.recordHashObservation({
        originalPath: scannedPath,
        sha256: scannedSha,
        observedByteSize: scannedBytes.length,
        observedMtimeMs: Math.round(scannedStat.mtimeMs),
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
      const payloadDir = join(vaultDir, 'files', importedSha.slice(0, 2), importedSha)
      mkdirSync(payloadDir, { recursive: true })
      const vaultPayloadPath = join(vaultDir, relPayload)
      writeFileSync(vaultPayloadPath, importedBytes)
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

      // Default (without preferVaultCopy) still resolves user-source to original path
      const defaultRes = resolveReadableFileLocation(catalog, importedLoc.id)
      expect(defaultRes.ok).toBe(true)
      if (defaultRes.ok) {
        expect(defaultRes.mode).toBe('source')
        expect(defaultRes.filePath).toBe(importedPath)
      }

      // With preferVaultCopy: true and original STILL online -> resolves to verified vault copy
      const vaultFirstRes = resolveReadableFileLocation(catalog, importedLoc.id, {
        preferVaultCopy: true
      })
      expect(vaultFirstRes.ok).toBe(true)
      if (vaultFirstRes.ok) {
        expect(vaultFirstRes.mode).toBe('vault_copy')
        expect(vaultFirstRes.filePath.toLowerCase()).toBe(vaultPayloadPath.toLowerCase())
        expect(vaultFirstRes.originalPath).toBe(importedPath)
      }

      // Scanned-only item with preferVaultCopy: true -> falls back cleanly to source originalPath
      const scannedRes = resolveReadableFileLocation(catalog, scannedLoc.id, {
        preferVaultCopy: true
      })
      expect(scannedRes.ok).toBe(true)
      if (scannedRes.ok) {
        expect(scannedRes.mode).toBe('source')
        expect(scannedRes.filePath).toBe(scannedPath)
      }

      // Tamper vault copy while original is still online -> preferVaultCopy MUST fail closed
      writeFileSync(vaultPayloadPath, Buffer.from('TAMPERED VAULT BYTES WITH DIFF LEN!!'))
      const corruptRes = resolveReadableFileLocation(catalog, importedLoc.id, {
        preferVaultCopy: true
      })
      expect(corruptRes.ok).toBe(false)
      if (!corruptRes.ok) {
        expect(corruptRes.errorCode).toBe('VAULT_COPY_CORRUPT')
      }
    } finally {
      catalog.close()
    }
  })
})
