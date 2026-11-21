// @vitest-environment node
/**
 * Personal Vault — Stage 8B Sub-slice 1A-1: Snapshot Capture & Schema Tests
 *
 * Covers:
 * - T2: Concurrent WAL & AnnotationJournal writes, missing/truncated journal rejection,
 *       sequence gaps, and duplicate-import manifest.json skew detection.
 * - T10: Missing, unreadable, or corrupt vault files and manifests fail closed.
 * - T11-capture: Staging/source/vault overlap and symlink/junction rejection.
 * - T12: Slice 3 encrypted-repository metadata validation and completion-marker privacy.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  BackupStagingManifestV1Schema
} from '../../src/shared/validation/backup-schemas'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { initializeVault } from '../../src/main/services/vault/identity'
import { writeVaultManifest } from '../../src/main/services/vault/manifest'
import type { VaultManifest } from '../../src/main/services/vault/types'
import { BackupContainmentError } from '../../src/main/services/backup/errors'
import { validateBackupStagingDir } from '../../src/main/services/backup/containment'
import { captureConsistentBackupSnapshot } from '../../src/main/services/backup/snapshot-capture'

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

interface FixtureProfile {
  rootDir: string
  userDataDir: string
  catalogPath: string
  annotationsDir: string
  sourceDir: string
  vaultDir: string
  stagingDir: string
  catalog: CatalogDatabase
  journal: AnnotationJournal
  vaultId: string
  fileLocationId: number
  discoveryObservationId: number
  hashObservationId: number
  sampleSha256: string
  sampleBytes: Buffer
  sampleVaultFilePath: string
  sampleManifestPath: string
}

async function createFixtureProfile(): Promise<FixtureProfile> {
  const rootDir = mkdtempSync(join(tmpdir(), 'pv-8b-1a1-'))
  const userDataDir = join(rootDir, 'userData')
  const catalogPath = join(userDataDir, 'vault-catalog.db')
  const annotationsDir = join(userDataDir, 'annotations')
  const sourceDir = join(rootDir, 'sources')
  const vaultDir = join(rootDir, 'vault')
  const stagingDir = join(userDataDir, '.backup-staging', 'job-1')

  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })

  const sampleBytes = Buffer.from('personal-vault-stage-8b-sample-photo-bytes', 'utf8')
  const sampleSha256 = sha256Hex(sampleBytes)
  const sourceFile = join(sourceDir, 'IMG_0001.jpg')
  writeFileSync(sourceFile, sampleBytes)

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
      originalPath: sourceFile,
      fileName: 'IMG_0001.jpg',
      extension: '.jpg',
      category: 'photo',
      byteSize: sampleBytes.length,
      birthtimeMs: now - 5000,
      mtimeMs: now - 5000,
      discoveredAtMs: now
    }
  ])

  const files = catalog.queryFileLocations({ limit: 10 }).items
  const loc = files[0]!
  catalog.recordHashObservationsBatch([
    {
      originalPath: sourceFile,
      sha256: sampleSha256,
      observedByteSize: sampleBytes.length,
      observedMtimeMs: loc.filesystemMtimeMs,
      hashedAtMs: now
    }
  ])

  const hashObs = catalog.getHashObservationsForFile(loc.id).items[0]!
  const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Test Vault' })
  catalog.registerVault({
    vaultId: identity.vaultId,
    vaultPath: vaultDir,
    name: identity.vaultName,
    createdAtMs: identity.createdAtMs
  })

  const prefix = sampleSha256.slice(0, 2)
  const payloadRel = `files/${prefix}/${sampleSha256}/IMG_0001.jpg`
  const manifestRel = `files/${prefix}/${sampleSha256}/manifest.json`
  const sampleVaultFilePath = join(vaultDir, payloadRel)
  const sampleManifestPath = join(vaultDir, manifestRel)
  mkdirSync(join(vaultDir, 'files', prefix, sampleSha256), { recursive: true })
  writeFileSync(sampleVaultFilePath, sampleBytes)

  const importJobId = randomUUID()
  const manifest: VaultManifest = {
    formatVersion: 1,
    vaultId: identity.vaultId,
    sha256: sampleSha256,
    byteSize: sampleBytes.length,
    managedCopy: {
      relativePath: payloadRel,
      fileName: 'IMG_0001.jpg',
      publishedAtMs: now,
      verifiedSha256: sampleSha256,
      verifiedByteSize: sampleBytes.length
    },
    sources: [
      {
        fileLocationId: loc.id,
        originalPath: sourceFile,
        fileName: 'IMG_0001.jpg',
        extension: '.jpg',
        category: 'photo',
        recordedFacts: {
          byteSize: sampleBytes.length,
          filesystemBirthtimeMs: loc.filesystemBirthtimeMs,
          filesystemMtimeMs: loc.filesystemMtimeMs,
          firstDiscoveredAtMs: loc.firstDiscoveredAtMs,
          lastSeenAtMs: loc.lastSeenAtMs,
          discoveryObservationId: loc.discoveryObservationId,
          hashObservationId: hashObs.id,
          hashVerifiedAtMs: hashObs.hashedAtMs
        },
        inferredMetadata: {
          inferredCaptureTimeMs: null
        },
        reviewDecisions: {
          isPreferred: false,
          duplicateReviewStatus: null
        },
        importResult: {
          importJobId,
          importedAtMs: now,
          verifiedSourceSha256: sampleSha256,
          verifiedSourceByteSize: sampleBytes.length,
          sourceStability: {
            preCopyMtimeMs: loc.filesystemMtimeMs ?? 0,
            postCopyMtimeMs: loc.filesystemMtimeMs ?? 0,
            preCopyByteSize: sampleBytes.length,
            postCopyByteSize: sampleBytes.length
          }
        }
      }
    ]
  }
  writeVaultManifest(vaultDir, manifest, importJobId)

  const copyRecord = catalog.recordVaultCopy({
    vaultId: identity.vaultId,
    sha256: sampleSha256,
    byteSize: sampleBytes.length,
    relativePath: payloadRel,
    manifestRelativePath: manifestRel,
    verifiedAtMs: now
  })
  catalog.createVaultImportJob({
    jobId: importJobId,
    vaultId: identity.vaultId,
    totalFiles: 1,
    totalBytes: sampleBytes.length,
    items: [
      {
        fileLocationId: loc.id,
        discoveryObservationId: loc.discoveryObservationId,
        hashObservationId: hashObs.id,
        sha256: sampleSha256,
        byteSize: sampleBytes.length
      }
    ]
  })
  catalog.updateVaultImportItem({
    jobId: importJobId,
    fileLocationId: loc.id,
    status: 'completed',
    vaultCopyId: copyRecord.id,
    completedAtMs: now
  })
  catalog.updateVaultImportStatus(importJobId, 'completed')

  // Initial user annotation in journal + SQLite
  catalog.setPhotoAnnotation({
    fileLocationId: loc.id,
    expectedRevision: `rev:${loc.discoveryObservationId}:${sampleBytes.length}:${loc.filesystemMtimeMs}:${sampleSha256}`,
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
    stagingDir,
    catalog,
    journal,
    vaultId: identity.vaultId,
    fileLocationId: loc.id,
    discoveryObservationId: loc.discoveryObservationId,
    hashObservationId: hashObs.id,
    sampleSha256,
    sampleBytes,
    sampleVaultFilePath,
    sampleManifestPath
  }
}

describe('Stage 8B Sub-slice 1A-1: Consistent Snapshot Capture & Schemas', () => {
  let fixture: FixtureProfile | null = null

  beforeEach(async () => {
    fixture = await createFixtureProfile()
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

  it('T2a: captures consistent WAL SQLite snapshot, journal prefix, and vault manifests under concurrent writes', async () => {
    const f = fixture!
    const loc = f.catalog.queryFileLocations({ limit: 10 }).items[0]!
    const rev = `rev:${loc.discoveryObservationId}:${loc.byteSize}:${loc.filesystemMtimeMs}:${loc.activeHash}`
    const initialJournalSeq = f.journal.getLatestSeq()

    const result = await captureConsistentBackupSnapshot(
      {
        jobId: 'job-1',
        snapshotId: 'snap-002',
        catalogPath: f.catalogPath,
        annotationsDir: f.annotationsDir,
        stagingDir: f.stagingDir,
        userDataDir: f.userDataDir,
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir]
      },
      {
        onAfterSqliteSnapshot: () => {
          f.catalog.createCollection({ name: 'Post-Snapshot Collection' })
          f.catalog.setPhotoAnnotation({
            fileLocationId: loc.id,
            expectedRevision: rev,
            expectedVersion: 1,
            rating: 2,
            flag: 'reject'
          })
        }
      }
    )

    const parsed = BackupStagingManifestV1Schema.parse(result.stagingManifest)
    expect(parsed.annotations).not.toBeNull()
    expect(parsed.annotations!.cutSeq).toBe(initialJournalSeq)
    expect(parsed.annotations!.requiredJournalSeq).toBeLessThanOrEqual(initialJournalSeq)

    const stagedJournalPath = join(f.stagingDir, parsed.annotations!.journalRelativePath)
    const stagedLines = readFileSync(stagedJournalPath, 'utf8').trim().split('\n')
    expect(stagedLines.length).toBe(initialJournalSeq)
    expect(readFileSync(stagedJournalPath, 'utf8')).not.toContain('Post-Snapshot Collection')

    // Staged SQLite has T0 rating (5, pick) and zero post-snapshot collection
    const stagedDb = CatalogDatabase.open({
      catalogPath: join(f.stagingDir, parsed.catalog.stagedRelativePath),
      readOnly: true
    })
    try {
      const stagedLoc = stagedDb.queryFileLocations({ limit: 10 }).items[0]!
      expect(stagedLoc.rating).toBe(5)
      expect(stagedLoc.flag).toBe('pick')
      expect(stagedDb.listCollections().totalCount).toBe(0)
    } finally {
      stagedDb.close()
    }

    // Staged manifest matches exact source manifest bytes & hash
    expect(parsed.vault).not.toBeNull()
    expect(parsed.vault!.copies).toHaveLength(1)
    const stagedManifestBytes = readFileSync(
      join(f.stagingDir, parsed.vault!.copies[0]!.stagedManifestRelativePath)
    )
    expect(sha256Hex(stagedManifestBytes)).toBe(parsed.vault!.copies[0]!.manifestSha256)
    expect(stagedManifestBytes).toEqual(readFileSync(f.sampleManifestPath))

    // Source vault bytes untouched
    expect(readFileSync(f.sampleVaultFilePath)).toEqual(f.sampleBytes)
  })

  it('T2b: fails closed on missing owner marker, missing journal, sequence gap, or truncated journal', async () => {
    const f = fixture!
    // Add a second committed operation so requiredJournalSeq >= 3
    f.catalog.createCollection({ name: 'Second Op Collection' })

    // 1. Missing owner marker
    rmSync(join(f.annotationsDir, '.pv_annotations_owner'))
    await expect(
      captureConsistentBackupSnapshot({
        jobId: 'job-err-1',
        snapshotId: 'snap-err-1',
        catalogPath: f.catalogPath,
        annotationsDir: f.annotationsDir,
        stagingDir: join(f.userDataDir, '.backup-staging', 'job-err-1'),
        userDataDir: f.userDataDir,
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir]
      })
    ).rejects.toMatchObject({ code: 'journal_corruption_error' })

    // Restore marker, then delete journal file
    writeFileSync(
      join(f.annotationsDir, '.pv_annotations_owner'),
      JSON.stringify({
        app: 'personal-vault',
        format: 'personal-vault-review-journal',
        version: '1.0.0'
      })
    )
    const journalPath = join(f.annotationsDir, 'review-journal.jsonl')
    const originalJournal = readFileSync(journalPath, 'utf8')
    rmSync(journalPath)

    await expect(
      captureConsistentBackupSnapshot({
        jobId: 'job-err-2',
        snapshotId: 'snap-err-2',
        catalogPath: f.catalogPath,
        annotationsDir: f.annotationsDir,
        stagingDir: join(f.userDataDir, '.backup-staging', 'job-err-2'),
        userDataDir: f.userDataDir,
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir]
      })
    ).rejects.toMatchObject({ code: 'journal_corruption_error' })

    // 3. Truncated journal (ends at seq 2, before requiredJournalSeq = 3)
    const lines = originalJournal.trim().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(4)
    writeFileSync(journalPath, lines.slice(0, 2).join('\n') + '\n')
    await expect(
      captureConsistentBackupSnapshot({
        jobId: 'job-err-3',
        snapshotId: 'snap-err-3',
        catalogPath: f.catalogPath,
        annotationsDir: f.annotationsDir,
        stagingDir: join(f.userDataDir, '.backup-staging', 'job-err-3'),
        userDataDir: f.userDataDir,
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir]
      })
    ).rejects.toMatchObject({ code: 'journal_corruption_error' })

    // 4. Sequence gap
    const entry1 = JSON.parse(lines[0]!) as { entrySeq: number }
    const entry2 = JSON.parse(lines[1]!) as { entrySeq: number }
    entry2.entrySeq = 99
    writeFileSync(journalPath, JSON.stringify(entry1) + '\n' + JSON.stringify(entry2) + '\n')
    await expect(
      captureConsistentBackupSnapshot({
        jobId: 'job-err-4',
        snapshotId: 'snap-err-4',
        catalogPath: f.catalogPath,
        annotationsDir: f.annotationsDir,
        stagingDir: join(f.userDataDir, '.backup-staging', 'job-err-4'),
        userDataDir: f.userDataDir,
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir]
      })
    ).rejects.toMatchObject({ code: 'journal_corruption_error' })
  })

  it('T2c: detects concurrent duplicate-import manifest.json skew against staged T0 catalog', async () => {
    const f = fixture!
    const extraSource = join(f.sourceDir, 'IMG_0001_copy.jpg')
    writeFileSync(extraSource, f.sampleBytes)

    await expect(
      captureConsistentBackupSnapshot(
        {
          jobId: 'job-skew',
          snapshotId: 'snap-skew',
          catalogPath: f.catalogPath,
          annotationsDir: f.annotationsDir,
          stagingDir: join(f.userDataDir, '.backup-staging', 'job-skew'),
          userDataDir: f.userDataDir,
          sourceRoots: [f.sourceDir],
          vaultRoots: [f.vaultDir]
        },
        {
          onBeforeManifestRead: () => {
            // Simulate concurrent duplicate import overwriting manifest.json AFTER VACUUM INTO T0
            const existing = JSON.parse(readFileSync(f.sampleManifestPath, 'utf8')) as VaultManifest
            const futureImportId = randomUUID()
            const mutated: VaultManifest = {
              ...existing,
              sources: [
                ...existing.sources,
                {
                  ...existing.sources[0]!,
                  fileLocationId: 9999,
                  originalPath: extraSource,
                  fileName: 'IMG_0001_copy.jpg',
                  importResult: {
                    ...existing.sources[0]!.importResult,
                    importJobId: futureImportId,
                    importedAtMs: Date.now() + 5000
                  }
                }
              ]
            }
            writeVaultManifest(f.vaultDir, mutated, futureImportId)
          }
        }
      )
    ).rejects.toMatchObject({ code: 'source_vault_concurrent_modification' })
  })

  it('T10: fails closed on missing, corrupt, or hash-mismatched vault files and manifests', async () => {
    const f = fixture!

    // 1. Corrupt vault payload bytes
    const origBytes = readFileSync(f.sampleVaultFilePath)
    writeFileSync(f.sampleVaultFilePath, Buffer.from('corrupted-bytes', 'utf8'))
    await expect(
      captureConsistentBackupSnapshot({
        jobId: 'job-v1',
        snapshotId: 'snap-v1',
        catalogPath: f.catalogPath,
        annotationsDir: f.annotationsDir,
        stagingDir: join(f.userDataDir, '.backup-staging', 'job-v1'),
        userDataDir: f.userDataDir,
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir]
      })
    ).rejects.toMatchObject({ code: 'source_vault_integrity_error' })

    // Restore payload, corrupt manifest.json
    writeFileSync(f.sampleVaultFilePath, origBytes)
    writeFileSync(f.sampleManifestPath, '{ invalid json')
    await expect(
      captureConsistentBackupSnapshot({
        jobId: 'job-v2',
        snapshotId: 'snap-v2',
        catalogPath: f.catalogPath,
        annotationsDir: f.annotationsDir,
        stagingDir: join(f.userDataDir, '.backup-staging', 'job-v2'),
        userDataDir: f.userDataDir,
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir]
      })
    ).rejects.toMatchObject({ code: 'source_vault_integrity_error' })

    // Delete manifest.json
    rmSync(f.sampleManifestPath)
    await expect(
      captureConsistentBackupSnapshot({
        jobId: 'job-v3',
        snapshotId: 'snap-v3',
        catalogPath: f.catalogPath,
        annotationsDir: f.annotationsDir,
        stagingDir: join(f.userDataDir, '.backup-staging', 'job-v3'),
        userDataDir: f.userDataDir,
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir]
      })
    ).rejects.toMatchObject({ code: 'source_vault_integrity_error' })

    // Delete vault payload file
    rmSync(f.sampleVaultFilePath)
    await expect(
      captureConsistentBackupSnapshot({
        jobId: 'job-v4',
        snapshotId: 'snap-v4',
        catalogPath: f.catalogPath,
        annotationsDir: f.annotationsDir,
        stagingDir: join(f.userDataDir, '.backup-staging', 'job-v4'),
        userDataDir: f.userDataDir,
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir]
      })
    ).rejects.toMatchObject({ code: 'source_vault_integrity_error' })

    // Staging manifest was never emitted
    expect(
      existsSync(join(f.userDataDir, '.backup-staging', 'job-v3', 'staging-manifest.json'))
    ).toBe(false)
  })

  it('T11-capture: rejects staging overlap with source/vault/outside userData and rejects symlinks/junctions', () => {
    const f = fixture!

    // Staging outside userData
    expect(() =>
      validateBackupStagingDir({
        stagingDir: join(f.rootDir, 'outside-staging'),
        userDataDir: f.userDataDir,
        sourceRoots: [f.sourceDir],
        vaultRoots: [f.vaultDir]
      })
    ).toThrow(BackupContainmentError)

    // Staging overlapping source root inside userData
    const badSourceInside = join(f.userDataDir, 'bad-src')
    mkdirSync(badSourceInside, { recursive: true })
    expect(() =>
      validateBackupStagingDir({
        stagingDir: join(badSourceInside, 'staging'),
        userDataDir: f.userDataDir,
        sourceRoots: [badSourceInside],
        vaultRoots: [f.vaultDir]
      })
    ).toThrow(BackupContainmentError)

    // Symlink / junction check
    const linkParent = join(f.userDataDir, 'sym-parent')
    const realTarget = join(f.rootDir, 'real-target')
    mkdirSync(realTarget, { recursive: true })
    let linkCreated = false
    try {
      symlinkSync(realTarget, linkParent, process.platform === 'win32' ? 'junction' : 'dir')
      linkCreated = true
    } catch {
      // Skip symlink creation if OS permissions disallow it
    }
    if (linkCreated) {
      expect(() =>
        validateBackupStagingDir({
          stagingDir: join(linkParent, 'staging'),
          userDataDir: f.userDataDir,
          sourceRoots: [f.sourceDir],
          vaultRoots: [f.vaultDir]
        })
      ).toThrow(BackupContainmentError)
    }
  })

  it('T12: validates Slice 3 encrypted repository metadata and rejects private paths in completion markers', () => {
    const validEncryptedRepo = {
      formatVersion: 1,
      repositoryId: randomUUID(),
      createdAtMs: Date.now(),
      appVersion: '0.1.0',
      chunkSizeBytes: BACKUP_CHUNK_SIZE_BYTES,
      encryptionMode: 'aes-256-gcm-v1',
      encryption: {
        kdf: 'scrypt',
        kdfParams: { N: 32768, r: 8, p: 1, keyLenBytes: 32 },
        saltBase64: 'c2FsdA==',
        wrappedMasterKeyBase64: 'd3JhcHBlZA==',
        keyWrapNonceBase64: 'bm9uY2U=',
        keyWrapTagBase64: 'dGFn',
        keyCheckTagBase64: 'Y2hlY2s=',
        keyId: 'key-1'
      }
    }
    expect(BackupRepositoryIdentityV1Schema.safeParse(validEncryptedRepo).success).toBe(true)

    // Malformed KDF / missing encryption block
    expect(
      BackupRepositoryIdentityV1Schema.safeParse({
        ...validEncryptedRepo,
        encryption: null
      }).success
    ).toBe(false)

    expect(
      BackupRepositoryIdentityV1Schema.safeParse({
        ...validEncryptedRepo,
        encryption: { ...validEncryptedRepo.encryption, kdf: 'pbkdf2' }
      }).success
    ).toBe(false)

    // Completion marker rejects extra private fields (strict schema)
    const validComplete = {
      formatVersion: 1,
      schema: 'pv_backup_complete_v1',
      snapshotId: 'snap-1',
      repositoryId: randomUUID(),
      encryptionMode: 'aes-256-gcm-v1',
      manifestObjectId: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
      totalObjectCount: 10,
      totalLogicalBytes: 1024,
      totalStoredBytes: 1056,
      verificationScope: 'full_readback',
      completedAtMs: Date.now()
    }
    expect(BackupSnapshotCompleteMarkerV1Schema.safeParse(validComplete).success).toBe(true)

    expect(
      BackupSnapshotCompleteMarkerV1Schema.safeParse({
        ...validComplete,
        originalPath: 'C:\\Users\\Ron\\Secret.pdf'
      }).success
    ).toBe(false)

    expect(
      BackupSnapshotCompleteMarkerV1Schema.safeParse({
        ...validComplete,
        vaultName: 'My Private Vault'
      }).success
    ).toBe(false)
  })
})
