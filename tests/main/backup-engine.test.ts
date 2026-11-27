// @vitest-environment node
/**
 * Personal Vault — Stage 8B Sub-slice 1A-2: Local Backup Engine, Transport,
 * Rate Limiter & Destination Containment Tests
 *
 * Covers:
 * - T1: Initial verified local backup & exact scope (4 MiB chunking, full_readback, exclusions).
 * - T3: Incremental backup & versioned recovery points (verified chunk reuse, prior points intact).
 * - T4: Interrupted/failed transfers leave prior verified backup usable; leftover chunk recovery.
 * - T6: NAS transfer-rate cap (injectable clock across writes, retries, verification reads, AbortSignal).
 * - T11-destination: Local & UNC NAS path containment, non-empty folder rejection, symlink/junction checks.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BACKUP_CHUNK_SIZE_BYTES,
  BackupRepositoryIdentityV1Schema,
  BackupSnapshotCompleteMarkerV1Schema,
  BackupSnapshotManifestV1Schema
} from '../../src/shared/validation/backup-schemas'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { initializeVault } from '../../src/main/services/vault/identity'
import { writeVaultManifest } from '../../src/main/services/vault/manifest'
import type { VaultManifest } from '../../src/main/services/vault/types'
import { BackupContainmentError, BackupSnapshotError } from '../../src/main/services/backup/errors'
import { validateBackupDestinationPath } from '../../src/main/services/backup/containment'
import { TransferRateLimiter } from '../../src/main/services/backup/rate-limiter'
import { inspectRecoveryPointStatus, runLocalBackup } from '../../src/main/services/backup/engine'

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

interface EngineFixture {
  rootDir: string
  userDataDir: string
  catalogPath: string
  annotationsDir: string
  sourceDir: string
  vaultDir: string
  backupDir: string
  catalog: CatalogDatabase
  journal: AnnotationJournal
  vaultId: string
  largeSha256: string
  largeBytes: Buffer
  unimportedSourceFile: string
}

async function createEngineFixture(): Promise<EngineFixture> {
  const rootDir = mkdtempSync(join(tmpdir(), 'pv-8b-1a2-'))
  const userDataDir = join(rootDir, 'userData')
  const catalogPath = join(userDataDir, 'vault-catalog.db')
  const annotationsDir = join(userDataDir, 'annotations')
  const sourceDir = join(rootDir, 'sources')
  const vaultDir = join(rootDir, 'vault')
  const backupDir = join(rootDir, 'backup-usb')

  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(backupDir, { recursive: true })

  // Disposable/excluded artifacts in userData & vault
  mkdirSync(join(userDataDir, 'thumbnails'), { recursive: true })
  writeFileSync(join(userDataDir, 'thumbnails', 'thumb.webp'), Buffer.from('thumb-bytes'))
  mkdirSync(join(userDataDir, 'semantic-models'), { recursive: true })
  writeFileSync(join(userDataDir, 'semantic-models', 'model.onnx'), Buffer.from('model-bytes'))

  // 4.5 MiB deterministic payload to exercise multi-chunk 4 MiB splitting
  const largeBytes = Buffer.alloc(4 * 1024 * 1024 + 512 * 1024, 0x42)
  largeBytes.write('PV-START', 0)
  largeBytes.write('PV-END', largeBytes.length - 6)
  const largeSha256 = sha256Hex(largeBytes)
  const importedSourceFile = join(sourceDir, 'big-photo.tif')
  writeFileSync(importedSourceFile, largeBytes)

  // Unimported cataloged original (must NEVER be backed up as file bytes)
  const unimportedBytes = Buffer.from('unimported-original-secret-bytes', 'utf8')
  const unimportedSourceFile = join(sourceDir, 'unimported-note.txt')
  writeFileSync(unimportedSourceFile, unimportedBytes)

  const journal = new AnnotationJournal({
    storageDir: annotationsDir,
    sourceRoots: () => [sourceDir],
    vaultPath: () => vaultDir
  })
  await journal.initialize()

  const catalog = CatalogDatabase.open({ catalogPath, journal })
  const now = Date.now()
  catalog.persistDiscoveryBatch(sourceDir, [
    {
      originalPath: importedSourceFile,
      fileName: 'big-photo.tif',
      extension: '.tif',
      category: 'photo',
      byteSize: largeBytes.length,
      birthtimeMs: now - 5000,
      mtimeMs: now - 5000,
      discoveredAtMs: now
    },
    {
      originalPath: unimportedSourceFile,
      fileName: 'unimported-note.txt',
      extension: '.txt',
      category: 'document',
      byteSize: unimportedBytes.length,
      birthtimeMs: now - 4000,
      mtimeMs: now - 4000,
      discoveredAtMs: now
    }
  ])

  const locs = catalog.queryFileLocations({ limit: 10 }).items
  const importedLoc = locs.find((l) => l.fileName === 'big-photo.tif')!
  catalog.recordHashObservationsBatch([
    {
      originalPath: importedSourceFile,
      sha256: largeSha256,
      observedByteSize: largeBytes.length,
      observedMtimeMs: importedLoc.filesystemMtimeMs,
      hashedAtMs: now
    }
  ])
  const hashObs = catalog.getHashObservationsForFile(importedLoc.id).items[0]!

  const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Backup Test Vault' })
  catalog.registerVault({
    vaultId: identity.vaultId,
    vaultPath: vaultDir,
    name: identity.vaultName,
    createdAtMs: identity.createdAtMs
  })

  const prefix = largeSha256.slice(0, 2)
  const payloadRel = `files/${prefix}/${largeSha256}/big-photo.tif`
  const manifestRel = `files/${prefix}/${largeSha256}/manifest.json`
  mkdirSync(join(vaultDir, 'files', prefix, largeSha256), { recursive: true })
  writeFileSync(join(vaultDir, payloadRel), largeBytes)

  const importJobId = randomUUID()
  const manifest: VaultManifest = {
    formatVersion: 1,
    vaultId: identity.vaultId,
    sha256: largeSha256,
    byteSize: largeBytes.length,
    managedCopy: {
      relativePath: payloadRel,
      fileName: 'big-photo.tif',
      publishedAtMs: now,
      verifiedSha256: largeSha256,
      verifiedByteSize: largeBytes.length
    },
    sources: [
      {
        fileLocationId: importedLoc.id,
        originalPath: importedSourceFile,
        fileName: 'big-photo.tif',
        extension: '.tif',
        category: 'photo',
        recordedFacts: {
          byteSize: largeBytes.length,
          filesystemBirthtimeMs: importedLoc.filesystemBirthtimeMs,
          filesystemMtimeMs: importedLoc.filesystemMtimeMs,
          firstDiscoveredAtMs: importedLoc.firstDiscoveredAtMs,
          lastSeenAtMs: importedLoc.lastSeenAtMs,
          discoveryObservationId: importedLoc.discoveryObservationId,
          hashObservationId: hashObs.id,
          hashVerifiedAtMs: hashObs.hashedAtMs
        },
        inferredMetadata: { inferredCaptureTimeMs: null },
        reviewDecisions: { isPreferred: false, duplicateReviewStatus: null },
        importResult: {
          importJobId,
          importedAtMs: now,
          verifiedSourceSha256: largeSha256,
          verifiedSourceByteSize: largeBytes.length,
          sourceStability: {
            preCopyMtimeMs: importedLoc.filesystemMtimeMs ?? 0,
            postCopyMtimeMs: importedLoc.filesystemMtimeMs ?? 0,
            preCopyByteSize: largeBytes.length,
            postCopyByteSize: largeBytes.length
          }
        }
      }
    ]
  }
  writeVaultManifest(vaultDir, manifest, importJobId)

  const copyRecord = catalog.recordVaultCopy({
    vaultId: identity.vaultId,
    sha256: largeSha256,
    byteSize: largeBytes.length,
    relativePath: payloadRel,
    manifestRelativePath: manifestRel,
    verifiedAtMs: now
  })
  catalog.createVaultImportJob({
    jobId: importJobId,
    vaultId: identity.vaultId,
    totalFiles: 1,
    totalBytes: largeBytes.length,
    items: [
      {
        fileLocationId: importedLoc.id,
        discoveryObservationId: importedLoc.discoveryObservationId,
        hashObservationId: hashObs.id,
        sha256: largeSha256,
        byteSize: largeBytes.length
      }
    ]
  })
  catalog.updateVaultImportItem({
    jobId: importJobId,
    fileLocationId: importedLoc.id,
    status: 'completed',
    vaultCopyId: copyRecord.id,
    completedAtMs: now
  })
  catalog.updateVaultImportStatus(importJobId, 'completed')

  catalog.setPhotoAnnotation({
    fileLocationId: importedLoc.id,
    expectedRevision: `rev:${importedLoc.discoveryObservationId}:${largeBytes.length}:${importedLoc.filesystemMtimeMs}:${largeSha256}`,
    expectedVersion: 0,
    rating: 4,
    flag: 'pick'
  })

  return {
    rootDir,
    userDataDir,
    catalogPath,
    annotationsDir,
    sourceDir,
    vaultDir,
    backupDir,
    catalog,
    journal,
    vaultId: identity.vaultId,
    largeSha256,
    largeBytes,
    unimportedSourceFile
  }
}

describe('Stage 8B Sub-slice 1A-2: Local Backup Engine, Transport & Rate Limiter', () => {
  let fixture: EngineFixture | null = null

  beforeEach(async () => {
    fixture = await createEngineFixture()
  })

  afterEach(() => {
    if (fixture) {
      if (!fixture.catalog.isClosed()) {
        fixture.catalog.close()
      }
      rmSync(fixture.rootDir, { recursive: true, force: true })
      fixture = null
    }
  })

  it('T1: creates verified initial local backup with 4 MiB chunks, read-back verification, and strict exclusions', async () => {
    const f = fixture!
    const res = await runLocalBackup({
      jobId: 'backup-1',
      snapshotId: 'snap-001',
      backupRepoDir: f.backupDir,
      catalogPath: f.catalogPath,
      annotationsDir: f.annotationsDir,
      userDataDir: f.userDataDir,
      sourceRoots: [f.sourceDir],
      vaultRoots: [f.vaultDir],
      appVersion: '0.1.0'
    })

    expect(res.verificationScope).toBe('full_readback')
    expect(res.writtenChunkCount).toBeGreaterThan(0)
    expect(res.reusedChunkCount).toBe(0)

    const repoIdentity = BackupRepositoryIdentityV1Schema.parse(
      JSON.parse(readFileSync(join(f.backupDir, 'repository.json'), 'utf8'))
    )
    expect(repoIdentity.chunkSizeBytes).toBe(BACKUP_CHUNK_SIZE_BYTES)
    expect(repoIdentity.encryptionMode).toBe('none')

    const snapDir = join(f.backupDir, 'snapshots', 'snap-001')
    expect(existsSync(join(snapDir, '.pv-snapshot-in-progress.json'))).toBe(false)
    expect(existsSync(join(f.backupDir, '.pv-backup-temp'))).toBe(false)
    expect(existsSync(join(f.userDataDir, '.backup-staging', 'backup-1'))).toBe(false)

    const manifest = BackupSnapshotManifestV1Schema.parse(
      JSON.parse(readFileSync(join(snapDir, 'snapshot.json'), 'utf8'))
    )
    expect(manifest.excludesUnimportedOriginals).toBe(true)
    expect(manifest.vault).not.toBeNull()
    expect(manifest.vault!.copies[0]!.payloadFile.chunks.length).toBe(2)

    const complete = BackupSnapshotCompleteMarkerV1Schema.parse(
      JSON.parse(readFileSync(join(snapDir, 'complete.json'), 'utf8'))
    )
    expect(complete.verificationScope).toBe('full_readback')

    const inspection = inspectRecoveryPointStatus(f.backupDir, 'snap-001')
    expect(inspection.isComplete).toBe(true)
    expect(inspection.reasons).toEqual([])

    // Verify unimported source file bytes are NOT stored as an object in backupDir
    const unimportedChunkId = sha256Hex(readFileSync(f.unimportedSourceFile))
    expect(
      existsSync(
        join(f.backupDir, 'objects', unimportedChunkId.slice(0, 2), `${unimportedChunkId}.pvchunk`)
      )
    ).toBe(false)
  })

  it('T3: incremental backup reuses verified unchanged chunks and keeps prior recovery point valid', async () => {
    const f = fixture!
    await runLocalBackup({
      jobId: 'backup-1',
      snapshotId: 'snap-001',
      backupRepoDir: f.backupDir,
      catalogPath: f.catalogPath,
      annotationsDir: f.annotationsDir,
      userDataDir: f.userDataDir,
      sourceRoots: [f.sourceDir],
      vaultRoots: [f.vaultDir],
      appVersion: '0.1.0'
    })

    // Record mtime of one 4 MiB chunk from snap-001
    const snap1 = BackupSnapshotManifestV1Schema.parse(
      JSON.parse(readFileSync(join(f.backupDir, 'snapshots', 'snap-001', 'snapshot.json'), 'utf8'))
    )
    const firstChunkId = snap1.vault!.copies[0]!.payloadFile.chunks[0]!.objectId
    const firstChunkPath = join(
      f.backupDir,
      'objects',
      firstChunkId.slice(0, 2),
      `${firstChunkId}.pvchunk`
    )
    const mtimeBefore = statSync(firstChunkPath).mtimeMs

    // Mutate only a collection in catalog/journal
    f.catalog.createCollection({ name: 'Trip 2026' })

    const res2 = await runLocalBackup({
      jobId: 'backup-2',
      snapshotId: 'snap-002',
      backupRepoDir: f.backupDir,
      catalogPath: f.catalogPath,
      annotationsDir: f.annotationsDir,
      userDataDir: f.userDataDir,
      sourceRoots: [f.sourceDir],
      vaultRoots: [f.vaultDir],
      appVersion: '0.1.0'
    })

    expect(res2.reusedChunkCount).toBeGreaterThanOrEqual(2)
    expect(res2.verificationScope).toBe('full_readback')
    expect(statSync(firstChunkPath).mtimeMs).toBe(mtimeBefore)

    expect(inspectRecoveryPointStatus(f.backupDir, 'snap-001').isComplete).toBe(true)
    expect(inspectRecoveryPointStatus(f.backupDir, 'snap-002').isComplete).toBe(true)
  })

  it('T3b: detects same-size corruption of a prior snapshot chunk, repairs from hash-matching bytes, or fails incomplete if repair fails', async () => {
    const f = fixture!
    await runLocalBackup({
      jobId: 'backup-1',
      snapshotId: 'snap-001',
      backupRepoDir: f.backupDir,
      catalogPath: f.catalogPath,
      annotationsDir: f.annotationsDir,
      userDataDir: f.userDataDir,
      sourceRoots: [f.sourceDir],
      vaultRoots: [f.vaultDir],
      appVersion: '0.1.0'
    })

    const snap1 = BackupSnapshotManifestV1Schema.parse(
      JSON.parse(readFileSync(join(f.backupDir, 'snapshots', 'snap-001', 'snapshot.json'), 'utf8'))
    )
    const targetChunkId = snap1.vault!.copies[0]!.payloadFile.chunks[0]!.objectId
    const targetChunkPath = join(
      f.backupDir,
      'objects',
      targetChunkId.slice(0, 2),
      `${targetChunkId}.pvchunk`
    )

    // Inject same-size 1-byte corruption into chunk referenced by snap-001
    const origChunkBytes = readFileSync(targetChunkPath)
    const corrupted = Buffer.from(origChunkBytes)
    corrupted[10] = corrupted[10]! ^ 0xff
    writeFileSync(targetChunkPath, corrupted)
    expect(statSync(targetChunkPath).size).toBe(origChunkBytes.length)

    // Case 1: incremental backup detects corruption, repairs from matching vault bytes, and verifies read-back
    const res2 = await runLocalBackup({
      jobId: 'backup-2',
      snapshotId: 'snap-002',
      backupRepoDir: f.backupDir,
      catalogPath: f.catalogPath,
      annotationsDir: f.annotationsDir,
      userDataDir: f.userDataDir,
      sourceRoots: [f.sourceDir],
      vaultRoots: [f.vaultDir],
      appVersion: '0.1.0'
    })
    expect(res2.verificationScope).toBe('full_readback')
    expect(sha256Hex(readFileSync(targetChunkPath))).toBe(targetChunkId)
    expect(inspectRecoveryPointStatus(f.backupDir, 'snap-002').isComplete).toBe(true)

    // Case 2: if repair fails, new recovery point must remain incomplete
    writeFileSync(targetChunkPath, corrupted)
    await expect(
      runLocalBackup(
        {
          jobId: 'backup-3',
          snapshotId: 'snap-003',
          backupRepoDir: f.backupDir,
          catalogPath: f.catalogPath,
          annotationsDir: f.annotationsDir,
          userDataDir: f.userDataDir,
          sourceRoots: [f.sourceDir],
          vaultRoots: [f.vaultDir],
          appVersion: '0.1.0'
        },
        {
          onBeforeChunkWrite: (objectId) => {
            if (objectId === targetChunkId) {
              const err = new Error('Simulated read-only repair failure') as NodeJS.ErrnoException
              err.code = 'EACCES'
              throw err
            }
          }
        }
      )
    ).rejects.toMatchObject({ code: 'destination_access_denied' })

    expect(inspectRecoveryPointStatus(f.backupDir, 'snap-003').isComplete).toBe(false)
  })

  it('T3c: rejects duplicate snapshotId via exclusive directory claim without modifying prior recovery point', async () => {
    const f = fixture!
    await runLocalBackup({
      jobId: 'backup-1',
      snapshotId: 'snap-001',
      backupRepoDir: f.backupDir,
      catalogPath: f.catalogPath,
      annotationsDir: f.annotationsDir,
      userDataDir: f.userDataDir,
      sourceRoots: [f.sourceDir],
      vaultRoots: [f.vaultDir],
      appVersion: '0.1.0'
    })

    const snap1Dir = join(f.backupDir, 'snapshots', 'snap-001')
    const beforeManifest = readFileSync(join(snap1Dir, 'snapshot.json'))
    const beforeComplete = readFileSync(join(snap1Dir, 'complete.json'))

    await expect(
      runLocalBackup({
        jobId: 'backup-dup',
        snapshotId: 'snap-001',
        backupRepoDir: f.backupDir,
        catalogPath: f.catalogPath,
        annotationsDir: f.annotationsDir,
        userDataDir: f.userDataDir,
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir],
        appVersion: '0.1.0'
      })
    ).rejects.toMatchObject({ code: 'destination_collision' })

    expect(existsSync(join(snap1Dir, '.pv-snapshot-in-progress.json'))).toBe(false)
    expect(readFileSync(join(snap1Dir, 'snapshot.json'))).toEqual(beforeManifest)
    expect(readFileSync(join(snap1Dir, 'complete.json'))).toEqual(beforeComplete)
  })

  it('T3d: fails closed if a vault file changes after snapshot capture before publication', async () => {
    const f = fixture!
    const prefix = f.largeSha256.slice(0, 2)
    const vaultPayloadPath = join(f.vaultDir, 'files', prefix, f.largeSha256, 'big-photo.tif')

    await expect(
      runLocalBackup(
        {
          jobId: 'backup-mutated',
          snapshotId: 'snap-mutated',
          backupRepoDir: f.backupDir,
          catalogPath: f.catalogPath,
          annotationsDir: f.annotationsDir,
          userDataDir: f.userDataDir,
          sourceRoots: [f.sourceDir],
          vaultRoots: [f.vaultDir],
          appVersion: '0.1.0'
        },
        {
          onAfterSnapshotCapture: () => {
            const mutated = Buffer.from(f.largeBytes)
            mutated[0] = mutated[0]! ^ 0xff
            writeFileSync(vaultPayloadPath, mutated)
          }
        }
      )
    ).rejects.toMatchObject({ code: 'source_vault_integrity_error' })

    expect(inspectRecoveryPointStatus(f.backupDir, 'snap-mutated').isComplete).toBe(false)
  })

  it('T4: interrupted/failed transfer leaves prior verified backup usable and recovers valid leftover chunks', async () => {
    const f = fixture!
    await runLocalBackup({
      jobId: 'backup-1',
      snapshotId: 'snap-001',
      backupRepoDir: f.backupDir,
      catalogPath: f.catalogPath,
      annotationsDir: f.annotationsDir,
      userDataDir: f.userDataDir,
      sourceRoots: [f.sourceDir],
      vaultRoots: [f.vaultDir],
      appVersion: '0.1.0'
    })

    f.catalog.createCollection({ name: 'Interrupted Snapshot Collection' })

    // Simulate mid-transfer failure before complete.json
    await expect(
      runLocalBackup(
        {
          jobId: 'backup-fail',
          snapshotId: 'snap-fail',
          backupRepoDir: f.backupDir,
          catalogPath: f.catalogPath,
          annotationsDir: f.annotationsDir,
          userDataDir: f.userDataDir,
          sourceRoots: [f.sourceDir],
          vaultRoots: [f.vaultDir],
          appVersion: '0.1.0'
        },
        {
          onBeforeCompleteMarker: () => {
            const err = new Error('Simulated NAS disconnect') as NodeJS.ErrnoException
            err.code = 'ECONNRESET'
            throw err
          }
        }
      )
    ).rejects.toMatchObject({ code: 'destination_unavailable' })

    const failedInspection = inspectRecoveryPointStatus(f.backupDir, 'snap-fail')
    expect(failedInspection.isComplete).toBe(false)
    expect(failedInspection.reasons).toContain('in_progress_marker_present')
    expect(failedInspection.reasons).toContain('completion_marker_missing')

    // Prior completed recovery point remains completely valid
    expect(inspectRecoveryPointStatus(f.backupDir, 'snap-001').isComplete).toBe(true)

    // Corrupt a leftover unreferenced chunk from snap-fail (e.g. snap-fail's catalog chunk)
    const snapFailManifest = BackupSnapshotManifestV1Schema.parse(
      JSON.parse(readFileSync(join(f.backupDir, 'snapshots', 'snap-fail', 'snapshot.json'), 'utf8'))
    )
    const unreferencedCatChunkId = snapFailManifest.catalogFile.chunks[0]!.objectId
    const unreferencedPath = join(
      f.backupDir,
      'objects',
      unreferencedCatChunkId.slice(0, 2),
      `${unreferencedCatChunkId}.pvchunk`
    )
    writeFileSync(unreferencedPath, Buffer.from('corrupt-leftover-chunk'))

    // Subsequent backup must detect corrupt unreferenced chunk, replace it, and succeed
    const res3 = await runLocalBackup({
      jobId: 'backup-3',
      snapshotId: 'snap-003',
      backupRepoDir: f.backupDir,
      catalogPath: f.catalogPath,
      annotationsDir: f.annotationsDir,
      userDataDir: f.userDataDir,
      sourceRoots: [f.sourceDir],
      vaultRoots: [f.vaultDir],
      appVersion: '0.1.0'
    })
    expect(inspectRecoveryPointStatus(f.backupDir, 'snap-003').isComplete).toBe(true)
    expect(sha256Hex(readFileSync(unreferencedPath))).toBe(unreferencedCatChunkId)
    expect(res3.writtenChunkCount).toBeGreaterThanOrEqual(1)
  })

  it('T4b: failure during chunk writing, before snapshot.json, or on cancellation leaves prior backup usable', async () => {
    const f = fixture!
    await runLocalBackup({
      jobId: 'backup-1',
      snapshotId: 'snap-001',
      backupRepoDir: f.backupDir,
      catalogPath: f.catalogPath,
      annotationsDir: f.annotationsDir,
      userDataDir: f.userDataDir,
      sourceRoots: [f.sourceDir],
      vaultRoots: [f.vaultDir],
      appVersion: '0.1.0'
    })

    // Failure during chunk writing (create new collection so a new chunk is written)
    f.catalog.createCollection({ name: 'Chunk Write Failure Trigger' })
    await expect(
      runLocalBackup(
        {
          jobId: 'backup-fail-chunk',
          snapshotId: 'snap-fail-chunk',
          backupRepoDir: f.backupDir,
          catalogPath: f.catalogPath,
          annotationsDir: f.annotationsDir,
          userDataDir: f.userDataDir,
          sourceRoots: [f.sourceDir],
          vaultRoots: [f.vaultDir],
          appVersion: '0.1.0'
        },
        {
          onBeforeChunkWrite: () => {
            const err = new Error(
              'Simulated USB unplug during chunk write'
            ) as NodeJS.ErrnoException
            err.code = 'ENOENT'
            throw err
          }
        }
      )
    ).rejects.toMatchObject({ code: 'destination_unavailable' })
    expect(inspectRecoveryPointStatus(f.backupDir, 'snap-fail-chunk').isComplete).toBe(false)

    // Failure before snapshot.json publication
    await expect(
      runLocalBackup(
        {
          jobId: 'backup-fail-manifest',
          snapshotId: 'snap-fail-manifest',
          backupRepoDir: f.backupDir,
          catalogPath: f.catalogPath,
          annotationsDir: f.annotationsDir,
          userDataDir: f.userDataDir,
          sourceRoots: [f.sourceDir],
          vaultRoots: [f.vaultDir],
          appVersion: '0.1.0'
        },
        {
          onBeforeSnapshotManifest: () => {
            const err = new Error(
              'Simulated NAS drop before snapshot.json'
            ) as NodeJS.ErrnoException
            err.code = 'ECONNRESET'
            throw err
          }
        }
      )
    ).rejects.toMatchObject({ code: 'destination_unavailable' })
    expect(inspectRecoveryPointStatus(f.backupDir, 'snap-fail-manifest').isComplete).toBe(false)

    // Cancellation in runLocalBackup (create new collection so a new chunk triggers onBeforeChunkWrite)
    f.catalog.createCollection({ name: 'Cancel Trigger' })
    const ac = new AbortController()
    await expect(
      runLocalBackup(
        {
          jobId: 'backup-cancel',
          snapshotId: 'snap-cancel',
          backupRepoDir: f.backupDir,
          catalogPath: f.catalogPath,
          annotationsDir: f.annotationsDir,
          userDataDir: f.userDataDir,
          sourceRoots: [f.sourceDir],
          vaultRoots: [f.vaultDir],
          appVersion: '0.1.0',
          signal: ac.signal
        },
        {
          onBeforeChunkWrite: () => {
            ac.abort()
          }
        }
      )
    ).rejects.toMatchObject({ code: 'backup_cancelled' })
    expect(inspectRecoveryPointStatus(f.backupDir, 'snap-cancel').isComplete).toBe(false)

    // Prior completed backup remains valid
    expect(inspectRecoveryPointStatus(f.backupDir, 'snap-001').isComplete).toBe(true)
  })

  it('T6: TransferRateLimiter paces writes, retries, and verification reads with injectable clock and AbortSignal', async () => {
    let now = 1000
    const sleeps: number[] = []
    const limiter = new TransferRateLimiter({
      maxBytesPerSecond: 64 * 1024, // 64 KiB/s
      nowMs: () => now,
      sleep: async (ms, signal) => {
        if (signal?.aborted) {
          throw new BackupSnapshotError('backup_cancelled', 'Cancelled')
        }
        sleeps.push(ms)
        now += ms
      }
    })

    // 192 KiB at 64 KiB/s -> 3 seconds total
    await limiter.consume(64 * 1024)
    await limiter.consume(128 * 1024)
    expect(now - 1000).toBe(3000)
    expect(limiter.getTotalConsumedBytes()).toBe(192 * 1024)

    const ac = new AbortController()
    ac.abort()
    await expect(limiter.consume(64 * 1024, ac.signal)).rejects.toMatchObject({
      code: 'backup_cancelled'
    })

    // Verify runLocalBackup charges rate limiter for writes, retries, and verification reads
    const f = fixture!
    let clockMs = 10_000
    const engineLimiter = new TransferRateLimiter({
      maxBytesPerSecond: 1024 * 1024,
      nowMs: () => clockMs,
      sleep: async (ms) => {
        clockMs += ms
      }
    })
    let injectedOnce = false
    await runLocalBackup(
      {
        jobId: 'backup-paced',
        snapshotId: 'snap-paced',
        backupRepoDir: f.backupDir,
        catalogPath: f.catalogPath,
        annotationsDir: f.annotationsDir,
        userDataDir: f.userDataDir,
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir],
        appVersion: '0.1.0',
        rateLimiter: engineLimiter
      },
      {
        onAfterChunkWrite: () => {
          if (!injectedOnce) {
            injectedOnce = true
            const err = new Error('Transient write glitch') as NodeJS.ErrnoException
            err.code = 'EAGAIN'
            throw err
          }
        }
      }
    )

    // Total consumed bytes must exceed logical bytes because of read-back verification + retry
    expect(engineLimiter.getTotalConsumedBytes()).toBeGreaterThan(f.largeBytes.length * 2)
  })

  it('T6b: real-clock TransferRateLimiter paces runLocalBackup and wakes promptly on AbortSignal', async () => {
    const f = fixture!

    // 1. Prompt abort wakeup: 1 MiB at 64 KiB/s (~16s wait) aborted after 30ms
    const abortLimiter = new TransferRateLimiter({ maxBytesPerSecond: 64 * 1024 })
    const ac = new AbortController()
    const abortTimer = setTimeout(() => ac.abort(), 30)
    const abortStart = Date.now()
    await expect(abortLimiter.consume(1024 * 1024, ac.signal)).rejects.toMatchObject({
      code: 'backup_cancelled'
    })
    clearTimeout(abortTimer)
    expect(Date.now() - abortStart).toBeLessThan(1000)

    // 2. Real-clock pacing on runLocalBackup (~9.5 MiB paced I/O at 4 MiB/s -> >= 1500 ms)
    const realLimiter = new TransferRateLimiter({ maxBytesPerSecond: 4 * 1024 * 1024 })
    const startMs = Date.now()
    const res = await runLocalBackup({
      jobId: 'backup-real-pace',
      snapshotId: 'snap-real-pace',
      backupRepoDir: f.backupDir,
      catalogPath: f.catalogPath,
      annotationsDir: f.annotationsDir,
      userDataDir: f.userDataDir,
      sourceRoots: [f.sourceDir],
      vaultRoots: [f.vaultDir],
      appVersion: '0.1.0',
      rateLimiter: realLimiter
    })
    const elapsedMs = Date.now() - startMs
    expect(res.verificationScope).toBe('full_readback')
    expect(elapsedMs).toBeGreaterThanOrEqual(1500)
  })

  it('T11-destination: validates local & UNC NAS paths, rejects overlaps, non-empty unrelated dirs, and symlinks', () => {
    const f = fixture!

    // Valid empty local path
    expect(() =>
      validateBackupDestinationPath({
        destinationDir: f.backupDir,
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir],
        userDataDir: f.userDataDir
      })
    ).not.toThrow()

    // Non-empty unrelated directory without repository.json rejected
    const unrelatedDir = join(f.rootDir, 'unrelated')
    mkdirSync(unrelatedDir, { recursive: true })
    writeFileSync(join(unrelatedDir, 'family.txt'), 'keep me')
    expect(() =>
      validateBackupDestinationPath({
        destinationDir: unrelatedDir,
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir],
        userDataDir: f.userDataDir
      })
    ).toThrow(BackupContainmentError)

    // Overlap with source, vault, or userData rejected
    expect(() =>
      validateBackupDestinationPath({
        destinationDir: join(f.sourceDir, 'nested-backup'),
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir],
        userDataDir: f.userDataDir
      })
    ).toThrow(BackupContainmentError)

    expect(() =>
      validateBackupDestinationPath({
        destinationDir: join(f.vaultDir, 'nested-backup'),
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir],
        userDataDir: f.userDataDir
      })
    ).toThrow(BackupContainmentError)

    expect(() =>
      validateBackupDestinationPath({
        destinationDir: join(f.userDataDir, 'nested-backup'),
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir],
        userDataDir: f.userDataDir
      })
    ).toThrow(BackupContainmentError)

    // UNC NAS path validation (structural, non-probing for offline share)
    if (process.platform === 'win32') {
      expect(() =>
        validateBackupDestinationPath({
          destinationDir: '\\\\NAS-SERVER\\Backups\\PersonalVault',
          sourceRoots: [f.sourceDir],
          vaultRoots: [f.vaultDir],
          userDataDir: f.userDataDir
        })
      ).not.toThrow()
    }

    // Symlink / junction destination rejected
    const symDest = join(f.rootDir, 'sym-backup')
    const realTarget = join(f.rootDir, 'real-backup-target')
    mkdirSync(realTarget, { recursive: true })
    let linkCreated = false
    try {
      symlinkSync(realTarget, symDest, process.platform === 'win32' ? 'junction' : 'dir')
      linkCreated = true
    } catch {
      // Skip if OS disallows symlinks
    }
    if (linkCreated) {
      expect(() =>
        validateBackupDestinationPath({
          destinationDir: symDest,
          sourceRoots: [f.sourceDir],
          vaultRoots: [f.vaultDir],
          userDataDir: f.userDataDir
        })
      ).toThrow(BackupContainmentError)
    }
  })
})
