// @vitest-environment node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import {
  assertProfileSafeForCatalogOpen,
  cleanupInterruptedCatalogRecoveryTarget,
  computeProfileLockKey,
  inspectRecoveredProfileStatus,
  recoverCatalogFromVaultManifests,
  RECOVERY_IN_PROGRESS_MARKER,
  withProfileStartupCoordination
} from '../../src/main/services/backup/catalog-recovery'
import {
  CatalogRecoveryError,
  RecoveryIncompleteError
} from '../../src/main/services/backup/errors'
import { captureConsistentBackupSnapshot } from '../../src/main/services/backup/snapshot-capture'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { CURRENT_SCHEMA_VERSION } from '../../src/main/services/catalog/migrations'
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

function writeVaultEntry(params: {
  vaultDir: string
  vaultId: string
  payload: Buffer
  fileName: string
  publishedAtMs: number
  sources: Array<{
    fileLocationId: number
    originalPath: string
    fileName: string
    extension: string
    category: 'photo' | 'document'
    filesystemBirthtimeMs: number | null
    filesystemMtimeMs: number | null
    inferredCaptureTimeMs: number | null
    firstDiscoveredAtMs: number
    lastSeenAtMs: number
    discoveryObservationId: number
    hashObservationId: number
    hashVerifiedAtMs: number
    importJobId: string
    importedAtMs: number
    isPreferred?: boolean
    duplicateReviewStatus?: 'reviewed' | 'unreviewed' | null
  }>
}): { sha256: string; contentDir: string; payloadPath: string; manifestPath: string } {
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
      publishedAtMs: params.publishedAtMs,
      verifiedSha256: sha,
      verifiedByteSize: params.payload.length
    },
    sources: params.sources.map((s) => ({
      fileLocationId: s.fileLocationId,
      originalPath: s.originalPath,
      fileName: s.fileName,
      extension: s.extension,
      category: s.category,
      recordedFacts: {
        byteSize: params.payload.length,
        filesystemBirthtimeMs: s.filesystemBirthtimeMs,
        filesystemMtimeMs: s.filesystemMtimeMs,
        firstDiscoveredAtMs: s.firstDiscoveredAtMs,
        lastSeenAtMs: s.lastSeenAtMs,
        discoveryObservationId: s.discoveryObservationId,
        hashObservationId: s.hashObservationId,
        hashVerifiedAtMs: s.hashVerifiedAtMs
      },
      inferredMetadata: {
        inferredCaptureTimeMs: s.inferredCaptureTimeMs
      },
      reviewDecisions: {
        isPreferred: s.isPreferred ?? false,
        duplicateReviewStatus: s.duplicateReviewStatus ?? null
      },
      importResult: {
        importJobId: s.importJobId,
        importedAtMs: s.importedAtMs,
        verifiedSourceSha256: sha,
        verifiedSourceByteSize: params.payload.length,
        sourceStability: {
          preCopyMtimeMs: s.filesystemMtimeMs,
          postCopyMtimeMs: s.filesystemMtimeMs,
          preCopyByteSize: params.payload.length,
          postCopyByteSize: params.payload.length
        }
      }
    }))
  }

  const manifestPath = join(contentDir, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return { sha256: sha, contentDir, payloadPath, manifestPath }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Stage 8B Slice 2: Strict Catalog Recovery from Vault Manifests', () => {
  it('rebuilds imported-file records, preserves verbatim paths & nulls, keeps two-hash history, and enforces read-only vault + non-scan sources', async () => {
    const root = makeTempDir('pv-rec-main-')
    const vaultDir = join(root, 'surviving-vault')
    const targetProfileDir = join(root, 'recovered-profile')

    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Surviving Vault' })

    const v1Bytes = Buffer.from('photo-version-1-bytes')
    const v2Bytes = Buffer.from('photo-version-2-bytes-updated')
    const docBytes = Buffer.from('tax-return-2025-document-bytes')

    const sharedOriginalPath = 'D:\\OriginalPhotos\\Trip\\IMG_0001.JPG'
    const docOriginalPath = 'D:\\Documents\\Tax\\return-2025.pdf'

    const e1 = writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: v1Bytes,
      fileName: 'IMG_0001.JPG',
      publishedAtMs: 1_700_000_001_000,
      sources: [
        {
          fileLocationId: 10,
          originalPath: sharedOriginalPath,
          fileName: 'IMG_0001.JPG',
          extension: '.jpg',
          category: 'photo',
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: 1_700_000_000_500,
          inferredCaptureTimeMs: null,
          firstDiscoveredAtMs: 1_700_000_000_800,
          lastSeenAtMs: 1_700_000_000_900,
          discoveryObservationId: 100,
          hashObservationId: 200,
          hashVerifiedAtMs: 1_700_000_000_950,
          importJobId: 'import-job-1',
          importedAtMs: 1_700_000_001_000,
          isPreferred: true,
          duplicateReviewStatus: 'reviewed'
        }
      ]
    })

    const e2 = writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: v2Bytes,
      fileName: 'IMG_0001.JPG',
      publishedAtMs: 1_700_000_050_000,
      sources: [
        {
          fileLocationId: 10,
          originalPath: sharedOriginalPath,
          fileName: 'IMG_0001.JPG',
          extension: '.jpg',
          category: 'photo',
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: null,
          inferredCaptureTimeMs: 1_699_000_000_000,
          firstDiscoveredAtMs: 1_700_000_040_000,
          lastSeenAtMs: 1_700_000_049_000,
          discoveryObservationId: 101,
          hashObservationId: 201,
          hashVerifiedAtMs: 1_700_000_049_500,
          importJobId: 'import-job-2',
          importedAtMs: 1_700_000_050_000
        }
      ]
    })

    writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: docBytes,
      fileName: 'return-2025.pdf',
      publishedAtMs: 1_700_000_060_000,
      sources: [
        {
          fileLocationId: 20,
          originalPath: docOriginalPath,
          fileName: 'return-2025.pdf',
          extension: '.pdf',
          category: 'document',
          filesystemBirthtimeMs: 1_690_000_000_000,
          filesystemMtimeMs: 1_695_000_000_000,
          inferredCaptureTimeMs: null,
          firstDiscoveredAtMs: 1_700_000_055_000,
          lastSeenAtMs: 1_700_000_059_000,
          discoveryObservationId: 102,
          hashObservationId: 202,
          hashVerifiedAtMs: 1_700_000_059_500,
          importJobId: 'import-job-2',
          importedAtMs: 1_700_000_060_000
        }
      ]
    })

    // Record vault mtime + bytes before recovery to verify 0 mutations
    const vaultJsonBefore = readFileSync(join(vaultDir, 'vault.json'))
    const vaultJsonMtimeBefore = statSync(join(vaultDir, 'vault.json')).mtimeMs
    const e1PayloadBefore = readFileSync(e1.payloadPath)
    const e1MtimeBefore = statSync(e1.payloadPath).mtimeMs

    const report = await recoverCatalogFromVaultManifests({
      sourceVaultDir: vaultDir,
      targetProfileDir
    })

    expect(report.currentVersionSelectionNote).toBe('inferred_from_manifest_evidence')
    expect(report.recoveredVaultCopies).toBe(3)
    expect(report.recoveredSources).toBe(2)
    expect(report.recoveredFileLocations).toBe(2)
    expect(report.recoveredObservations).toBe(3)
    expect(report.historicalObservations).toBe(1)
    expect(inspectRecoveredProfileStatus(targetProfileDir).status).toBe('complete')

    const catalog = CatalogDatabase.open({ catalogPath: report.catalogPath })
    try {
      const activeVault = catalog.getActiveVault()
      expect(activeVault).not.toBeNull()
      expect(activeVault!.vaultId).toBe(identity.vaultId)
      expect(activeVault!.isReadOnly).toBe(true)

      // Inferred recovery sources must stay out of scan/approved-root authorization
      expect(catalog.getAllSourceRoots()).toEqual([])

      // Verify Migration 18 columns & schema version
      const rawDb = (catalog as unknown as { db: import('node:sqlite').DatabaseSync }).db
      const maxVer = rawDb.prepare('SELECT MAX(version) AS v FROM schema_migrations;').get() as {
        v: number
      }
      expect(maxVer.v).toBe(CURRENT_SCHEMA_VERSION)

      const sourceRows = rawDb
        .prepare('SELECT root_path, source_kind FROM sources ORDER BY id ASC;')
        .all() as Array<{ root_path: string; source_kind: string }>
      expect(sourceRows.every((s) => s.source_kind === 'recovery_manifest')).toBe(true)

      // Two hashes for one original path: 1 file_location, 2 discovery/hash observations
      const photoLoc = rawDb
        .prepare('SELECT id, original_path FROM file_locations WHERE original_path = ?;')
        .get(sharedOriginalPath) as {
        id: number
        original_path: string
      }
      expect(photoLoc.original_path).toBe(sharedOriginalPath)

      const discRows = rawDb
        .prepare(
          'SELECT d.id, d.is_current, d.filesystem_birthtime_ms, d.filesystem_mtime_ms, d.inferred_capture_time_ms, h.sha256, h.is_active FROM discovery_observations d JOIN hash_observations h ON h.discovery_observation_id = d.id WHERE d.file_location_id = ? ORDER BY d.last_seen_at_ms DESC;'
        )
        .all(photoLoc.id) as Array<{
        id: number
        is_current: number
        filesystem_birthtime_ms: number | null
        filesystem_mtime_ms: number | null
        inferred_capture_time_ms: number | null
        sha256: string
        is_active: number
      }>
      expect(discRows).toHaveLength(2)
      expect(discRows[0]!.sha256).toBe(e2.sha256)
      expect(discRows[0]!.is_current).toBe(1)
      expect(discRows[0]!.is_active).toBe(1)
      expect(discRows[0]!.filesystem_birthtime_ms).toBeNull()
      expect(discRows[0]!.filesystem_mtime_ms).toBeNull()
      expect(discRows[0]!.inferred_capture_time_ms).toBe(1_699_000_000_000)
      expect(discRows[1]!.sha256).toBe(e1.sha256)
      expect(discRows[1]!.is_current).toBe(0)
      expect(discRows[1]!.is_active).toBe(0)
      expect(discRows[1]!.filesystem_birthtime_ms).toBeNull()
      expect(discRows[1]!.filesystem_mtime_ms).toBe(1_700_000_000_500)
      expect(discRows[1]!.inferred_capture_time_ms).toBeNull()

      // Unsubstantiated historical tables must remain empty
      for (const table of [
        'vault_imports',
        'vault_import_items',
        'duplicate_reviews',
        'scan_jobs',
        'photo_annotations',
        'collections'
      ]) {
        const cnt = rawDb.prepare(`SELECT COUNT(*) AS c FROM ${table};`).get() as { c: number }
        expect(cnt.c).toBe(0)
      }

      // Read-only vault must block VaultImportCoordinator writes
      const importCoord = new VaultImportCoordinator({ catalog })
      await expect(
        importCoord.startImport({ vaultId: identity.vaultId, fileLocationIds: [photoLoc.id] })
      ).rejects.toThrow(/read-only/i)
    } finally {
      catalog.close()
    }

    // Source vault remains 100% untouched
    expect(readFileSync(join(vaultDir, 'vault.json'))).toEqual(vaultJsonBefore)
    expect(statSync(join(vaultDir, 'vault.json')).mtimeMs).toBe(vaultJsonMtimeBefore)
    expect(readFileSync(e1.payloadPath)).toEqual(e1PayloadBefore)
    expect(statSync(e1.payloadPath).mtimeMs).toBe(e1MtimeBefore)
  })

  it('rejects distinct original_path spellings that normalize to the same key', async () => {
    const root = makeTempDir('pv-rec-norm-')
    const vaultDir = join(root, 'vault')
    const targetProfileDir = join(root, 'recovered')
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Norm Vault' })

    writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: Buffer.from('a-bytes'),
      fileName: 'IMG.jpg',
      publishedAtMs: 1_700_000_001_000,
      sources: [
        {
          fileLocationId: 1,
          originalPath: 'D:\\Photos\\IMG.jpg',
          fileName: 'IMG.jpg',
          extension: '.jpg',
          category: 'photo',
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: null,
          inferredCaptureTimeMs: null,
          firstDiscoveredAtMs: 1_700_000_000_100,
          lastSeenAtMs: 1_700_000_000_200,
          discoveryObservationId: 1,
          hashObservationId: 1,
          hashVerifiedAtMs: 1_700_000_000_300,
          importJobId: 'j1',
          importedAtMs: 1_700_000_001_000
        }
      ]
    })

    writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: Buffer.from('b-bytes'),
      fileName: 'img.jpg',
      publishedAtMs: 1_700_000_002_000,
      sources: [
        {
          fileLocationId: 2,
          originalPath: 'd:\\photos\\img.jpg',
          fileName: 'img.jpg',
          extension: '.jpg',
          category: 'photo',
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: null,
          inferredCaptureTimeMs: null,
          firstDiscoveredAtMs: 1_700_000_001_100,
          lastSeenAtMs: 1_700_000_001_200,
          discoveryObservationId: 2,
          hashObservationId: 2,
          hashVerifiedAtMs: 1_700_000_001_300,
          importJobId: 'j2',
          importedAtMs: 1_700_000_002_000
        }
      ]
    })

    await expect(
      recoverCatalogFromVaultManifests({ sourceVaultDir: vaultDir, targetProfileDir })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CatalogRecoveryError && err.code === 'recovery_conflicting_normalized_path'
    )
  })

  it('fails closed on missing/corrupt manifests, escaped relativePath, and payload size/hash mismatch', async () => {
    const baseRoot = makeTempDir('pv-rec-faults-')

    const buildValidVault = (subName: string) => {
      const vDir = join(baseRoot, `${subName}-vault`)
      const id = initializeVault({ vaultPath: vDir, vaultName: 'Fault Vault' })
      const entry = writeVaultEntry({
        vaultDir: vDir,
        vaultId: id.vaultId,
        payload: Buffer.from('valid-payload-content'),
        fileName: 'doc.txt',
        publishedAtMs: 1_700_000_001_000,
        sources: [
          {
            fileLocationId: 1,
            originalPath: 'D:\\Docs\\doc.txt',
            fileName: 'doc.txt',
            extension: '.txt',
            category: 'document',
            filesystemBirthtimeMs: null,
            filesystemMtimeMs: null,
            inferredCaptureTimeMs: null,
            firstDiscoveredAtMs: 1_700_000_000_100,
            lastSeenAtMs: 1_700_000_000_200,
            discoveryObservationId: 1,
            hashObservationId: 1,
            hashVerifiedAtMs: 1_700_000_000_300,
            importJobId: 'j1',
            importedAtMs: 1_700_000_001_000
          }
        ]
      })
      return { vDir, entry }
    }

    // 1. Missing manifest.json
    {
      const { vDir, entry } = buildValidVault('missing-manifest')
      rmSync(entry.manifestPath)
      const target = join(baseRoot, 't-missing-manifest')
      await expect(
        recoverCatalogFromVaultManifests({ sourceVaultDir: vDir, targetProfileDir: target })
      ).rejects.toSatisfy(
        (e: unknown) => e instanceof CatalogRecoveryError && e.code === 'recovery_manifest_missing'
      )
      expect(inspectRecoveredProfileStatus(target).status).toBe('clean')
    }

    // 2. Corrupt manifest.json
    {
      const { vDir, entry } = buildValidVault('corrupt-manifest')
      writeFileSync(entry.manifestPath, '{broken json')
      const target = join(baseRoot, 't-corrupt-manifest')
      await expect(
        recoverCatalogFromVaultManifests({ sourceVaultDir: vDir, targetProfileDir: target })
      ).rejects.toSatisfy(
        (e: unknown) => e instanceof CatalogRecoveryError && e.code === 'recovery_manifest_corrupt'
      )
    }

    // 3. Payload path escaping its content directory
    {
      const { vDir, entry } = buildValidVault('escape-payload')
      const parsed = JSON.parse(readFileSync(entry.manifestPath, 'utf8'))
      parsed.managedCopy.relativePath = 'files/00/other/doc.txt'
      writeFileSync(entry.manifestPath, JSON.stringify(parsed))
      const target = join(baseRoot, 't-escape-payload')
      await expect(
        recoverCatalogFromVaultManifests({ sourceVaultDir: vDir, targetProfileDir: target })
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof CatalogRecoveryError && e.code === 'recovery_payload_containment_error'
      )
    }

    // 4. Payload bit-flip / hash mismatch
    {
      const { vDir, entry } = buildValidVault('hash-mismatch')
      const corrupted = Buffer.from('valid-payload-contenT')
      writeFileSync(entry.payloadPath, corrupted)
      const target = join(baseRoot, 't-hash-mismatch')
      await expect(
        recoverCatalogFromVaultManifests({ sourceVaultDir: vDir, targetProfileDir: target })
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof CatalogRecoveryError && e.code === 'recovery_payload_hash_mismatch'
      )
    }

    // 5. Payload size mismatch
    {
      const { vDir, entry } = buildValidVault('size-mismatch')
      writeFileSync(entry.payloadPath, Buffer.from('short'))
      const target = join(baseRoot, 't-size-mismatch')
      await expect(
        recoverCatalogFromVaultManifests({ sourceVaultDir: vDir, targetProfileDir: target })
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof CatalogRecoveryError && e.code === 'recovery_payload_hash_mismatch'
      )
    }
  })

  it('handles interrupted publication safely and retries cleanly after cleanup', async () => {
    const root = makeTempDir('pv-rec-retry-')
    const vaultDir = join(root, 'vault')
    const targetProfileDir = join(root, 'recovered')
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Retry Vault' })

    writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: Buffer.from('retry-photo-bytes'),
      fileName: 'retry.jpg',
      publishedAtMs: 1_700_000_001_000,
      sources: [
        {
          fileLocationId: 1,
          originalPath: 'D:\\Photos\\retry.jpg',
          fileName: 'retry.jpg',
          extension: '.jpg',
          category: 'photo',
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: null,
          inferredCaptureTimeMs: null,
          firstDiscoveredAtMs: 1_700_000_000_100,
          lastSeenAtMs: 1_700_000_000_200,
          discoveryObservationId: 1,
          hashObservationId: 1,
          hashVerifiedAtMs: 1_700_000_000_300,
          importJobId: 'j1',
          importedAtMs: 1_700_000_001_000
        }
      ]
    })

    const ac = new AbortController()
    await expect(
      recoverCatalogFromVaultManifests({
        sourceVaultDir: vaultDir,
        targetProfileDir,
        recoveryJobId: 'job-interrupt-1',
        signal: ac.signal,
        onPhase: (phase) => {
          if (phase === 'after_publish_db') {
            ac.abort()
          }
        }
      })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof CatalogRecoveryError && e.code === 'recovery_cancelled'
    )

    const statusAfterCrash = inspectRecoveredProfileStatus(targetProfileDir)
    expect(statusAfterCrash.status).toBe('interrupted')
    expect(statusAfterCrash.recoveryJobId).toBe('job-interrupt-1')

    // Cleanup refuses mismatched job ID
    await expect(
      cleanupInterruptedCatalogRecoveryTarget({
        targetProfileDir,
        expectedRecoveryJobId: 'wrong-job-id'
      })
    ).rejects.toThrow(CatalogRecoveryError)

    // Matching cleanup restores clean empty state and retry succeeds
    await cleanupInterruptedCatalogRecoveryTarget({
      targetProfileDir,
      expectedRecoveryJobId: 'job-interrupt-1'
    })
    expect(inspectRecoveredProfileStatus(targetProfileDir).status).toBe('clean')

    const report = await recoverCatalogFromVaultManifests({
      sourceVaultDir: vaultDir,
      targetProfileDir
    })
    expect(report.recoveredVaultCopies).toBe(1)
    expect(inspectRecoveredProfileStatus(targetProfileDir).status).toBe('complete')
  })

  it('keeps Slice 1 backup snapshot capture compatible when a payload was re-imported after first publication', async () => {
    const root = makeTempDir('pv-rec-backup-compat-')
    const vaultDir = join(root, 'vault')
    const targetProfileDir = join(root, 'recovered')
    const stagingDir = join(targetProfileDir, '.backup-staging', 'backup-job-1')
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Reimport Vault' })

    const payload = Buffer.from('shared-reimported-photo-bytes')
    // Payload published at t=1000, then second source imported against same payload at t=5000
    writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload,
      fileName: 'shared.jpg',
      publishedAtMs: 1_700_000_001_000,
      sources: [
        {
          fileLocationId: 1,
          originalPath: 'D:\\FolderA\\shared.jpg',
          fileName: 'shared.jpg',
          extension: '.jpg',
          category: 'photo',
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: null,
          inferredCaptureTimeMs: null,
          firstDiscoveredAtMs: 1_700_000_000_500,
          lastSeenAtMs: 1_700_000_000_800,
          discoveryObservationId: 1,
          hashObservationId: 1,
          hashVerifiedAtMs: 1_700_000_000_900,
          importJobId: 'job-1',
          importedAtMs: 1_700_000_001_000
        },
        {
          fileLocationId: 2,
          originalPath: 'D:\\FolderB\\shared.jpg',
          fileName: 'shared.jpg',
          extension: '.jpg',
          category: 'photo',
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: null,
          inferredCaptureTimeMs: null,
          firstDiscoveredAtMs: 1_700_000_004_500,
          lastSeenAtMs: 1_700_000_004_800,
          discoveryObservationId: 2,
          hashObservationId: 2,
          hashVerifiedAtMs: 1_700_000_004_900,
          importJobId: 'job-2',
          importedAtMs: 1_700_000_005_000
        }
      ]
    })

    const report = await recoverCatalogFromVaultManifests({
      sourceVaultDir: vaultDir,
      targetProfileDir
    })

    // Initialize empty annotations dir for the recovered profile
    const annotationsDir = join(targetProfileDir, 'annotations')
    const catalog = CatalogDatabase.open({ catalogPath: report.catalogPath })
    try {
      const journal = new AnnotationJournal({
        storageDir: annotationsDir,
        sourceRoots: () => catalog.getAllSourceRoots(),
        vaultPath: () => catalog.getActiveVault()?.vaultPath ?? null
      })
      await journal.initialize()
      catalog.setJournal(journal)
    } finally {
      catalog.close()
    }

    const staged = await captureConsistentBackupSnapshot({
      catalogPath: report.catalogPath,
      annotationsDir,
      stagingDir,
      jobId: 'backup-job-1',
      snapshotId: 'snap-1',
      userDataDir: targetProfileDir,
      sourceRoots: [],
      vaultRoots: [vaultDir]
    })

    expect(staged.stagingManifest.vault).not.toBeNull()
    expect(staged.stagingManifest.vault!.copies).toHaveLength(1)
  })

  it('preserves a foreign target catalog appearing after validation byte-for-byte across failed publication and cleanup, and enforces startup guard', async () => {
    const root = makeTempDir('pv-rec-foreign-')
    const vaultDir = join(root, 'vault')
    const targetProfileDir = join(root, 'target-profile')
    const ordinaryProfileDir = join(root, 'ordinary-profile')
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Foreign Guard Vault' })

    writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: Buffer.from('guard-photo-bytes'),
      fileName: 'guard.jpg',
      publishedAtMs: 1_700_000_001_000,
      sources: [
        {
          fileLocationId: 1,
          originalPath: 'D:\\Photos\\guard.jpg',
          fileName: 'guard.jpg',
          extension: '.jpg',
          category: 'photo',
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: null,
          inferredCaptureTimeMs: null,
          firstDiscoveredAtMs: 1_700_000_000_100,
          lastSeenAtMs: 1_700_000_000_200,
          discoveryObservationId: 1,
          hashObservationId: 1,
          hashVerifiedAtMs: 1_700_000_000_300,
          importJobId: 'j1',
          importedAtMs: 1_700_000_001_000
        }
      ]
    })

    const foreignBytes = Buffer.from('FOREIGN-TARGET-CATALOG-MUST-SURVIVE-BYTE-FOR-BYTE')
    const targetCatalogPath = join(targetProfileDir, 'vault-catalog.db')

    await expect(
      recoverCatalogFromVaultManifests({
        sourceVaultDir: vaultDir,
        targetProfileDir,
        recoveryJobId: 'job-foreign-1',
        onPhase: (phase) => {
          if (phase === 'after_stage_db') {
            writeFileSync(targetCatalogPath, foreignBytes)
          }
        }
      })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof CatalogRecoveryError && e.code === 'recovery_target_invalid'
    )

    // Foreign catalog survived failed publication byte-for-byte
    expect(readFileSync(targetCatalogPath)).toEqual(foreignBytes)

    // Startup guard refuses interrupted profile before opening catalog/journal
    expect(() => assertProfileSafeForCatalogOpen(targetProfileDir)).toThrow(RecoveryIncompleteError)

    // Subsequent cleanup must ALSO preserve the foreign catalog byte-for-byte
    await cleanupInterruptedCatalogRecoveryTarget({
      targetProfileDir,
      expectedRecoveryJobId: 'job-foreign-1'
    })
    expect(readFileSync(targetCatalogPath)).toEqual(foreignBytes)

    // Ordinary non-recovered profile with vault-catalog.db passes startup guard
    mkdirSync(ordinaryProfileDir, { recursive: true })
    writeFileSync(join(ordinaryProfileDir, 'vault-catalog.db'), foreignBytes)
    expect(() => assertProfileSafeForCatalogOpen(ordinaryProfileDir)).not.toThrow()
  })

  it('preserves an independently created target catalog with identical bytes to the staged DB and its SQLite sidecars', async () => {
    const root = makeTempDir('pv-rec-same-bytes-')
    const vaultDir = join(root, 'vault')
    const targetProfileDir = join(root, 'target-profile')
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Same Bytes Vault' })

    writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: Buffer.from('same-bytes-photo'),
      fileName: 'same.jpg',
      publishedAtMs: 1_700_000_001_000,
      sources: [
        {
          fileLocationId: 1,
          originalPath: 'D:\\Photos\\same.jpg',
          fileName: 'same.jpg',
          extension: '.jpg',
          category: 'photo',
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: null,
          inferredCaptureTimeMs: null,
          firstDiscoveredAtMs: 1_700_000_000_100,
          lastSeenAtMs: 1_700_000_000_200,
          discoveryObservationId: 1,
          hashObservationId: 1,
          hashVerifiedAtMs: 1_700_000_000_300,
          importJobId: 'j1',
          importedAtMs: 1_700_000_001_000
        }
      ]
    })

    const targetCatalogPath = join(targetProfileDir, 'vault-catalog.db')
    const targetWalPath = join(targetProfileDir, 'vault-catalog.db-wal')
    const targetShmPath = join(targetProfileDir, 'vault-catalog.db-shm')
    const walBytes = Buffer.from('INDEPENDENT-WAL-BYTES')
    const shmBytes = Buffer.from('INDEPENDENT-SHM-BYTES')
    let stagedBytesSnapshot: Buffer = Buffer.alloc(0)

    await expect(
      recoverCatalogFromVaultManifests({
        sourceVaultDir: vaultDir,
        targetProfileDir,
        recoveryJobId: 'job-same-bytes-1',
        onPhase: (phase) => {
          if (phase === 'after_record_staged_hash') {
            // Confirm stagedCatalogSha256 is already recorded in .pv-recovery-in-progress.json
            const marker = JSON.parse(
              readFileSync(join(targetProfileDir, RECOVERY_IN_PROGRESS_MARKER), 'utf8')
            ) as { stagedCatalogSha256: string | null }
            stagedBytesSnapshot = readFileSync(
              join(targetProfileDir, '.pv-recovery-temp', 'vault-catalog.db')
            )
            expect(marker.stagedCatalogSha256).toBe(sha256Hex(stagedBytesSnapshot))

            // Independently create target catalog with the EXACT same bytes as staged DB + sidecars
            // right before linkSync(stagedDbPath, publishedDbPath)
            writeFileSync(targetCatalogPath, stagedBytesSnapshot)
            writeFileSync(targetWalPath, walBytes)
            writeFileSync(targetShmPath, shmBytes)
          }
        }
      })
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CatalogRecoveryError &&
        e.code === 'recovery_target_invalid' &&
        /appeared before publication/i.test(e.message)
    )

    // Cleanup must verify hard-link identity (dev+ino) before removing staged DB,
    // preserving the independent identical-byte catalog and its WAL/SHM sidecars.
    await cleanupInterruptedCatalogRecoveryTarget({
      targetProfileDir,
      expectedRecoveryJobId: 'job-same-bytes-1'
    })

    expect(readFileSync(targetCatalogPath)).toEqual(stagedBytesSnapshot)
    expect(readFileSync(targetWalPath)).toEqual(walBytes)
    expect(readFileSync(targetShmPath)).toEqual(shmBytes)
  })

  it('coordinates startup and recovery deterministically on the same target profile in both orders', async () => {
    const root = makeTempDir('pv-rec-coord-')
    const vaultDir = join(root, 'vault')
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Coord Vault' })

    writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: Buffer.from('coord-photo-bytes'),
      fileName: 'coord.jpg',
      publishedAtMs: 1_700_000_001_000,
      sources: [
        {
          fileLocationId: 1,
          originalPath: 'D:\\Photos\\coord.jpg',
          fileName: 'coord.jpg',
          extension: '.jpg',
          category: 'photo',
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: null,
          inferredCaptureTimeMs: null,
          firstDiscoveredAtMs: 1_700_000_000_100,
          lastSeenAtMs: 1_700_000_000_200,
          discoveryObservationId: 1,
          hashObservationId: 1,
          hashVerifiedAtMs: 1_700_000_000_300,
          importJobId: 'j1',
          importedAtMs: 1_700_000_001_000
        }
      ]
    })

    // Order A: Startup passes marker check and pauses before SQLite opens -> recovery is blocked
    const profileOrderA = join(root, 'profile-order-a')
    let notifyStartupPaused!: () => void
    const startupPaused = new Promise<void>((r) => {
      notifyStartupPaused = r
    })
    let releaseStartup!: () => void
    const startupGate = new Promise<void>((r) => {
      releaseStartup = r
    })

    const startupPromise = withProfileStartupCoordination(
      profileOrderA,
      () => {
        const db = CatalogDatabase.open({ catalogPath: join(profileOrderA, 'vault-catalog.db') })
        db.close()
        return 'opened'
      },
      async () => {
        notifyStartupPaused()
        await startupGate
      }
    )

    await startupPaused
    await expect(
      recoverCatalogFromVaultManifests({
        sourceVaultDir: vaultDir,
        targetProfileDir: profileOrderA
      })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof CatalogRecoveryError && e.code === 'recovery_target_invalid'
    )

    releaseStartup()
    expect(await startupPromise).toBe('opened')

    // Order B: Recovery starts first and pauses after staging -> startup is blocked before SQLite opens
    const profileOrderB = join(root, 'profile-order-b')
    let notifyRecoveryPaused!: () => void
    const recoveryPaused = new Promise<void>((r) => {
      notifyRecoveryPaused = r
    })
    let releaseRecovery!: () => void
    const recoveryGate = new Promise<void>((r) => {
      releaseRecovery = r
    })

    const recoveryPromise = recoverCatalogFromVaultManifests({
      sourceVaultDir: vaultDir,
      targetProfileDir: profileOrderB,
      onPhase: async (phase) => {
        if (phase === 'after_stage_db') {
          notifyRecoveryPaused()
          await recoveryGate
        }
      }
    })

    await recoveryPaused
    let sqliteOpenedDuringRecovery = false
    await expect(
      withProfileStartupCoordination(profileOrderB, () => {
        sqliteOpenedDuringRecovery = true
      })
    ).rejects.toThrow(RecoveryIncompleteError)
    expect(sqliteOpenedDuringRecovery).toBe(false)

    // Interrupted-recovery cleanup must also refuse while live recovery holds the lock
    await expect(
      cleanupInterruptedCatalogRecoveryTarget({ targetProfileDir: profileOrderB })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof CatalogRecoveryError && e.code === 'recovery_cleanup_refused'
    )

    releaseRecovery()
    const report = await recoveryPromise
    expect(report.recoveredVaultCopies).toBe(1)

    // Once recovery completes, startup opens the recovered profile cleanly
    await expect(
      withProfileStartupCoordination(profileOrderB, () => {
        const db = CatalogDatabase.open({ catalogPath: report.catalogPath })
        const active = db.getActiveVault()
        db.close()
        return active?.isReadOnly
      })
    ).resolves.toBe(true)
  })

  it('releases the OS per-profile lock when a subprocess is terminated before writing the recovery marker', async () => {
    const root = makeTempDir('pv-rec-subproc-')
    const vaultDir = join(root, 'vault')
    const targetProfileDir = join(root, 'target-profile')
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Subproc Lock Vault' })

    writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: Buffer.from('subproc-photo-bytes'),
      fileName: 'subproc.jpg',
      publishedAtMs: 1_700_000_001_000,
      sources: [
        {
          fileLocationId: 1,
          originalPath: 'D:\\Photos\\subproc.jpg',
          fileName: 'subproc.jpg',
          extension: '.jpg',
          category: 'photo',
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: null,
          inferredCaptureTimeMs: null,
          firstDiscoveredAtMs: 1_700_000_000_100,
          lastSeenAtMs: 1_700_000_000_200,
          discoveryObservationId: 1,
          hashObservationId: 1,
          hashVerifiedAtMs: 1_700_000_000_300,
          importJobId: 'j1',
          importedAtMs: 1_700_000_001_000
        }
      ]
    })

    const key = computeProfileLockKey(targetProfileDir)
    const endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\pv-profile-${key}`
        : join(root, `pv-profile-${key}.sock`)

    const childScript = `
      const net = require('node:net');
      const server = net.createServer();
      server.listen(process.argv[1], () => {
        process.stdout.write('LOCKED\\n');
      });
      setInterval(() => {}, 1000);
    `
    const child = spawn(process.execPath, ['-e', childScript, endpoint], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        let out = ''
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8')
          if (out.includes('LOCKED')) {
            resolveReady()
          }
        })
        child.once('error', rejectReady)
        child.once('exit', (code) => {
          rejectReady(new Error(`Child exited prematurely with code ${code}`))
        })
      })

      // While child holds the OS lock (and before any recovery marker exists):
      // both startup and recovery must fail closed.
      await expect(
        withProfileStartupCoordination(targetProfileDir, () => 'should-not-open')
      ).rejects.toThrow(RecoveryIncompleteError)

      await expect(
        recoverCatalogFromVaultManifests({
          sourceVaultDir: vaultDir,
          targetProfileDir
        })
      ).rejects.toSatisfy(
        (e: unknown) => e instanceof CatalogRecoveryError && e.code === 'recovery_target_invalid'
      )

      // Force-terminate the lock-holding subprocess without graceful cleanup
      const exitPromise = new Promise<void>((resolveExit) => {
        child.once('exit', () => resolveExit())
      })
      child.kill('SIGKILL')
      await exitPromise

      // OS released the lock: recovery can now acquire it and complete cleanly,
      // and startup can acquire it and open the recovered catalog.
      const report = await recoverCatalogFromVaultManifests({
        sourceVaultDir: vaultDir,
        targetProfileDir
      })
      expect(report.recoveredVaultCopies).toBe(1)

      await expect(
        withProfileStartupCoordination(targetProfileDir, () => {
          const db = CatalogDatabase.open({ catalogPath: report.catalogPath })
          const active = db.getActiveVault()
          db.close()
          return active?.isReadOnly
        })
      ).resolves.toBe(true)
    } finally {
      if (!child.killed) {
        child.kill('SIGKILL')
      }
    }
  })
})
