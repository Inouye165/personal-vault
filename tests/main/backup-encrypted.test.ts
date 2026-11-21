// @vitest-environment node
/**
 * Personal Vault — Stage 8B Slice 3 (Pass 1): Encrypted Backup Format & Local Round-Trip Tests
 *
 * Covers:
 * - AES-256-GCM envelope, scrypt key wrapping, keyed chunk IDs (HMAC-SHA256), and encrypted snapshot.pvenc
 * - Incremental chunk reuse across encrypted backups
 * - Verified restore into a fresh isolated profile
 * - Fail-closed rejection of wrong/missing recovery secrets with zero restored data written
 * - Rejection of tampered chunks, tampered snapshot.pvenc, tampered repository.json, and incomplete snapshots
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BackupRepositoryIdentityV1Schema,
  BackupSnapshotCompleteMarkerV1Schema,
  type BackupEncryptionKdfParams
} from '../../src/shared/validation/backup-schemas'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { initializeVault } from '../../src/main/services/vault/identity'
import { writeVaultManifest } from '../../src/main/services/vault/manifest'
import type { VaultManifest } from '../../src/main/services/vault/types'
import { Aes256GcmObjectCodec } from '../../src/main/services/backup/codec'
import { inspectRecoveryPointStatus, runLocalBackup } from '../../src/main/services/backup/engine'
import { BackupRestoreError, BackupSnapshotError } from '../../src/main/services/backup/errors'
import {
  inspectRestoredProfileStatus,
  listRecoveryPoints,
  restoreRecoveryPointToIsolatedProfile,
  verifyRecoveryPoint
} from '../../src/main/services/backup/restore'
import {
  BACKUP_OBJECTS_DIR,
  BACKUP_REPO_IDENTITY_FILE,
  BACKUP_SNAPSHOT_COMPLETE_FILE,
  BACKUP_SNAPSHOT_ENCRYPTED_MANIFEST_FILE,
  BACKUP_SNAPSHOT_IN_PROGRESS_FILE,
  BACKUP_SNAPSHOT_MANIFEST_FILE,
  BACKUP_SNAPSHOTS_DIR
} from '../../src/main/services/backup/transport'

// Fast scrypt params for synthetic test fixtures while exercising full scrypt KDF path
const TEST_KDF_PARAMS: BackupEncryptionKdfParams = {
  N: 1024,
  r: 8,
  p: 1,
  keyLenBytes: 32
}

const TEST_SECRET = 'correct-horse-battery-staple-pv-8b'
const WRONG_SECRET = 'wrong-secret-should-fail-closed'

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

interface EncryptedFixture {
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
  importedSourceFile: string
}

async function createEncryptedFixture(): Promise<EncryptedFixture> {
  const rootDir = mkdtempSync(join(tmpdir(), 'pv-8b-enc-'))
  const userDataDir = join(rootDir, 'userData')
  const catalogPath = join(userDataDir, 'vault-catalog.db')
  const annotationsDir = join(userDataDir, 'annotations')
  const sourceDir = join(rootDir, 'sources')
  const vaultDir = join(rootDir, 'vault')
  const backupDir = join(rootDir, 'backup-enc')

  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(backupDir, { recursive: true })

  // 4.5 MiB deterministic payload to exercise multi-chunk 4 MiB splitting
  const largeBytes = Buffer.alloc(4 * 1024 * 1024 + 512 * 1024, 0x42)
  largeBytes.write('PV-START-SECRET-MARKER', 0)
  largeBytes.write('PV-END-SECRET-MARKER', largeBytes.length - 20)
  const largeSha256 = sha256Hex(largeBytes)
  const importedSourceFile = join(sourceDir, 'big-photo.tif')
  writeFileSync(importedSourceFile, largeBytes)

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

  const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Encrypted Test Vault' })
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
    rating: 5,
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
    importedSourceFile
  }
}

function collectObjectIds(backupDir: string): string[] {
  const objectsDir = join(backupDir, BACKUP_OBJECTS_DIR)
  if (!existsSync(objectsDir)) return []
  const ids: string[] = []
  for (const prefix of readdirSync(objectsDir)) {
    const subDir = join(objectsDir, prefix)
    for (const file of readdirSync(subDir)) {
      if (file.endsWith('.pvchunk')) {
        ids.push(file.slice(0, -'.pvchunk'.length))
      }
    }
  }
  return ids
}

describe('Stage 8B Slice 3 (Pass 1): Encrypted Backup Format & Local Round-Trip', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()!()
    }
  })

  it('creates an encrypted backup with keyed chunk IDs, snapshot.pvenc, incremental reuse, and isolated restore', async () => {
    const fx = await createEncryptedFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const snap1 = 'snap-enc-001'
    const res1 = await runLocalBackup({
      jobId: 'job-enc-1',
      snapshotId: snap1,
      backupRepoDir: fx.backupDir,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    expect(res1.writtenChunkCount).toBeGreaterThan(0)
    expect(res1.reusedChunkCount).toBe(0)

    // Verify repository.json metadata
    const repoIdentity = BackupRepositoryIdentityV1Schema.parse(
      JSON.parse(readFileSync(join(fx.backupDir, BACKUP_REPO_IDENTITY_FILE), 'utf8'))
    )
    expect(repoIdentity.encryptionMode).toBe('aes-256-gcm-v1')
    expect(repoIdentity.encryption).not.toBeNull()
    expect(repoIdentity.encryption?.kdf).toBe('scrypt')

    // Verify snapshot.pvenc exists and plaintext snapshot.json does NOT exist
    const snap1Dir = join(fx.backupDir, BACKUP_SNAPSHOTS_DIR, snap1)
    expect(existsSync(join(snap1Dir, BACKUP_SNAPSHOT_ENCRYPTED_MANIFEST_FILE))).toBe(true)
    expect(existsSync(join(snap1Dir, BACKUP_SNAPSHOT_MANIFEST_FILE))).toBe(false)

    // Verify encrypted manifest does not leak plaintext strings
    const encManifestRaw = readFileSync(join(snap1Dir, BACKUP_SNAPSHOT_ENCRYPTED_MANIFEST_FILE))
    expect(encManifestRaw.includes(Buffer.from('big-photo.tif', 'utf8'))).toBe(false)
    expect(encManifestRaw.includes(Buffer.from('Encrypted Test Vault', 'utf8'))).toBe(false)

    // Verify complete.json records aes-256-gcm-v1 and matches snapshot.pvenc SHA-256
    const complete1 = BackupSnapshotCompleteMarkerV1Schema.parse(
      JSON.parse(readFileSync(join(snap1Dir, BACKUP_SNAPSHOT_COMPLETE_FILE), 'utf8'))
    )
    expect(complete1.encryptionMode).toBe('aes-256-gcm-v1')
    expect(complete1.manifestSha256).toBe(sha256Hex(encManifestRaw))

    // Verify keyed chunk IDs differ from plaintext chunk SHA-256 and chunks don't leak plaintext markers
    const objectIds = collectObjectIds(fx.backupDir)
    expect(objectIds.length).toBeGreaterThan(0)
    const firstChunkPlainSha = sha256Hex(fx.largeBytes.subarray(0, 4 * 1024 * 1024))
    expect(objectIds).not.toContain(firstChunkPlainSha)
    for (const id of objectIds) {
      const chunkBytes = readFileSync(
        join(fx.backupDir, BACKUP_OBJECTS_DIR, id.slice(0, 2), `${id}.pvchunk`)
      )
      expect(chunkBytes.includes(Buffer.from('PV-START-SECRET-MARKER', 'utf8'))).toBe(false)
    }

    // Incremental backup (snap2) reuses unmodified encrypted chunks via HMAC-SHA256 objectId
    const secondBytes = Buffer.from('second-encrypted-doc-payload', 'utf8')
    const secondSha = sha256Hex(secondBytes)
    const secondPrefix = secondSha.slice(0, 2)
    const secondRel = `files/${secondPrefix}/${secondSha}/note.txt`
    const secondManifestRel = `files/${secondPrefix}/${secondSha}/manifest.json`
    mkdirSync(join(fx.vaultDir, 'files', secondPrefix, secondSha), { recursive: true })
    writeFileSync(join(fx.vaultDir, secondRel), secondBytes)

    const secondSource = join(fx.sourceDir, 'note.txt')
    writeFileSync(secondSource, secondBytes)
    const now2 = Date.now()
    fx.catalog.persistDiscoveryBatch(fx.sourceDir, [
      {
        originalPath: secondSource,
        fileName: 'note.txt',
        extension: '.txt',
        category: 'document',
        byteSize: secondBytes.length,
        birthtimeMs: now2,
        mtimeMs: now2,
        discoveredAtMs: now2
      }
    ])
    const loc2 = fx.catalog
      .queryFileLocations({ limit: 10 })
      .items.find((l) => l.fileName === 'note.txt')!
    fx.catalog.recordHashObservationsBatch([
      {
        originalPath: secondSource,
        sha256: secondSha,
        observedByteSize: secondBytes.length,
        observedMtimeMs: loc2.filesystemMtimeMs,
        hashedAtMs: now2
      }
    ])
    const hashObs2 = fx.catalog.getHashObservationsForFile(loc2.id).items[0]!
    const importJob2 = randomUUID()
    writeVaultManifest(
      fx.vaultDir,
      {
        formatVersion: 1,
        vaultId: fx.vaultId,
        sha256: secondSha,
        byteSize: secondBytes.length,
        managedCopy: {
          relativePath: secondRel,
          fileName: 'note.txt',
          publishedAtMs: now2,
          verifiedSha256: secondSha,
          verifiedByteSize: secondBytes.length
        },
        sources: [
          {
            fileLocationId: loc2.id,
            originalPath: secondSource,
            fileName: 'note.txt',
            extension: '.txt',
            category: 'document',
            recordedFacts: {
              byteSize: secondBytes.length,
              filesystemBirthtimeMs: loc2.filesystemBirthtimeMs,
              filesystemMtimeMs: loc2.filesystemMtimeMs,
              firstDiscoveredAtMs: loc2.firstDiscoveredAtMs,
              lastSeenAtMs: loc2.lastSeenAtMs,
              discoveryObservationId: loc2.discoveryObservationId,
              hashObservationId: hashObs2.id,
              hashVerifiedAtMs: hashObs2.hashedAtMs
            },
            inferredMetadata: { inferredCaptureTimeMs: null },
            reviewDecisions: { isPreferred: false, duplicateReviewStatus: null },
            importResult: {
              importJobId: importJob2,
              importedAtMs: now2,
              verifiedSourceSha256: secondSha,
              verifiedSourceByteSize: secondBytes.length,
              sourceStability: {
                preCopyMtimeMs: loc2.filesystemMtimeMs ?? 0,
                postCopyMtimeMs: loc2.filesystemMtimeMs ?? 0,
                preCopyByteSize: secondBytes.length,
                postCopyByteSize: secondBytes.length
              }
            }
          }
        ]
      },
      importJob2
    )
    const copyRecord2 = fx.catalog.recordVaultCopy({
      vaultId: fx.vaultId,
      sha256: secondSha,
      byteSize: secondBytes.length,
      relativePath: secondRel,
      manifestRelativePath: secondManifestRel,
      verifiedAtMs: now2
    })
    fx.catalog.createVaultImportJob({
      jobId: importJob2,
      vaultId: fx.vaultId,
      totalFiles: 1,
      totalBytes: secondBytes.length,
      items: [
        {
          fileLocationId: loc2.id,
          discoveryObservationId: loc2.discoveryObservationId,
          hashObservationId: hashObs2.id,
          sha256: secondSha,
          byteSize: secondBytes.length
        }
      ]
    })
    fx.catalog.updateVaultImportItem({
      jobId: importJob2,
      fileLocationId: loc2.id,
      status: 'completed',
      vaultCopyId: copyRecord2.id,
      completedAtMs: now2
    })
    fx.catalog.updateVaultImportStatus(importJob2, 'completed')

    const snap2 = 'snap-enc-002'
    const res2 = await runLocalBackup({
      jobId: 'job-enc-2',
      snapshotId: snap2,
      backupRepoDir: fx.backupDir,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    // The 2 chunks of big-photo.tif + unchanged owner marker + unchanged vault.json + manifest.json are reused
    expect(res2.reusedChunkCount).toBeGreaterThanOrEqual(2)
    expect(res2.writtenChunkCount).toBeGreaterThan(0)

    // Inspect & list recovery points: unauthenticated listing confirms completion marker & ciphertext checksum
    // without claiming verified object integrity
    const unauth1 = inspectRecoveryPointStatus(fx.backupDir, snap1)
    expect(unauth1.isComplete).toBe(true)
    expect(unauth1.integrityStatus).toBe('sealed_unverified')
    expect(unauth1.checked).toEqual({
      completionMarker: true,
      manifestChecksum: true,
      objectPresenceAndSizes: false
    })
    expect(inspectRecoveryPointStatus(fx.backupDir, snap2).integrityStatus).toBe(
      'sealed_unverified'
    )
    const listed = listRecoveryPoints(fx.backupDir)
    expect(listed.recoveryPoints).toHaveLength(2)
    expect(listed.recoveryPoints.every((p) => p.isComplete)).toBe(true)
    expect(listed.recoveryPoints.every((p) => p.integrityStatus === 'sealed_unverified')).toBe(true)

    // Verify recovery point with correct secret
    const verified = await verifyRecoveryPoint({
      backupRepoDir: fx.backupDir,
      snapshotId: snap2,
      recoverySecret: TEST_SECRET
    })
    expect(verified.snapshotId).toBe(snap2)
    expect(verified.hasVault).toBe(true)
    expect(verified.hasAnnotations).toBe(true)

    // Restore snap2 into a fresh isolated profile
    const targetProfileDir = join(fx.rootDir, 'restored-profile')
    const targetVaultDir = join(fx.rootDir, 'restored-vault')
    const restored = await restoreRecoveryPointToIsolatedProfile({
      backupRepoDir: fx.backupDir,
      snapshotId: snap2,
      targetProfileDir,
      targetVaultDir,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir],
      recoverySecret: TEST_SECRET
    })

    expect(restored.snapshotId).toBe(snap2)
    expect(inspectRestoredProfileStatus(targetProfileDir, targetVaultDir).status).toBe('complete')

    const restoredLargePath = join(
      targetVaultDir,
      'files',
      fx.largeSha256.slice(0, 2),
      fx.largeSha256,
      'big-photo.tif'
    )
    expect(sha256Hex(readFileSync(restoredLargePath))).toBe(fx.largeSha256)
    expect(sha256Hex(readFileSync(join(targetVaultDir, secondRel)))).toBe(secondSha)

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
      const copies = restoredCatalog.getVaultCopiesForVault(fx.vaultId)
      expect(copies).toHaveLength(2)
      const activeVault = restoredCatalog.getActiveVault()
      expect(activeVault?.vaultPath).toBe(targetVaultDir)
      const restoredLoc = restoredCatalog
        .queryFileLocations({ limit: 10 })
        .items.find((l) => l.fileName === 'big-photo.tif')!
      expect(restoredLoc.rating).toBe(5)
      expect(restoredLoc.flag).toBe('pick')
    } finally {
      restoredCatalog.close()
    }
  })

  it('rejects wrong and missing recovery secrets without writing any restored data', async () => {
    const fx = await createEncryptedFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const snap1 = 'snap-enc-secret-check'
    await runLocalBackup({
      jobId: 'job-enc-secret-1',
      snapshotId: snap1,
      backupRepoDir: fx.backupDir,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    // Wrong secret on verify
    await expect(
      verifyRecoveryPoint({
        backupRepoDir: fx.backupDir,
        snapshotId: snap1,
        recoverySecret: WRONG_SECRET
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupRestoreError && err.code === 'wrong_recovery_secret'
    )

    // Missing secret on verify
    await expect(
      verifyRecoveryPoint({
        backupRepoDir: fx.backupDir,
        snapshotId: snap1
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupRestoreError && err.code === 'recovery_secret_required'
    )

    // Wrong secret on restore must write ZERO restored directories or files
    const targetProfileDir = join(fx.rootDir, 'wrong-secret-profile')
    const targetVaultDir = join(fx.rootDir, 'wrong-secret-vault')
    await expect(
      restoreRecoveryPointToIsolatedProfile({
        backupRepoDir: fx.backupDir,
        snapshotId: snap1,
        targetProfileDir,
        targetVaultDir,
        activeUserDataDir: fx.userDataDir,
        activeSourceRoots: [fx.sourceDir],
        activeVaultRoots: [fx.vaultDir],
        recoverySecret: WRONG_SECRET
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupRestoreError && err.code === 'wrong_recovery_secret'
    )

    expect(existsSync(targetProfileDir)).toBe(false)
    expect(existsSync(targetVaultDir)).toBe(false)

    // Wrong secret on incremental backup must fail closed before creating snapshot dir
    await expect(
      runLocalBackup({
        jobId: 'job-enc-wrong-append',
        snapshotId: 'snap-enc-wrong-append',
        backupRepoDir: fx.backupDir,
        catalogPath: fx.catalogPath,
        annotationsDir: fx.annotationsDir,
        userDataDir: fx.userDataDir,
        sourceRoots: [fx.sourceDir],
        vaultRoots: [fx.vaultDir],
        appVersion: '0.1.0-test',
        encryptionMode: 'aes-256-gcm-v1',
        recoverySecret: WRONG_SECRET,
        kdfParams: TEST_KDF_PARAMS
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'wrong_recovery_secret'
    )
    expect(existsSync(join(fx.backupDir, BACKUP_SNAPSHOTS_DIR, 'snap-enc-wrong-append'))).toBe(
      false
    )
  })

  it('rejects tampered chunks, tampered snapshot.pvenc, tampered repository.json, and incomplete snapshots', async () => {
    const fx = await createEncryptedFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const snap1 = 'snap-enc-tamper'
    await runLocalBackup({
      jobId: 'job-enc-tamper',
      snapshotId: snap1,
      backupRepoDir: fx.backupDir,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    // 1. Tamper a chunk byte -> verify fails with chunk_corrupt
    const objectIds = collectObjectIds(fx.backupDir)
    const targetObjId = objectIds[0]!
    const targetObjPath = join(
      fx.backupDir,
      BACKUP_OBJECTS_DIR,
      targetObjId.slice(0, 2),
      `${targetObjId}.pvchunk`
    )
    const originalChunk = readFileSync(targetObjPath)
    const tamperedChunk = Buffer.from(originalChunk)
    const chunkLastIdx = tamperedChunk.length - 1
    tamperedChunk[chunkLastIdx] = (tamperedChunk[chunkLastIdx] ?? 0) ^ 0xff
    writeFileSync(targetObjPath, tamperedChunk)

    await expect(
      verifyRecoveryPoint({
        backupRepoDir: fx.backupDir,
        snapshotId: snap1,
        recoverySecret: TEST_SECRET
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupRestoreError && err.code === 'chunk_corrupt'
    )
    // Restore original chunk before next tamper test
    writeFileSync(targetObjPath, originalChunk)

    // 2. Tamper snapshot.pvenc byte -> manifest_hash_mismatch
    const snapDir = join(fx.backupDir, BACKUP_SNAPSHOTS_DIR, snap1)
    const encManifestPath = join(snapDir, BACKUP_SNAPSHOT_ENCRYPTED_MANIFEST_FILE)
    const originalManifest = readFileSync(encManifestPath)
    const tamperedManifest = Buffer.from(originalManifest)
    const manifestLastIdx = tamperedManifest.length - 1
    tamperedManifest[manifestLastIdx] = (tamperedManifest[manifestLastIdx] ?? 0) ^ 0x01
    writeFileSync(encManifestPath, tamperedManifest)

    expect(inspectRecoveryPointStatus(fx.backupDir, snap1).reasons).toContain(
      'manifest_hash_mismatch'
    )
    await expect(
      verifyRecoveryPoint({
        backupRepoDir: fx.backupDir,
        snapshotId: snap1,
        recoverySecret: TEST_SECRET
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupRestoreError && err.code === 'manifest_hash_mismatch'
    )

    // Even if complete.json manifestSha256 is updated to match tampered snapshot.pvenc, GCM auth fails -> manifest_invalid
    const completePath = join(snapDir, BACKUP_SNAPSHOT_COMPLETE_FILE)
    const originalComplete = readFileSync(completePath, 'utf8')
    const parsedComplete = JSON.parse(originalComplete) as Record<string, unknown>
    parsedComplete.manifestSha256 = sha256Hex(tamperedManifest)
    writeFileSync(completePath, JSON.stringify(parsedComplete, null, 2), 'utf8')

    await expect(
      verifyRecoveryPoint({
        backupRepoDir: fx.backupDir,
        snapshotId: snap1,
        recoverySecret: TEST_SECRET
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupRestoreError && err.code === 'manifest_invalid'
    )
    writeFileSync(encManifestPath, originalManifest)
    writeFileSync(completePath, originalComplete, 'utf8')

    // 3. Incomplete snapshot: .pv-snapshot-in-progress.json present -> recovery_point_incomplete
    const inProgPath = join(snapDir, BACKUP_SNAPSHOT_IN_PROGRESS_FILE)
    writeFileSync(inProgPath, '{"incomplete":true}', 'utf8')
    expect(inspectRecoveryPointStatus(fx.backupDir, snap1).isComplete).toBe(false)
    await expect(
      restoreRecoveryPointToIsolatedProfile({
        backupRepoDir: fx.backupDir,
        snapshotId: snap1,
        targetProfileDir: join(fx.rootDir, 'incomplete-profile'),
        targetVaultDir: join(fx.rootDir, 'incomplete-vault'),
        recoverySecret: TEST_SECRET
      })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof BackupRestoreError && err.code === 'recovery_point_incomplete'
    )
    unlinkSync(inProgPath)

    // 4. Tamper repository.json keyCheckTagBase64 -> wrong_recovery_secret
    const repoPath = join(fx.backupDir, BACKUP_REPO_IDENTITY_FILE)
    const originalRepoRaw = readFileSync(repoPath, 'utf8')
    const tamperedRepo = JSON.parse(originalRepoRaw) as {
      encryption: { keyCheckTagBase64: string }
    }
    const tagBuf = Buffer.from(tamperedRepo.encryption.keyCheckTagBase64, 'base64')
    tagBuf[0] = (tagBuf[0] ?? 0) ^ 0xff
    tamperedRepo.encryption.keyCheckTagBase64 = tagBuf.toString('base64')
    writeFileSync(repoPath, JSON.stringify(tamperedRepo, null, 2), 'utf8')

    await expect(
      verifyRecoveryPoint({
        backupRepoDir: fx.backupDir,
        snapshotId: snap1,
        recoverySecret: TEST_SECRET
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupRestoreError && err.code === 'wrong_recovery_secret'
    )
  })

  it('rejects a write codec from another encrypted repository and preserves prior snapshot', async () => {
    const fx = await createEncryptedFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const snap1 = 'snap-enc-bound-1'
    await runLocalBackup({
      jobId: 'job-enc-bound-1',
      snapshotId: snap1,
      backupRepoDir: fx.backupDir,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    const foreign = await Aes256GcmObjectCodec.createForNewRepository({
      repositoryId: randomUUID(),
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    await expect(
      runLocalBackup({
        jobId: 'job-enc-foreign',
        snapshotId: 'snap-enc-foreign',
        backupRepoDir: fx.backupDir,
        catalogPath: fx.catalogPath,
        annotationsDir: fx.annotationsDir,
        userDataDir: fx.userDataDir,
        sourceRoots: [fx.sourceDir],
        vaultRoots: [fx.vaultDir],
        appVersion: '0.1.0-test',
        encryptionMode: 'aes-256-gcm-v1',
        codec: foreign.codec
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'wrong_recovery_secret'
    )

    expect(existsSync(join(fx.backupDir, BACKUP_SNAPSHOTS_DIR, 'snap-enc-foreign'))).toBe(false)

    // Prior snapshot still restores cleanly
    const targetProfileDir = join(fx.rootDir, 'bound-restore-profile')
    const targetVaultDir = join(fx.rootDir, 'bound-restore-vault')
    const restored = await restoreRecoveryPointToIsolatedProfile({
      backupRepoDir: fx.backupDir,
      snapshotId: snap1,
      targetProfileDir,
      targetVaultDir,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir],
      recoverySecret: TEST_SECRET
    })
    expect(restored.snapshotId).toBe(snap1)
    expect(inspectRestoredProfileStatus(targetProfileDir, targetVaultDir).status).toBe('complete')
  })

  it('rejects invalid/excessive scrypt parameters and mismatched complete.json encryptionMode without creating restore targets', async () => {
    const fx = await createEncryptedFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    // Invalid kdfParams on backup creation
    await expect(
      runLocalBackup({
        jobId: 'job-bad-kdf',
        snapshotId: 'snap-bad-kdf',
        backupRepoDir: join(fx.rootDir, 'bad-kdf-repo'),
        catalogPath: fx.catalogPath,
        annotationsDir: fx.annotationsDir,
        userDataDir: fx.userDataDir,
        sourceRoots: [fx.sourceDir],
        vaultRoots: [fx.vaultDir],
        appVersion: '0.1.0-test',
        encryptionMode: 'aes-256-gcm-v1',
        recoverySecret: TEST_SECRET,
        kdfParams: { N: 1000, r: 8, p: 1, keyLenBytes: 32 }
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'backup_staging_error'
    )

    const snap1 = 'snap-enc-kdf-meta'
    await runLocalBackup({
      jobId: 'job-enc-kdf-meta',
      snapshotId: snap1,
      backupRepoDir: fx.backupDir,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    // 1. Mismatched encryptionMode in complete.json -> rejected by inspection, verify, and restore
    const completePath = join(
      fx.backupDir,
      BACKUP_SNAPSHOTS_DIR,
      snap1,
      BACKUP_SNAPSHOT_COMPLETE_FILE
    )
    const originalCompleteRaw = readFileSync(completePath, 'utf8')
    const mismatchedComplete = JSON.parse(originalCompleteRaw) as { encryptionMode: string }
    mismatchedComplete.encryptionMode = 'none'
    writeFileSync(completePath, JSON.stringify(mismatchedComplete, null, 2), 'utf8')

    const mismatchInspection = inspectRecoveryPointStatus(fx.backupDir, snap1)
    expect(mismatchInspection.isComplete).toBe(false)
    expect(mismatchInspection.integrityStatus).toBe('incomplete')
    expect(mismatchInspection.reasons).toContain('completion_marker_invalid')

    await expect(
      verifyRecoveryPoint({
        backupRepoDir: fx.backupDir,
        snapshotId: snap1,
        recoverySecret: TEST_SECRET
      })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof BackupRestoreError && err.code === 'recovery_point_incomplete'
    )
    writeFileSync(completePath, originalCompleteRaw, 'utf8')

    // 2. Malformed/excessive scrypt parameters in repository.json -> typed error, no restore targets created
    const repoPath = join(fx.backupDir, BACKUP_REPO_IDENTITY_FILE)
    const originalRepoRaw = readFileSync(repoPath, 'utf8')

    for (const badParams of [
      { N: 1000, r: 8, p: 1, keyLenBytes: 32 }, // non-power-of-2 N
      { N: 1048576, r: 8, p: 1, keyLenBytes: 32 }, // excessive memory (1 GiB)
      { N: 1024, r: 100, p: 1, keyLenBytes: 32 } // excessive r
    ]) {
      const repoJson = JSON.parse(originalRepoRaw) as {
        encryption: { kdfParams: Record<string, number> }
      }
      repoJson.encryption.kdfParams = badParams
      writeFileSync(repoPath, JSON.stringify(repoJson, null, 2), 'utf8')

      const targetProfileDir = join(fx.rootDir, `bad-kdf-profile-${badParams.N}-${badParams.r}`)
      const targetVaultDir = join(fx.rootDir, `bad-kdf-vault-${badParams.N}-${badParams.r}`)

      await expect(
        restoreRecoveryPointToIsolatedProfile({
          backupRepoDir: fx.backupDir,
          snapshotId: snap1,
          targetProfileDir,
          targetVaultDir,
          recoverySecret: TEST_SECRET
        })
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof BackupRestoreError && err.code === 'repository_invalid'
      )

      expect(existsSync(targetProfileDir)).toBe(false)
      expect(existsSync(targetVaultDir)).toBe(false)
    }
  })

  it('never labels a same-size corrupted encrypted chunk as verified during inspection and rejects it on full verification', async () => {
    const fx = await createEncryptedFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const snap1 = 'snap-enc-same-size-corrupt'
    await runLocalBackup({
      jobId: 'job-enc-same-size',
      snapshotId: snap1,
      backupRepoDir: fx.backupDir,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    // Decrypt manifest so we can also exercise inspectRecoveryPointStatus with manifest provided
    const repoIdentity = BackupRepositoryIdentityV1Schema.parse(
      JSON.parse(readFileSync(join(fx.backupDir, BACKUP_REPO_IDENTITY_FILE), 'utf8'))
    )
    const codec = await Aes256GcmObjectCodec.unlockFromRepository({
      repositoryId: repoIdentity.repositoryId,
      encryption: repoIdentity.encryption,
      recoverySecret: TEST_SECRET,
      errorDomain: 'restore'
    })
    const encManifestBytes = readFileSync(
      join(fx.backupDir, BACKUP_SNAPSHOTS_DIR, snap1, BACKUP_SNAPSHOT_ENCRYPTED_MANIFEST_FILE)
    )
    const decryptedManifest = JSON.parse(
      (await codec.decodeManifest(encManifestBytes, snap1)).toString('utf8')
    )

    // Flip a byte in an encrypted chunk without changing its byte size
    const objectIds = collectObjectIds(fx.backupDir)
    const targetObjId = objectIds[0]!
    const targetObjPath = join(
      fx.backupDir,
      BACKUP_OBJECTS_DIR,
      targetObjId.slice(0, 2),
      `${targetObjId}.pvchunk`
    )
    const originalChunk = readFileSync(targetObjPath)
    const mutatedChunk = Buffer.from(originalChunk)
    const midIdx = Math.floor(mutatedChunk.length / 2)
    mutatedChunk[midIdx] = (mutatedChunk[midIdx] ?? 0) ^ 0xff
    expect(mutatedChunk.length).toBe(originalChunk.length)
    writeFileSync(targetObjPath, mutatedChunk)

    // Unauthenticated inspection & listing never claim 'verified'
    const unauthInspection = inspectRecoveryPointStatus(fx.backupDir, snap1)
    expect(unauthInspection.integrityStatus).toBe('sealed_unverified')
    expect(unauthInspection.checked).toEqual({
      completionMarker: true,
      manifestChecksum: true,
      objectPresenceAndSizes: false
    })
    const listed = listRecoveryPoints(fx.backupDir)
    expect(listed.recoveryPoints[0]?.integrityStatus).toBe('sealed_unverified')

    // Structural inspection with unlocked manifest reports 'structurally_complete' (not 'verified')
    const structuralInspection = inspectRecoveryPointStatus(fx.backupDir, snap1, {
      manifest: decryptedManifest
    })
    expect(structuralInspection.integrityStatus).toBe('structurally_complete')
    expect(structuralInspection.checked).toEqual({
      completionMarker: true,
      manifestChecksum: true,
      objectPresenceAndSizes: true
    })

    // Full content verification & restore reject the same-size corrupted chunk with 'chunk_corrupt'
    await expect(
      verifyRecoveryPoint({
        backupRepoDir: fx.backupDir,
        snapshotId: snap1,
        recoverySecret: TEST_SECRET
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupRestoreError && err.code === 'chunk_corrupt'
    )

    await expect(
      restoreRecoveryPointToIsolatedProfile({
        backupRepoDir: fx.backupDir,
        snapshotId: snap1,
        targetProfileDir: join(fx.rootDir, 'same-size-corrupt-profile'),
        targetVaultDir: join(fx.rootDir, 'same-size-corrupt-vault'),
        recoverySecret: TEST_SECRET
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupRestoreError && err.code === 'chunk_corrupt'
    )
  })
})
