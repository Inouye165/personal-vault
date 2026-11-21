// @vitest-environment node
/**
 * Personal Vault — Stage 8B Sub-slice 1A-3: Cross-Drive Isolated Profile Restore
 * & Crash-Boundary Verification Tests
 *
 * Covers:
 * - T7: Verified restore into fresh, isolated profile & vault directories (including C: <-> D: separate volumes).
 * - T8: Corrupt backup rejection matrix & cancellation fail-closed behavior.
 * - T9a–T9e: Cross-drive interrupted restore crash-point matrix & scoped retry cleanup.
 * - T11-restore: Restore target & backup repository containment, overlap, non-empty & symlink/junction checks.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { BackupRestoreCompleteMarkerV1Schema } from '../../src/shared/validation/backup-schemas'
import { VaultIdentitySchema } from '../../src/shared/validation/ipc-schemas'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { normalizePathForLookup } from '../../src/main/services/catalog/path-normalization'
import {
  initializeVault,
  isVaultDirectory,
  loadVaultIdentity
} from '../../src/main/services/vault/identity'
import { writeVaultManifest } from '../../src/main/services/vault/manifest'
import { VaultManifestSchema } from '../../src/main/services/vault/manifest-schema'
import type { VaultManifest } from '../../src/main/services/vault/types'
import { validateRestoreTargetPaths } from '../../src/main/services/backup/containment'
import { runLocalBackup } from '../../src/main/services/backup/engine'
import {
  BackupContainmentError,
  BackupRestoreError,
  RestoreIncompleteError
} from '../../src/main/services/backup/errors'
import {
  cleanupInterruptedRestoreTarget,
  inspectRestoredProfileStatus,
  restoreRecoveryPointToIsolatedProfile,
  verifyRecoveryPoint
} from '../../src/main/services/backup/restore'

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

interface FileSnapshot {
  readonly sha256: string
  readonly byteSize: number
  readonly mtimeMs: number
}

function snapshotDirectoryTree(rootDir: string): Map<string, FileSnapshot> {
  const map = new Map<string, FileSnapshot>()
  if (!existsSync(rootDir)) return map
  const walk = (dir: string, relPrefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(fullPath, relPath)
      } else if (entry.isFile()) {
        const bytes = readFileSync(fullPath)
        const st = statSync(fullPath)
        map.set(relPath, {
          sha256: sha256Hex(bytes),
          byteSize: st.size,
          mtimeMs: st.mtimeMs
        })
      }
    }
  }
  walk(rootDir, '')
  return map
}

function assertDirectoryTreeUnchanged(
  rootDir: string,
  before: Map<string, FileSnapshot>,
  label: string
): void {
  const after = snapshotDirectoryTree(rootDir)
  expect([...after.keys()], `${label}: file list changed`).toEqual([...before.keys()])
  for (const [relPath, expected] of before.entries()) {
    const actual = after.get(relPath)
    expect(actual, `${label}: missing ${relPath}`).toBeDefined()
    expect(actual!.sha256, `${label}: sha256 changed for ${relPath}`).toBe(expected.sha256)
    expect(actual!.byteSize, `${label}: size changed for ${relPath}`).toBe(expected.byteSize)
    expect(actual!.mtimeMs, `${label}: mtime changed for ${relPath}`).toBe(expected.mtimeMs)
  }
}

interface RestoreFixture {
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
  snapshotId: string
  photoSha256: string
  photoBytes: Buffer
  docSha256: string
  docBytes: Buffer
  photoFileLocationId: number
  photoExpectedRevision: string
  docFileLocationId: number
  unimportedSourceFile: string
  collectionId: number
  scanJobId: number
  cleanupDirs: string[]
}

async function createVerifiedBackupFixture(): Promise<RestoreFixture> {
  const rootDir = mkdtempSync(join(tmpdir(), 'pv-8b-1a3-'))
  const userDataDir = join(rootDir, 'userData')
  const catalogPath = join(userDataDir, 'vault-catalog.db')
  const annotationsDir = join(userDataDir, 'annotations')
  const sourceDir = join(rootDir, 'sources')
  const vaultDir = join(rootDir, 'vault')
  const backupDir = join(rootDir, 'backup-repo')

  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(backupDir, { recursive: true })

  // 4.25 MiB photo to exercise multi-chunk reconstruction
  const photoBytes = Buffer.alloc(4 * 1024 * 1024 + 256 * 1024, 0x33)
  photoBytes.write('PV-PHOTO-START', 0)
  photoBytes.write('PV-PHOTO-END', photoBytes.length - 12)
  const photoSha256 = sha256Hex(photoBytes)
  const photoSourceA = join(sourceDir, 'sunset.jpg')
  const photoSourceB = join(sourceDir, 'sunset-copy.jpg')
  writeFileSync(photoSourceA, photoBytes)
  writeFileSync(photoSourceB, photoBytes)

  // Document file
  const docBytes = Buffer.from('Tax Receipt 2026 - Total $123.45', 'utf8')
  const docSha256 = sha256Hex(docBytes)
  const docSource = join(sourceDir, 'receipt-2026.txt')
  writeFileSync(docSource, docBytes)

  // Unimported source file (must remain untouched, not backed up as bytes)
  const unimportedSourceFile = join(sourceDir, 'private-unimported.txt')
  writeFileSync(unimportedSourceFile, Buffer.from('do-not-backup-bytes', 'utf8'))

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
      originalPath: photoSourceA,
      fileName: 'sunset.jpg',
      extension: '.jpg',
      category: 'photo',
      byteSize: photoBytes.length,
      birthtimeMs: now - 10_000,
      mtimeMs: now - 10_000,
      discoveredAtMs: now
    },
    {
      originalPath: photoSourceB,
      fileName: 'sunset-copy.jpg',
      extension: '.jpg',
      category: 'photo',
      byteSize: photoBytes.length,
      birthtimeMs: now - 9_000,
      mtimeMs: now - 9_000,
      discoveredAtMs: now
    },
    {
      originalPath: docSource,
      fileName: 'receipt-2026.txt',
      extension: '.txt',
      category: 'document',
      byteSize: docBytes.length,
      birthtimeMs: now - 8_000,
      mtimeMs: now - 8_000,
      discoveredAtMs: now
    },
    {
      originalPath: unimportedSourceFile,
      fileName: 'private-unimported.txt',
      extension: '.txt',
      category: 'document',
      byteSize: 19,
      birthtimeMs: now - 7_000,
      mtimeMs: now - 7_000,
      discoveredAtMs: now
    }
  ])

  const locs = catalog.queryFileLocations({ limit: 20 }).items
  const photoLocA = locs.find((l) => l.fileName === 'sunset.jpg')!
  const photoLocB = locs.find((l) => l.fileName === 'sunset-copy.jpg')!
  const docLoc = locs.find((l) => l.fileName === 'receipt-2026.txt')!

  catalog.recordHashObservationsBatch([
    {
      originalPath: photoSourceA,
      sha256: photoSha256,
      observedByteSize: photoBytes.length,
      observedMtimeMs: photoLocA.filesystemMtimeMs,
      hashedAtMs: now
    },
    {
      originalPath: photoSourceB,
      sha256: photoSha256,
      observedByteSize: photoBytes.length,
      observedMtimeMs: photoLocB.filesystemMtimeMs,
      hashedAtMs: now
    },
    {
      originalPath: docSource,
      sha256: docSha256,
      observedByteSize: docBytes.length,
      observedMtimeMs: docLoc.filesystemMtimeMs,
      hashedAtMs: now
    }
  ])

  const photoHashObsA = catalog.getHashObservationsForFile(photoLocA.id).items[0]!
  const photoHashObsB = catalog.getHashObservationsForFile(photoLocB.id).items[0]!
  const docHashObs = catalog.getHashObservationsForFile(docLoc.id).items[0]!

  const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Primary Test Vault' })
  catalog.registerVault({
    vaultId: identity.vaultId,
    vaultPath: vaultDir,
    name: identity.vaultName,
    createdAtMs: identity.createdAtMs
  })

  // Write vault files and multi-source manifest for photo + single-source manifest for doc
  const photoPrefix = photoSha256.slice(0, 2)
  const photoPayloadRel = `files/${photoPrefix}/${photoSha256}/sunset.jpg`
  const photoManifestRel = `files/${photoPrefix}/${photoSha256}/manifest.json`
  mkdirSync(join(vaultDir, 'files', photoPrefix, photoSha256), { recursive: true })
  writeFileSync(join(vaultDir, photoPayloadRel), photoBytes)

  const docPrefix = docSha256.slice(0, 2)
  const docPayloadRel = `files/${docPrefix}/${docSha256}/receipt-2026.txt`
  const docManifestRel = `files/${docPrefix}/${docSha256}/manifest.json`
  mkdirSync(join(vaultDir, 'files', docPrefix, docSha256), { recursive: true })
  writeFileSync(join(vaultDir, docPayloadRel), docBytes)

  const importJobId = randomUUID()
  catalog.createVaultImportJob({
    jobId: importJobId,
    vaultId: identity.vaultId,
    totalFiles: 3,
    totalBytes: photoBytes.length * 2 + docBytes.length,
    items: [
      {
        fileLocationId: photoLocA.id,
        discoveryObservationId: photoLocA.discoveryObservationId!,
        hashObservationId: photoHashObsA.id,
        sha256: photoSha256,
        byteSize: photoBytes.length
      },
      {
        fileLocationId: photoLocB.id,
        discoveryObservationId: photoLocB.discoveryObservationId!,
        hashObservationId: photoHashObsB.id,
        sha256: photoSha256,
        byteSize: photoBytes.length
      },
      {
        fileLocationId: docLoc.id,
        discoveryObservationId: docLoc.discoveryObservationId!,
        hashObservationId: docHashObs.id,
        sha256: docSha256,
        byteSize: docBytes.length
      }
    ]
  })

  const photoCopy = catalog.recordVaultCopy({
    vaultId: identity.vaultId,
    sha256: photoSha256,
    byteSize: photoBytes.length,
    relativePath: photoPayloadRel,
    manifestRelativePath: photoManifestRel,
    verifiedAtMs: now
  })
  const docCopy = catalog.recordVaultCopy({
    vaultId: identity.vaultId,
    sha256: docSha256,
    byteSize: docBytes.length,
    relativePath: docPayloadRel,
    manifestRelativePath: docManifestRel,
    verifiedAtMs: now
  })

  const photoManifest: VaultManifest = {
    formatVersion: 1,
    vaultId: identity.vaultId,
    sha256: photoSha256,
    byteSize: photoBytes.length,
    managedCopy: {
      relativePath: photoPayloadRel,
      fileName: 'sunset.jpg',
      publishedAtMs: now,
      verifiedSha256: photoSha256,
      verifiedByteSize: photoBytes.length
    },
    sources: [
      {
        fileLocationId: photoLocA.id,
        originalPath: photoSourceA,
        fileName: 'sunset.jpg',
        extension: '.jpg',
        category: 'photo',
        recordedFacts: {
          byteSize: photoBytes.length,
          filesystemBirthtimeMs: photoLocA.filesystemBirthtimeMs,
          filesystemMtimeMs: photoLocA.filesystemMtimeMs,
          firstDiscoveredAtMs: photoLocA.firstDiscoveredAtMs,
          lastSeenAtMs: photoLocA.lastSeenAtMs,
          discoveryObservationId: photoLocA.discoveryObservationId!,
          hashObservationId: photoHashObsA.id,
          hashVerifiedAtMs: photoHashObsA.hashedAtMs
        },
        inferredMetadata: { inferredCaptureTimeMs: null },
        reviewDecisions: { isPreferred: true, duplicateReviewStatus: 'reviewed' },
        importResult: {
          importJobId,
          importedAtMs: now,
          verifiedSourceSha256: photoSha256,
          verifiedSourceByteSize: photoBytes.length,
          sourceStability: {
            preCopyMtimeMs: photoLocA.filesystemMtimeMs ?? 0,
            postCopyMtimeMs: photoLocA.filesystemMtimeMs ?? 0,
            preCopyByteSize: photoBytes.length,
            postCopyByteSize: photoBytes.length
          }
        }
      },
      {
        fileLocationId: photoLocB.id,
        originalPath: photoSourceB,
        fileName: 'sunset-copy.jpg',
        extension: '.jpg',
        category: 'photo',
        recordedFacts: {
          byteSize: photoBytes.length,
          filesystemBirthtimeMs: photoLocB.filesystemBirthtimeMs,
          filesystemMtimeMs: photoLocB.filesystemMtimeMs,
          firstDiscoveredAtMs: photoLocB.firstDiscoveredAtMs,
          lastSeenAtMs: photoLocB.lastSeenAtMs,
          discoveryObservationId: photoLocB.discoveryObservationId!,
          hashObservationId: photoHashObsB.id,
          hashVerifiedAtMs: photoHashObsB.hashedAtMs
        },
        inferredMetadata: { inferredCaptureTimeMs: null },
        reviewDecisions: { isPreferred: false, duplicateReviewStatus: 'reviewed' },
        importResult: {
          importJobId,
          importedAtMs: now,
          verifiedSourceSha256: photoSha256,
          verifiedSourceByteSize: photoBytes.length,
          sourceStability: {
            preCopyMtimeMs: photoLocB.filesystemMtimeMs ?? 0,
            postCopyMtimeMs: photoLocB.filesystemMtimeMs ?? 0,
            preCopyByteSize: photoBytes.length,
            postCopyByteSize: photoBytes.length
          }
        }
      }
    ]
  }
  writeVaultManifest(vaultDir, photoManifest, importJobId)

  const docManifest: VaultManifest = {
    formatVersion: 1,
    vaultId: identity.vaultId,
    sha256: docSha256,
    byteSize: docBytes.length,
    managedCopy: {
      relativePath: docPayloadRel,
      fileName: 'receipt-2026.txt',
      publishedAtMs: now,
      verifiedSha256: docSha256,
      verifiedByteSize: docBytes.length
    },
    sources: [
      {
        fileLocationId: docLoc.id,
        originalPath: docSource,
        fileName: 'receipt-2026.txt',
        extension: '.txt',
        category: 'document',
        recordedFacts: {
          byteSize: docBytes.length,
          filesystemBirthtimeMs: docLoc.filesystemBirthtimeMs,
          filesystemMtimeMs: docLoc.filesystemMtimeMs,
          firstDiscoveredAtMs: docLoc.firstDiscoveredAtMs,
          lastSeenAtMs: docLoc.lastSeenAtMs,
          discoveryObservationId: docLoc.discoveryObservationId!,
          hashObservationId: docHashObs.id,
          hashVerifiedAtMs: docHashObs.hashedAtMs
        },
        inferredMetadata: { inferredCaptureTimeMs: null },
        reviewDecisions: { isPreferred: false, duplicateReviewStatus: null },
        importResult: {
          importJobId,
          importedAtMs: now,
          verifiedSourceSha256: docSha256,
          verifiedSourceByteSize: docBytes.length,
          sourceStability: {
            preCopyMtimeMs: docLoc.filesystemMtimeMs ?? 0,
            postCopyMtimeMs: docLoc.filesystemMtimeMs ?? 0,
            preCopyByteSize: docBytes.length,
            postCopyByteSize: docBytes.length
          }
        }
      }
    ]
  }
  writeVaultManifest(vaultDir, docManifest, importJobId)

  catalog.updateVaultImportItem({
    jobId: importJobId,
    fileLocationId: photoLocA.id,
    status: 'completed',
    vaultCopyId: photoCopy.id,
    completedAtMs: now
  })
  catalog.updateVaultImportItem({
    jobId: importJobId,
    fileLocationId: photoLocB.id,
    status: 'completed',
    vaultCopyId: photoCopy.id,
    completedAtMs: now
  })
  catalog.updateVaultImportItem({
    jobId: importJobId,
    fileLocationId: docLoc.id,
    status: 'completed',
    vaultCopyId: docCopy.id,
    completedAtMs: now
  })
  catalog.updateVaultImportStatus(importJobId, 'completed')

  // User metadata: photo annotation, collection, plus an active scan_job
  const photoExpectedRevision = `rev:${photoLocA.discoveryObservationId}:${photoBytes.length}:${photoLocA.filesystemMtimeMs}:${photoSha256}`
  catalog.setPhotoAnnotation({
    fileLocationId: photoLocA.id,
    expectedRevision: photoExpectedRevision,
    expectedVersion: 0,
    rating: 5,
    flag: 'pick'
  })
  const collection = catalog.createCollection({ name: 'Favorites 2026' })
  catalog.addCollectionMember({
    collectionId: collection.id,
    fileLocationId: photoLocA.id,
    expectedRevision: photoExpectedRevision
  })

  // Insert an active 'running' scan job to verify restore transitions it to 'interrupted'
  const scanJob = catalog.createScanJob({ roots: [sourceDir] })

  const snapshotId = '2026-11-21T05-00-00Z_restore01'
  await runLocalBackup({
    jobId: 'backup-job-1',
    snapshotId,
    backupRepoDir: backupDir,
    catalogPath,
    annotationsDir,
    userDataDir,
    sourceRoots: [sourceDir],
    vaultRoots: [vaultDir],
    appVersion: '0.1.0'
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
    snapshotId,
    photoSha256,
    photoBytes,
    docSha256,
    docBytes,
    photoFileLocationId: photoLocA.id,
    photoExpectedRevision,
    docFileLocationId: docLoc.id,
    unimportedSourceFile,
    collectionId: collection.id,
    scanJobId: scanJob.id,
    cleanupDirs: [rootDir]
  }
}

describe('Stage 8B Sub-slice 1A-3: Cross-Drive Isolated Profile Restore & Verification', () => {
  const activeFixtures: RestoreFixture[] = []

  afterEach(() => {
    while (activeFixtures.length > 0) {
      const fx = activeFixtures.pop()!
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      for (const dir of fx.cleanupDirs) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  })

  it('T7: restores a verified recovery point across separate volumes (C: profile, D: vault), rebinds catalog, preserves provenance, and keeps originals/active profile untouched', async () => {
    const fx = await createVerifiedBackupFixture()
    activeFixtures.push(fx)

    // Use C: (tmpdir) for targetProfileDir and D: (workspace-adjacent temp) for targetVaultDir
    // to exercise real separate volumes when D:\ is available.
    const targetProfileDir = mkdtempSync(join(tmpdir(), 'pv-8b-restore-profile-'))
    const dVolumeRoot = existsSync('D:\\organizer')
      ? mkdtempSync(join('D:\\organizer', '.vitest-restore-vault-'))
      : mkdtempSync(join(tmpdir(), 'pv-8b-restore-vault-'))
    const targetVaultDir = join(dVolumeRoot, 'restored-vault')
    fx.cleanupDirs.push(targetProfileDir, dVolumeRoot)

    const sourcesBefore = snapshotDirectoryTree(fx.sourceDir)
    const activeVaultBefore = snapshotDirectoryTree(fx.vaultDir)
    const backupRepoBefore = snapshotDirectoryTree(fx.backupDir)

    const verifyResult = await verifyRecoveryPoint({
      backupRepoDir: fx.backupDir,
      snapshotId: fx.snapshotId
    })
    expect(verifyResult.snapshotId).toBe(fx.snapshotId)
    expect(verifyResult.verifiedFileCount).toBeGreaterThanOrEqual(4)

    const restoreResult = await restoreRecoveryPointToIsolatedProfile({
      backupRepoDir: fx.backupDir,
      snapshotId: fx.snapshotId,
      targetProfileDir,
      targetVaultDir,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir]
    })

    expect(restoreResult.snapshotId).toBe(fx.snapshotId)
    expect(restoreResult.restoredVaultPath).toBeTruthy()
    expect(inspectRestoredProfileStatus(targetProfileDir, targetVaultDir).status).toBe('complete')

    // Markers & temp dirs clean on both drives
    expect(existsSync(join(targetProfileDir, '.pv-restore-in-progress.json'))).toBe(false)
    expect(existsSync(join(targetVaultDir, '.pv-restore-in-progress.json'))).toBe(false)
    expect(existsSync(join(targetProfileDir, '.pv-restore-temp'))).toBe(false)
    expect(existsSync(join(targetVaultDir, '.pv-restore-temp'))).toBe(false)

    const profileComplete = BackupRestoreCompleteMarkerV1Schema.parse(
      JSON.parse(readFileSync(join(targetProfileDir, '.pv-restore-complete.json'), 'utf8'))
    )
    const vaultComplete = BackupRestoreCompleteMarkerV1Schema.parse(
      JSON.parse(readFileSync(join(targetVaultDir, '.pv-restore-complete.json'), 'utf8'))
    )
    expect(profileComplete.restoreJobId).toBe(restoreResult.restoreJobId)
    expect(vaultComplete.restoreJobId).toBe(restoreResult.restoreJobId)

    // 1 & 2: Restored vault files, vault.json, and multi-source manifest.json
    expect(isVaultDirectory(targetVaultDir)).toBe(true)
    const restoredIdentity = loadVaultIdentity(targetVaultDir)
    VaultIdentitySchema.parse(restoredIdentity)
    expect(restoredIdentity.vaultId).toBe(fx.vaultId)

    const photoPrefix = fx.photoSha256.slice(0, 2)
    const restoredPhotoBytes = readFileSync(
      join(targetVaultDir, 'files', photoPrefix, fx.photoSha256, 'sunset.jpg')
    )
    expect(sha256Hex(restoredPhotoBytes)).toBe(fx.photoSha256)
    expect(restoredPhotoBytes.length).toBe(fx.photoBytes.length)

    const restoredPhotoManifest = VaultManifestSchema.parse(
      JSON.parse(
        readFileSync(
          join(targetVaultDir, 'files', photoPrefix, fx.photoSha256, 'manifest.json'),
          'utf8'
        )
      )
    )
    expect(restoredPhotoManifest.sources).toHaveLength(2)

    const docPrefix = fx.docSha256.slice(0, 2)
    const restoredDocBytes = readFileSync(
      join(targetVaultDir, 'files', docPrefix, fx.docSha256, 'receipt-2026.txt')
    )
    expect(sha256Hex(restoredDocBytes)).toBe(fx.docSha256)

    // 3, 4, 5, 6: Open restored catalog + journal, verify provenance, user metadata, rebinding, job neutralization, and post-restore writes
    const restoredJournal = new AnnotationJournal({
      storageDir: join(targetProfileDir, 'annotations'),
      sourceRoots: () => [fx.sourceDir],
      vaultPath: () => targetVaultDir
    })
    await restoredJournal.initialize()
    const restoredCatalog = CatalogDatabase.open({
      catalogPath: join(targetProfileDir, 'vault-catalog.db'),
      journal: restoredJournal
    })
    try {
      const activeVault = restoredCatalog.getActiveVault()
      expect(activeVault).not.toBeNull()
      expect(activeVault!.vaultId).toBe(fx.vaultId)
      expect(activeVault!.normalizedVaultPath).toBe(normalizePathForLookup(targetVaultDir))

      // Original source provenance preserved verbatim
      const restoredLocs = restoredCatalog.queryFileLocations({ limit: 20 }).items
      expect(restoredLocs.map((l) => l.originalPath).sort()).toEqual(
        fx.catalog
          .queryFileLocations({ limit: 20 })
          .items.map((l) => l.originalPath)
          .sort()
      )

      // User annotations preserved
      const restoredAnnotation = restoredCatalog.getPhotoAnnotation(fx.photoFileLocationId)
      expect(restoredAnnotation?.rating).toBe(5)
      expect(restoredAnnotation?.flag).toBe('pick')

      const collections = restoredCatalog.listCollections().items
      expect(collections.some((c) => c.name === 'Favorites 2026')).toBe(true)

      // Running scan job transitioned to 'interrupted'
      const scanJob = restoredCatalog.getScanJob(fx.scanJobId)
      expect(scanJob?.status).toBe('interrupted')

      // Writing a new post-restore annotation succeeds cleanly
      const updated = restoredCatalog.setPhotoAnnotation({
        fileLocationId: fx.photoFileLocationId,
        expectedRevision: fx.photoExpectedRevision,
        expectedVersion: restoredAnnotation!.version,
        rating: 4,
        flag: 'pick'
      })
      expect(updated.rating).toBe(4)
    } finally {
      restoredCatalog.close()
    }

    // 8: Originals, active vault, and backup repository 100% bitwise untouched
    assertDirectoryTreeUnchanged(fx.sourceDir, sourcesBefore, 'originals')
    assertDirectoryTreeUnchanged(fx.vaultDir, activeVaultBefore, 'active vault')
    assertDirectoryTreeUnchanged(fx.backupDir, backupRepoBefore, 'backup repository')
  })

  it('T8: rejects corrupt backups across all fault modes and cancellation without writing .pv-restore-complete.json', async () => {
    const fx = await createVerifiedBackupFixture()
    activeFixtures.push(fx)

    const cloneBackup = (suffix: string): string => {
      const dir = join(fx.rootDir, `corrupt-${suffix}`)
      cpSync(fx.backupDir, dir, { recursive: true })
      return dir
    }

    const expectBothFailClosed = async (
      repoDir: string,
      expectedCode: string | RegExp
    ): Promise<void> => {
      await expect(
        verifyRecoveryPoint({ backupRepoDir: repoDir, snapshotId: fx.snapshotId })
      ).rejects.toThrow(BackupRestoreError)

      const targetProfileDir = mkdtempSync(join(fx.rootDir, 'fail-profile-'))
      const targetVaultDir = join(fx.rootDir, `fail-vault-${randomUUID()}`)
      await expect(
        restoreRecoveryPointToIsolatedProfile({
          backupRepoDir: repoDir,
          snapshotId: fx.snapshotId,
          targetProfileDir,
          targetVaultDir
        })
      ).rejects.toThrow(expectedCode)
      expect(existsSync(join(targetProfileDir, '.pv-restore-complete.json'))).toBe(false)
      expect(existsSync(join(targetVaultDir, '.pv-restore-complete.json'))).toBe(false)
    }

    // 1. Missing repository.json
    const noRepo = cloneBackup('no-repo')
    unlinkSync(join(noRepo, 'repository.json'))
    await expectBothFailClosed(noRepo, /repository/i)

    // 2. Missing complete.json
    const noComplete = cloneBackup('no-complete')
    unlinkSync(join(noComplete, 'snapshots', fx.snapshotId, 'complete.json'))
    await expectBothFailClosed(noComplete, /incomplete/i)

    // 3. Leftover .pv-snapshot-in-progress.json
    const inProg = cloneBackup('in-prog')
    writeFileSync(
      join(inProg, 'snapshots', fx.snapshotId, '.pv-snapshot-in-progress.json'),
      JSON.stringify({
        formatVersion: 1,
        schema: 'pv_backup_in_progress_v1',
        jobId: 'j',
        snapshotId: fx.snapshotId,
        repositoryId: JSON.parse(readFileSync(join(inProg, 'repository.json'), 'utf8'))
          .repositoryId,
        startedAtMs: Date.now()
      })
    )
    await expectBothFailClosed(inProg, /incomplete/i)

    // 4. Tampered snapshot.json (manifestSha256 mismatch)
    const tamperedManifest = cloneBackup('tampered-manifest')
    const snapPath = join(tamperedManifest, 'snapshots', fx.snapshotId, 'snapshot.json')
    const snapJson = JSON.parse(readFileSync(snapPath, 'utf8'))
    snapJson.appVersion = '9.9.9-tampered'
    writeFileSync(snapPath, JSON.stringify(snapJson))
    await expectBothFailClosed(tamperedManifest, /manifest|snapshot\.json/i)

    // 5. Missing .pvchunk & 6. Single-bit flip in .pvchunk
    const manifestObj = JSON.parse(
      readFileSync(join(fx.backupDir, 'snapshots', fx.snapshotId, 'snapshot.json'), 'utf8')
    )
    const firstChunkId: string = manifestObj.catalogFile.chunks[0].objectId
    const chunkRel = join('objects', firstChunkId.slice(0, 2), `${firstChunkId}.pvchunk`)

    const missingChunk = cloneBackup('missing-chunk')
    unlinkSync(join(missingChunk, chunkRel))
    await expectBothFailClosed(missingChunk, /incomplete|missing|chunk/i)

    const flippedChunk = cloneBackup('flipped-chunk')
    const chunkBytes = readFileSync(join(flippedChunk, chunkRel))
    chunkBytes[0] = chunkBytes[0]! ^ 0x01
    writeFileSync(join(flippedChunk, chunkRel), chunkBytes)
    await expectBothFailClosed(flippedChunk, /corrupt|mismatch|checksum|sha/i)

    // 7. Future formatVersion in repository.json
    const futureRepo = cloneBackup('future-format')
    const repoJson = JSON.parse(readFileSync(join(futureRepo, 'repository.json'), 'utf8'))
    repoJson.formatVersion = 99
    writeFileSync(join(futureRepo, 'repository.json'), JSON.stringify(repoJson))
    await expectBothFailClosed(futureRepo, /repository|version/i)

    // 8. Corrupt SQLite catalog payload & future schema_migrations (re-packaged with valid chunk/manifest hashes)
    const corruptCatalogRepo = cloneBackup('corrupt-catalog')
    const badDbPath = join(fx.rootDir, 'bad-sqlite.db')
    writeFileSync(badDbPath, Buffer.from('NOT-A-VALID-SQLITE-DATABASE-FILE'))
    const badDbBytes = readFileSync(badDbPath)
    const badDbSha = sha256Hex(badDbBytes)
    mkdirSync(join(corruptCatalogRepo, 'objects', badDbSha.slice(0, 2)), { recursive: true })
    writeFileSync(
      join(corruptCatalogRepo, 'objects', badDbSha.slice(0, 2), `${badDbSha}.pvchunk`),
      badDbBytes
    )
    const corruptSnapPath = join(corruptCatalogRepo, 'snapshots', fx.snapshotId, 'snapshot.json')
    const corruptSnap = JSON.parse(readFileSync(corruptSnapPath, 'utf8'))
    corruptSnap.catalogFile = {
      logicalPath: 'vault-catalog.db',
      byteSize: badDbBytes.length,
      sha256: badDbSha,
      chunks: [
        {
          objectId: badDbSha,
          index: 0,
          plaintextByteSize: badDbBytes.length,
          storedByteSize: badDbBytes.length,
          plaintextSha256: badDbSha
        }
      ]
    }
    const newManifestBytes = Buffer.from(JSON.stringify(corruptSnap, null, 2), 'utf8')
    writeFileSync(corruptSnapPath, newManifestBytes)
    const completePath = join(corruptCatalogRepo, 'snapshots', fx.snapshotId, 'complete.json')
    const completeJson = JSON.parse(readFileSync(completePath, 'utf8'))
    completeJson.manifestSha256 = sha256Hex(newManifestBytes)
    writeFileSync(completePath, JSON.stringify(completeJson, null, 2))
    await expectBothFailClosed(corruptCatalogRepo, /catalog|sqlite/i)

    // 9. Future schema_migrations version in SQLite catalog
    const futureSchemaRepo = cloneBackup('future-schema')
    const futureDbPath = join(fx.rootDir, 'future-schema.db')
    const srcRoDb = new DatabaseSync(fx.catalogPath, { readOnly: true })
    srcRoDb.exec(`VACUUM INTO '${futureDbPath.replace(/'/g, "''")}'`)
    srcRoDb.close()
    const fdb = new DatabaseSync(futureDbPath)
    fdb.exec(
      "INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (999, 'future', 1)"
    )
    fdb.close()
    const fdbBytes = readFileSync(futureDbPath)
    const fdbSha = sha256Hex(fdbBytes)
    mkdirSync(join(futureSchemaRepo, 'objects', fdbSha.slice(0, 2)), { recursive: true })
    writeFileSync(
      join(futureSchemaRepo, 'objects', fdbSha.slice(0, 2), `${fdbSha}.pvchunk`),
      fdbBytes
    )
    const fSnapPath = join(futureSchemaRepo, 'snapshots', fx.snapshotId, 'snapshot.json')
    const fSnap = JSON.parse(readFileSync(fSnapPath, 'utf8'))
    fSnap.catalogFile = {
      logicalPath: 'vault-catalog.db',
      byteSize: fdbBytes.length,
      sha256: fdbSha,
      chunks: [
        {
          objectId: fdbSha,
          index: 0,
          plaintextByteSize: fdbBytes.length,
          storedByteSize: fdbBytes.length,
          plaintextSha256: fdbSha
        }
      ]
    }
    const fManifestBytes = Buffer.from(JSON.stringify(fSnap, null, 2), 'utf8')
    writeFileSync(fSnapPath, fManifestBytes)
    const fCompletePath = join(futureSchemaRepo, 'snapshots', fx.snapshotId, 'complete.json')
    const fComplete = JSON.parse(readFileSync(fCompletePath, 'utf8'))
    fComplete.manifestSha256 = sha256Hex(fManifestBytes)
    writeFileSync(fCompletePath, JSON.stringify(fComplete, null, 2))
    await expectBothFailClosed(futureSchemaRepo, /schema|version/i)

    // 10. Invalid manifest.json inside backup
    const invalidVaultManifestRepo = cloneBackup('invalid-vault-manifest')
    const ivSnapPath = join(invalidVaultManifestRepo, 'snapshots', fx.snapshotId, 'snapshot.json')
    const ivSnap = JSON.parse(readFileSync(ivSnapPath, 'utf8'))
    const badManifestBytes = Buffer.from('{"invalid": true}', 'utf8')
    const badManifestSha = sha256Hex(badManifestBytes)
    mkdirSync(join(invalidVaultManifestRepo, 'objects', badManifestSha.slice(0, 2)), {
      recursive: true
    })
    writeFileSync(
      join(
        invalidVaultManifestRepo,
        'objects',
        badManifestSha.slice(0, 2),
        `${badManifestSha}.pvchunk`
      ),
      badManifestBytes
    )
    ivSnap.vault.copies[0].manifestFile = {
      logicalPath: ivSnap.vault.copies[0].manifestRelativePath,
      byteSize: badManifestBytes.length,
      sha256: badManifestSha,
      chunks: [
        {
          objectId: badManifestSha,
          index: 0,
          plaintextByteSize: badManifestBytes.length,
          storedByteSize: badManifestBytes.length,
          plaintextSha256: badManifestSha
        }
      ]
    }
    const ivManifestBytes = Buffer.from(JSON.stringify(ivSnap, null, 2), 'utf8')
    writeFileSync(ivSnapPath, ivManifestBytes)
    const ivCompletePath = join(
      invalidVaultManifestRepo,
      'snapshots',
      fx.snapshotId,
      'complete.json'
    )
    const ivComplete = JSON.parse(readFileSync(ivCompletePath, 'utf8'))
    ivComplete.manifestSha256 = sha256Hex(ivManifestBytes)
    writeFileSync(ivCompletePath, JSON.stringify(ivComplete, null, 2))
    await expectBothFailClosed(invalidVaultManifestRepo, /manifest|vault/i)

    // 11. Cancellation via AbortSignal
    const cancelController = new AbortController()
    cancelController.abort()
    const cancelProfile = mkdtempSync(join(fx.rootDir, 'cancel-profile-'))
    const cancelVault = join(fx.rootDir, 'cancel-vault')
    await expect(
      restoreRecoveryPointToIsolatedProfile({
        backupRepoDir: fx.backupDir,
        snapshotId: fx.snapshotId,
        targetProfileDir: cancelProfile,
        targetVaultDir: cancelVault,
        signal: cancelController.signal
      })
    ).rejects.toThrow(/cancel/i)
    expect(existsSync(join(cancelProfile, '.pv-restore-complete.json'))).toBe(false)
  })

  it('T9a–T9e: fails closed at every cross-drive publish boundary and performs scoped retry cleanup', async () => {
    const fx = await createVerifiedBackupFixture()
    activeFixtures.push(fx)

    const sourcesBefore = snapshotDirectoryTree(fx.sourceDir)
    const activeVaultBefore = snapshotDirectoryTree(fx.vaultDir)
    const backupRepoBefore = snapshotDirectoryTree(fx.backupDir)

    const boundaryCases = [
      { name: 'T9a', hookKey: 'onDuringVaultStaging' as const },
      { name: 'T9b', hookKey: 'onAfterVaultPublish' as const },
      { name: 'T9c', hookKey: 'onAfterProfilePublish' as const },
      { name: 'T9d', hookKey: 'onAfterProfileCompleteMarker' as const }
    ]

    for (const tc of boundaryCases) {
      const targetProfileDir = mkdtempSync(join(fx.rootDir, `${tc.name}-profile-`))
      const targetVaultDir = mkdtempSync(join(fx.rootDir, `${tc.name}-vault-`))

      await expect(
        restoreRecoveryPointToIsolatedProfile({
          backupRepoDir: fx.backupDir,
          snapshotId: fx.snapshotId,
          targetProfileDir,
          targetVaultDir,
          hooks: {
            [tc.hookKey]: () => {
              throw new Error(`Injected crash at ${tc.name}`)
            }
          }
        })
      ).rejects.toThrow(`Injected crash at ${tc.name}`)

      const status = inspectRestoredProfileStatus(targetProfileDir, targetVaultDir)
      expect(status.status, `${tc.name} must report interrupted`).toBe('interrupted')

      // Vault opener must refuse incomplete vault on targetVaultDir
      expect(isVaultDirectory(targetVaultDir), `${tc.name} isVaultDirectory must be false`).toBe(
        false
      )
      expect(() => loadVaultIdentity(targetVaultDir)).toThrow(RestoreIncompleteError)

      // Direct retry without cleanup must fail closed
      await expect(
        restoreRecoveryPointToIsolatedProfile({
          backupRepoDir: fx.backupDir,
          snapshotId: fx.snapshotId,
          targetProfileDir,
          targetVaultDir
        })
      ).rejects.toThrow(BackupContainmentError)
    }

    // T9e: Scoped retry via cleanupInterruptedRestoreTarget
    const retryProfileDir = mkdtempSync(join(fx.rootDir, 't9e-profile-'))
    const retryVaultDir = mkdtempSync(join(fx.rootDir, 't9e-vault-'))
    const restoreJobId = 'restore-job-t9e'

    await expect(
      restoreRecoveryPointToIsolatedProfile({
        backupRepoDir: fx.backupDir,
        snapshotId: fx.snapshotId,
        targetProfileDir: retryProfileDir,
        targetVaultDir: retryVaultDir,
        restoreJobId,
        hooks: {
          onAfterProfileCompleteMarker: () => {
            throw new Error('Injected crash at T9d before vault complete marker')
          }
        }
      })
    ).rejects.toThrow('Injected crash at T9d')

    // Refuses cleanup if expectedRestoreJobId mismatches
    expect(() =>
      cleanupInterruptedRestoreTarget({
        targetProfileDir: retryProfileDir,
        targetVaultDir: retryVaultDir,
        expectedRestoreJobId: 'wrong-job-id'
      })
    ).toThrow(BackupRestoreError)

    // Refuses cleanup on a directory with no .pv-restore-in-progress.json
    const unrelatedDir = mkdtempSync(join(fx.rootDir, 'unrelated-'))
    writeFileSync(join(unrelatedDir, 'user-note.txt'), 'keep-me')
    expect(() =>
      cleanupInterruptedRestoreTarget({
        targetProfileDir: unrelatedDir,
        targetVaultDir: null
      })
    ).toThrow(BackupRestoreError)
    expect(existsSync(join(unrelatedDir, 'user-note.txt'))).toBe(true)

    // Plant an unrelated sentinel file in retryProfileDir to verify scoped cleanup touches ONLY restore-owned files
    const sentinelPath = join(retryProfileDir, 'unrelated-sentinel.txt')
    writeFileSync(sentinelPath, 'must-survive-cleanup')

    cleanupInterruptedRestoreTarget({
      targetProfileDir: retryProfileDir,
      targetVaultDir: retryVaultDir,
      expectedRestoreJobId: restoreJobId
    })

    expect(existsSync(sentinelPath)).toBe(true)
    expect(existsSync(join(retryProfileDir, 'vault-catalog.db'))).toBe(false)
    expect(existsSync(join(retryProfileDir, 'annotations'))).toBe(false)
    expect(existsSync(join(retryProfileDir, '.pv-restore-complete.json'))).toBe(false)
    expect(existsSync(join(retryVaultDir, 'vault.json'))).toBe(false)
    expect(existsSync(join(retryVaultDir, '.pv-restore-in-progress.json'))).toBe(false)
    unlinkSync(sentinelPath)

    // Now clean retry succeeds!
    const retried = await restoreRecoveryPointToIsolatedProfile({
      backupRepoDir: fx.backupDir,
      snapshotId: fx.snapshotId,
      targetProfileDir: retryProfileDir,
      targetVaultDir: retryVaultDir
    })
    expect(retried.snapshotId).toBe(fx.snapshotId)
    expect(inspectRestoredProfileStatus(retryProfileDir, retryVaultDir).status).toBe('complete')

    assertDirectoryTreeUnchanged(fx.sourceDir, sourcesBefore, 'originals')
    assertDirectoryTreeUnchanged(fx.vaultDir, activeVaultBefore, 'active vault')
    assertDirectoryTreeUnchanged(fx.backupDir, backupRepoBefore, 'backup repository')
  })

  it('T11-restore: validates restore target containment, non-empty rejection, overlap rejection, UNC repo support, and symlink rejection', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'pv-8b-t11r-'))
    const cleanup = (): void => rmSync(rootDir, { recursive: true, force: true })
    try {
      const backupRepoDir = join(rootDir, 'backup-repo')
      const activeUserDataDir = join(rootDir, 'active-user-data')
      const activeVault = join(rootDir, 'active-vault')
      const activeSource = join(rootDir, 'active-source')
      const targetProfileDir = join(rootDir, 'target-profile')
      const targetVaultDir = join(rootDir, 'target-vault')

      mkdirSync(backupRepoDir, { recursive: true })
      mkdirSync(targetProfileDir, { recursive: true })
      mkdirSync(targetVaultDir, { recursive: true })

      // Valid isolated targets pass
      const validated = validateRestoreTargetPaths({
        targetProfileDir,
        targetVaultDir,
        backupRepoDir,
        activeUserDataDir,
        activeSourceRoots: [activeSource],
        activeVaultRoots: [activeVault]
      })
      expect(validated.targetProfileDir).toBeTruthy()
      expect(validated.targetVaultDir).toBeTruthy()

      // Valid UNC backup repo path accepted
      const validatedUnc = validateRestoreTargetPaths({
        targetProfileDir,
        targetVaultDir,
        backupRepoDir: '\\\\nas-server\\backups\\personal-vault',
        activeUserDataDir,
        activeSourceRoots: [activeSource],
        activeVaultRoots: [activeVault]
      })
      expect(validatedUnc.backupRepoDir).toBe('\\\\nas-server\\backups\\personal-vault')

      // Non-empty targetProfileDir rejected
      writeFileSync(join(targetProfileDir, 'existing.txt'), 'nope')
      expect(() =>
        validateRestoreTargetPaths({
          targetProfileDir,
          targetVaultDir,
          backupRepoDir,
          activeUserDataDir,
          activeSourceRoots: [activeSource],
          activeVaultRoots: [activeVault]
        })
      ).toThrow(BackupContainmentError)
      unlinkSync(join(targetProfileDir, 'existing.txt'))

      // Non-empty targetVaultDir rejected
      writeFileSync(join(targetVaultDir, 'existing.txt'), 'nope')
      expect(() =>
        validateRestoreTargetPaths({
          targetProfileDir,
          targetVaultDir,
          backupRepoDir,
          activeUserDataDir,
          activeSourceRoots: [activeSource],
          activeVaultRoots: [activeVault]
        })
      ).toThrow(BackupContainmentError)
      unlinkSync(join(targetVaultDir, 'existing.txt'))

      // Overlap between targetProfileDir and targetVaultDir rejected
      expect(() =>
        validateRestoreTargetPaths({
          targetProfileDir,
          targetVaultDir: join(targetProfileDir, 'nested-vault'),
          backupRepoDir,
          activeUserDataDir,
          activeSourceRoots: [activeSource],
          activeVaultRoots: [activeVault]
        })
      ).toThrow(BackupContainmentError)

      // Overlap with backupRepoDir, activeUserDataDir, activeVault, activeSource rejected
      for (const badTarget of [
        join(backupRepoDir, 'sub'),
        join(activeUserDataDir, 'sub'),
        join(activeVault, 'sub'),
        join(activeSource, 'sub')
      ]) {
        expect(() =>
          validateRestoreTargetPaths({
            targetProfileDir: badTarget,
            targetVaultDir,
            backupRepoDir,
            activeUserDataDir,
            activeSourceRoots: [activeSource],
            activeVaultRoots: [activeVault]
          })
        ).toThrow(BackupContainmentError)
      }

      // Symlink/junction rejection in targetProfileDir
      const realSub = join(rootDir, 'real-sub')
      const linkSub = join(rootDir, 'link-sub')
      mkdirSync(realSub, { recursive: true })
      symlinkSync(realSub, linkSub, 'junction')
      expect(() =>
        validateRestoreTargetPaths({
          targetProfileDir: join(linkSub, 'profile'),
          targetVaultDir,
          backupRepoDir,
          activeUserDataDir,
          activeSourceRoots: [activeSource],
          activeVaultRoots: [activeVault]
        })
      ).toThrow(BackupContainmentError)
    } finally {
      cleanup()
    }
  })
})
