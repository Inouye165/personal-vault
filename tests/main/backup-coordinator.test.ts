// @vitest-environment node
/**
 * Personal Vault — Stage 8B Sub-slice 1B: Migration 17, BackupRepository &
 * Persistent BackupCoordinator Tests (T5a–T5c)
 *
 * Exercises real SQLite close & reopen across every restart/recovery scenario.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../src/main/services/catalog/migrations'
import { initializeVault } from '../../src/main/services/vault/identity'
import { writeVaultManifest } from '../../src/main/services/vault/manifest'
import type { VaultManifest } from '../../src/main/services/vault/types'
import { BackupCoordinator } from '../../src/main/services/backup/coordinator'
import { inspectRecoveryPointStatus } from '../../src/main/services/backup/engine'
import {
  BACKUP_OBJECTS_DIR,
  BACKUP_SNAPSHOT_IN_PROGRESS_FILE,
  BACKUP_SNAPSHOTS_DIR
} from '../../src/main/services/backup/transport'

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

interface CoordinatorFixture {
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
  fileSha256: string
  fileBytes: Buffer
}

async function createCoordinatorFixture(): Promise<CoordinatorFixture> {
  const rootDir = mkdtempSync(join(tmpdir(), 'pv-8b-1b-'))
  const userDataDir = join(rootDir, 'userData')
  const catalogPath = join(userDataDir, 'vault-catalog.db')
  const annotationsDir = join(userDataDir, 'annotations')
  const sourceDir = join(rootDir, 'sources')
  const vaultDir = join(rootDir, 'vault')
  const backupDir = join(rootDir, 'backup-usb')

  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(backupDir, { recursive: true })

  const fileBytes = Buffer.alloc(128 * 1024, 0x51)
  fileBytes.write('PV-1B-START', 0)
  fileBytes.write('PV-1B-END', fileBytes.length - 9)
  const fileSha256 = sha256Hex(fileBytes)
  const sourceFile = join(sourceDir, 'sample-photo.tif')
  writeFileSync(sourceFile, fileBytes)

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
      fileName: 'sample-photo.tif',
      extension: '.tif',
      category: 'photo',
      byteSize: fileBytes.length,
      birthtimeMs: now - 5000,
      mtimeMs: now - 5000,
      discoveredAtMs: now
    }
  ])

  const importedLoc = catalog.queryFileLocations({ limit: 10 }).items[0]!
  catalog.recordHashObservationsBatch([
    {
      originalPath: sourceFile,
      sha256: fileSha256,
      observedByteSize: fileBytes.length,
      observedMtimeMs: importedLoc.filesystemMtimeMs,
      hashedAtMs: now
    }
  ])
  const hashObs = catalog.getHashObservationsForFile(importedLoc.id).items[0]!

  const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Test Vault 1B' })
  const vaultId = identity.vaultId
  catalog.registerVault({
    vaultId,
    vaultPath: vaultDir,
    name: identity.vaultName,
    createdAtMs: identity.createdAtMs
  })

  const importJob = catalog.createVaultImportJob({
    jobId: randomUUID(),
    vaultId,
    totalFiles: 1,
    totalBytes: fileBytes.length,
    items: [
      {
        fileLocationId: importedLoc.id,
        discoveryObservationId: importedLoc.discoveryObservationId,
        hashObservationId: hashObs.id,
        sha256: fileSha256,
        byteSize: fileBytes.length
      }
    ]
  })

  const prefix = fileSha256.slice(0, 2)
  const payloadRel = `files/${prefix}/${fileSha256}/sample-photo.tif`
  const manifestRel = `files/${prefix}/${fileSha256}/manifest.json`
  mkdirSync(join(vaultDir, 'files', prefix, fileSha256), { recursive: true })
  writeFileSync(join(vaultDir, payloadRel), fileBytes)

  const manifest: VaultManifest = {
    formatVersion: 1,
    vaultId,
    sha256: fileSha256,
    byteSize: fileBytes.length,
    managedCopy: {
      relativePath: payloadRel,
      fileName: 'sample-photo.tif',
      publishedAtMs: now,
      verifiedSha256: fileSha256,
      verifiedByteSize: fileBytes.length
    },
    sources: [
      {
        fileLocationId: importedLoc.id,
        originalPath: sourceFile,
        fileName: 'sample-photo.tif',
        extension: '.tif',
        category: 'photo',
        recordedFacts: {
          byteSize: fileBytes.length,
          filesystemBirthtimeMs: importedLoc.filesystemBirthtimeMs,
          filesystemMtimeMs: importedLoc.filesystemMtimeMs,
          firstDiscoveredAtMs: importedLoc.firstDiscoveredAtMs,
          lastSeenAtMs: importedLoc.lastSeenAtMs,
          discoveryObservationId: importedLoc.discoveryObservationId,
          hashObservationId: hashObs.id,
          hashVerifiedAtMs: hashObs.hashedAtMs
        },
        inferredMetadata: { inferredCaptureTimeMs: null },
        reviewDecisions: { isPreferred: true, duplicateReviewStatus: null },
        importResult: {
          importJobId: importJob.id,
          importedAtMs: now,
          verifiedSourceSha256: fileSha256,
          verifiedSourceByteSize: fileBytes.length,
          sourceStability: {
            preCopyMtimeMs: importedLoc.filesystemMtimeMs ?? 0,
            postCopyMtimeMs: importedLoc.filesystemMtimeMs ?? 0,
            preCopyByteSize: fileBytes.length,
            postCopyByteSize: fileBytes.length
          }
        }
      }
    ]
  }
  writeVaultManifest(vaultDir, manifest, importJob.id)

  const vaultCopy = catalog.recordVaultCopy({
    vaultId,
    sha256: fileSha256,
    byteSize: fileBytes.length,
    relativePath: payloadRel,
    manifestRelativePath: manifestRel,
    verifiedAtMs: now
  })
  catalog.updateVaultImportItem({
    jobId: importJob.id,
    fileLocationId: importedLoc.id,
    status: 'completed',
    vaultCopyId: vaultCopy.id,
    completedAtMs: now
  })
  catalog.updateVaultImportStatus(importJob.id, 'completed')

  catalog.setPhotoAnnotation({
    fileLocationId: importedLoc.id,
    expectedRevision: `rev:${importedLoc.discoveryObservationId}:${fileBytes.length}:${importedLoc.filesystemMtimeMs}:${fileSha256}`,
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
    vaultId,
    fileSha256,
    fileBytes
  }
}

async function reopenDatabase(fixture: CoordinatorFixture): Promise<{
  catalog: CatalogDatabase
  journal: AnnotationJournal
}> {
  const journal = new AnnotationJournal({
    storageDir: fixture.annotationsDir,
    sourceRoots: () => [fixture.sourceDir],
    vaultPath: () => fixture.vaultDir
  })
  await journal.initialize()
  const catalog = CatalogDatabase.open({ catalogPath: fixture.catalogPath, journal })
  return { catalog, journal }
}

describe('Stage 8B Sub-slice 1B — Migration 17, BackupRepository & BackupCoordinator', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Migration 17 creates backup persistence tables and BackupRepository persists destinations, jobs, units & objects across DB reopen', async () => {
    const fixture = await createCoordinatorFixture()
    tempDirs.push(fixture.rootDir)

    expect(CURRENT_SCHEMA_VERSION).toBe(17)
    const tables = fixture.catalog
      .getRawDb()
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
          'backup_destinations',
          'backup_jobs',
          'backup_job_units',
          'backup_destination_objects',
          'backup_bandwidth_ledger'
        ) ORDER BY name`
      )
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toEqual([
      'backup_bandwidth_ledger',
      'backup_destination_objects',
      'backup_destinations',
      'backup_job_units',
      'backup_jobs'
    ])

    const repo = fixture.catalog.getBackupRepository()
    const dest = repo.createDestination({
      name: 'NAS Share',
      kind: 'local_fs',
      targetPath: fixture.backupDir,
      maxBytesPerSecond: 256 * 1024
    })
    expect(dest.maxBytesPerSecond).toBe(256 * 1024)

    const job = repo.createJob({
      destinationId: dest.id,
      snapshotId: '2026-11-21T00-00-00Z_test1',
      status: 'paused',
      pauseReason: 'destination_unavailable',
      stagingDir: join(fixture.userDataDir, '.backup-staging', 'job-1')
    })

    repo.upsertJobUnit({
      jobId: job.id,
      unitKind: 'chunk',
      objectId: fixture.fileSha256,
      plaintextSha256: fixture.fileSha256,
      plaintextByteSize: fixture.fileBytes.length,
      storedByteSize: fixture.fileBytes.length,
      status: 'verified'
    })
    repo.upsertDestinationObject({
      destinationId: dest.id,
      objectId: fixture.fileSha256,
      storedByteSize: fixture.fileBytes.length,
      plaintextSha256: fixture.fileSha256,
      lastSnapshotId: job.snapshotId
    })

    fixture.catalog.close()

    const reopened = await reopenDatabase(fixture)
    try {
      const repo2 = reopened.catalog.getBackupRepository()
      const dest2 = repo2.getDestination(dest.id)
      expect(dest2?.name).toBe('NAS Share')
      expect(dest2?.maxBytesPerSecond).toBe(256 * 1024)

      const job2 = repo2.getJob(job.id)
      expect(job2?.status).toBe('paused')
      expect(job2?.pauseReason).toBe('destination_unavailable')

      const units2 = repo2.listJobUnits(job.id)
      expect(units2).toHaveLength(1)
      expect(units2[0]?.status).toBe('verified')

      const obj2 = repo2.getDestinationObject(dest.id, fixture.fileSha256)
      expect(obj2?.storedByteSize).toBe(fixture.fileBytes.length)
    } finally {
      reopened.catalog.close()
    }
  })

  it('T5a: pre-flight unavailable destination queues job as queued_destination_unavailable with zero staging created, survives DB reopen, and completes on reconnect', async () => {
    const fixture = await createCoordinatorFixture()
    tempDirs.push(fixture.rootDir)

    const disconnectedParent = join(fixture.rootDir, 'usb-mount-offline')
    const disconnectedDest = join(disconnectedParent, 'PersonalVaultBackup')

    const coord1 = new BackupCoordinator({
      catalog: fixture.catalog,
      userDataDir: fixture.userDataDir,
      appVersion: '1.0.0'
    })
    coord1.initialize()

    const dest = coord1.configureDestination({
      name: 'Offline USB',
      kind: 'local_fs',
      targetPath: disconnectedDest
    })

    const queuedJob = await coord1.startBackup(dest.id, {
      snapshotId: 'snap-t5a-1'
    })
    expect(queuedJob.status).toBe('queued_destination_unavailable')
    expect(queuedJob.stagingDir).toBeNull()
    expect(existsSync(join(fixture.userDataDir, '.backup-staging', queuedJob.id))).toBe(false)

    await coord1.shutdown()
    fixture.catalog.close()

    // Reopen DB across restart
    const reopened = await reopenDatabase(fixture)
    try {
      const coord2 = new BackupCoordinator({
        catalog: reopened.catalog,
        userDataDir: fixture.userDataDir,
        appVersion: '1.0.0'
      })
      coord2.initialize()

      const persisted = coord2.getJob(queuedJob.id)
      expect(persisted?.status).toBe('queued_destination_unavailable')
      expect(existsSync(join(fixture.userDataDir, '.backup-staging', queuedJob.id))).toBe(false)

      // Destination comes online
      mkdirSync(disconnectedDest, { recursive: true })
      await coord2.resumeBackup(queuedJob.id)
      const completed = await coord2.waitForCompletion()
      expect(completed?.status).toBe('completed')
      expect(completed?.snapshotId).toBe('snap-t5a-1')
      expect(completed?.verificationScope).toBe('full_readback')
      expect(inspectRecoveryPointStatus(disconnectedDest, 'snap-t5a-1').isComplete).toBe(true)
      expect(existsSync(join(fixture.userDataDir, '.backup-staging', queuedJob.id))).toBe(false)

      await coord2.shutdown()
    } finally {
      reopened.catalog.close()
    }
  })

  it('T5b: disconnect during transfer pauses job, retains staging across DB close/reopen, validates ownership & re-verifies chunks, and finishes same snapshotId without touching prior recovery point', async () => {
    const fixture = await createCoordinatorFixture()
    tempDirs.push(fixture.rootDir)

    const coord1 = new BackupCoordinator({
      catalog: fixture.catalog,
      userDataDir: fixture.userDataDir,
      appVersion: '1.0.0'
    })
    coord1.initialize()

    const dest = coord1.configureDestination({
      name: 'USB Drive',
      kind: 'local_fs',
      targetPath: fixture.backupDir
    })

    // 1. Complete Recovery Point 1 (S1)
    await coord1.startBackup(dest.id, { snapshotId: 'snap-t5b-1' })
    const s1Result = await coord1.waitForCompletion()
    expect(s1Result?.status).toBe('completed')
    expect(inspectRecoveryPointStatus(fixture.backupDir, 'snap-t5b-1').isComplete).toBe(true)
    const s1CompleteBefore = readFileSync(
      join(fixture.backupDir, BACKUP_SNAPSHOTS_DIR, 'snap-t5b-1', 'complete.json'),
      'utf8'
    )

    // 2. Add a second file/annotation so S2 has new chunks to transfer
    const extraBytes = Buffer.from('extra-payload-for-t5b-disconnect-test', 'utf8')
    const extraFile = join(fixture.sourceDir, 'extra.txt')
    writeFileSync(extraFile, extraBytes)

    // 3. Inject mid-transfer disconnect (ERROR_NETNAME_DELETED) on second chunk write
    let chunkWriteCount = 0
    const s2Job = await coord1.startBackup(dest.id, {
      snapshotId: 'snap-t5b-2',
      hooks: {
        onBeforeChunkWrite: () => {
          chunkWriteCount += 1
          if (chunkWriteCount >= 1) {
            const err = new Error(
              'The specified network name is no longer available'
            ) as NodeJS.ErrnoException
            err.code = 'ERROR_NETNAME_DELETED'
            throw err
          }
        }
      }
    })
    const pausedJob = await coord1.waitForCompletion()
    expect(pausedJob?.id).toBe(s2Job.id)
    expect(pausedJob?.status).toBe('paused')
    expect(pausedJob?.pauseReason).toBe('destination_unavailable')

    const stagingDir = join(fixture.userDataDir, '.backup-staging', s2Job.id)
    expect(existsSync(join(stagingDir, 'staging-manifest.json'))).toBe(true)
    expect(existsSync(join(stagingDir, 'vault-catalog.sqlite'))).toBe(true)
    expect(
      existsSync(
        join(
          fixture.backupDir,
          BACKUP_SNAPSHOTS_DIR,
          'snap-t5b-2',
          BACKUP_SNAPSHOT_IN_PROGRESS_FILE
        )
      )
    ).toBe(true)
    expect(inspectRecoveryPointStatus(fixture.backupDir, 'snap-t5b-2').isComplete).toBe(false)
    expect(inspectRecoveryPointStatus(fixture.backupDir, 'snap-t5b-1').isComplete).toBe(true)

    // Also create an orphaned staging dir and a terminal staging dir to verify initialize() cleanup boundary
    const orphanStagingDir = join(fixture.userDataDir, '.backup-staging', 'orphan-job-id')
    mkdirSync(orphanStagingDir, { recursive: true })
    writeFileSync(join(orphanStagingDir, 'junk.txt'), 'orphan')

    await coord1.shutdown()
    fixture.catalog.close()

    // 4. Reopen DB and initialize BackupCoordinator
    const reopened = await reopenDatabase(fixture)
    try {
      const coord2 = new BackupCoordinator({
        catalog: reopened.catalog,
        userDataDir: fixture.userDataDir,
        appVersion: '1.0.0'
      })
      const initSummary = coord2.initialize()
      expect(initSummary.cleanedStagingDirs).toContain('orphan-job-id')
      expect(existsSync(orphanStagingDir)).toBe(false)
      // Retained paused staging MUST survive initialize()
      expect(existsSync(join(stagingDir, 'staging-manifest.json'))).toBe(true)

      // Collision protection: fresh startBackup with S1 or S2 must fail with destination_collision
      await expect(
        (async () => {
          await coord2.startBackup(dest.id, { snapshotId: 'snap-t5b-1' })
          return await coord2.waitForCompletion()
        })()
      ).resolves.toMatchObject({ status: 'failed', errorCode: 'destination_collision' })

      // Resume S2 cleanly after reconnect
      await coord2.resumeBackup(s2Job.id)
      const resumedDone = await coord2.waitForCompletion()
      expect(resumedDone?.id).toBe(s2Job.id)
      expect(resumedDone?.status).toBe('completed')
      expect(resumedDone?.snapshotId).toBe('snap-t5b-2')
      expect(resumedDone?.verificationScope).toBe('full_readback')
      expect(resumedDone?.reusedChunkCount).toBeGreaterThan(0)

      expect(inspectRecoveryPointStatus(fixture.backupDir, 'snap-t5b-2').isComplete).toBe(true)
      expect(inspectRecoveryPointStatus(fixture.backupDir, 'snap-t5b-1').isComplete).toBe(true)
      expect(
        readFileSync(
          join(fixture.backupDir, BACKUP_SNAPSHOTS_DIR, 'snap-t5b-1', 'complete.json'),
          'utf8'
        )
      ).toBe(s1CompleteBefore)
      expect(existsSync(stagingDir)).toBe(false)

      await coord2.shutdown()
    } finally {
      reopened.catalog.close()
    }
  })

  it('T5b-ownership: refuses resuming a snapshot directory whose .pv-snapshot-in-progress.json belongs to another job', async () => {
    const fixture = await createCoordinatorFixture()
    tempDirs.push(fixture.rootDir)

    const coord = new BackupCoordinator({
      catalog: fixture.catalog,
      userDataDir: fixture.userDataDir,
      appVersion: '1.0.0'
    })
    coord.initialize()

    const dest = coord.configureDestination({
      name: 'USB Drive',
      kind: 'local_fs',
      targetPath: fixture.backupDir
    })

    const job = await coord.startBackup(dest.id, {
      snapshotId: 'snap-ownership-test',
      hooks: {
        onBeforeChunkWrite: () => {
          const err = new Error('Connection reset') as NodeJS.ErrnoException
          err.code = 'ECONNRESET'
          throw err
        }
      }
    })
    const paused = await coord.waitForCompletion()
    expect(paused?.status).toBe('paused')

    // Tamper .pv-snapshot-in-progress.json so it belongs to a different jobId
    const markerPath = join(
      fixture.backupDir,
      BACKUP_SNAPSHOTS_DIR,
      'snap-ownership-test',
      BACKUP_SNAPSHOT_IN_PROGRESS_FILE
    )
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    marker.jobId = 'different-owner-job-id'
    writeFileSync(markerPath, JSON.stringify(marker, null, 2))

    await coord.resumeBackup(job.id)
    const failed = await coord.waitForCompletion()
    expect(failed?.status).toBe('failed')
    expect(failed?.errorCode).toBe('destination_collision')

    await coord.shutdown()
    fixture.catalog.close()
  })

  it('T5c: missing or corrupt staging on restart marks old snapshot abandoned, cleans broken staging, and completes a fresh backup under a new snapshotId reusing verified chunks', async () => {
    const fixture = await createCoordinatorFixture()
    tempDirs.push(fixture.rootDir)

    const coord1 = new BackupCoordinator({
      catalog: fixture.catalog,
      userDataDir: fixture.userDataDir,
      appVersion: '1.0.0'
    })
    coord1.initialize()

    const dest = coord1.configureDestination({
      name: 'USB Drive',
      kind: 'local_fs',
      targetPath: fixture.backupDir
    })

    // Complete Recovery Point 1
    await coord1.startBackup(dest.id, { snapshotId: 'snap-t5c-1' })
    const s1 = await coord1.waitForCompletion()
    expect(s1?.status).toBe('completed')

    // Start Recovery Point 2 and disconnect mid-transfer
    const s2Job = await coord1.startBackup(dest.id, {
      snapshotId: 'snap-t5c-2',
      hooks: {
        onBeforeChunkWrite: () => {
          const err = new Error('ENOENT: drive disconnected') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
      }
    })
    const paused = await coord1.waitForCompletion()
    expect(paused?.status).toBe('paused')

    const brokenStagingDir = join(fixture.userDataDir, '.backup-staging', s2Job.id)
    expect(existsSync(join(brokenStagingDir, 'vault-catalog.sqlite'))).toBe(true)

    await coord1.shutdown()
    fixture.catalog.close()

    // Corrupt staged vault-catalog.sqlite while offline
    unlinkSync(join(brokenStagingDir, 'vault-catalog.sqlite'))

    // Reopen DB and resume
    const reopened = await reopenDatabase(fixture)
    try {
      const coord2 = new BackupCoordinator({
        catalog: reopened.catalog,
        userDataDir: fixture.userDataDir,
        appVersion: '1.0.0'
      })
      coord2.initialize()

      const replacementJob = await coord2.resumeBackup(s2Job.id)
      const replacementDone = await coord2.waitForCompletion()

      const oldJobAfter = coord2.getJob(s2Job.id)
      expect(oldJobAfter?.status).toBe('abandoned')
      expect(existsSync(brokenStagingDir)).toBe(false)

      expect(replacementJob.id).not.toBe(s2Job.id)
      expect(replacementJob.snapshotId).not.toBe('snap-t5c-2')
      expect(replacementJob.abandonedFromJobId).toBe(s2Job.id)
      expect(replacementDone?.status).toBe('completed')
      expect(replacementDone?.reusedChunkCount).toBeGreaterThan(0)

      expect(inspectRecoveryPointStatus(fixture.backupDir, 'snap-t5c-1').isComplete).toBe(true)
      expect(inspectRecoveryPointStatus(fixture.backupDir, 'snap-t5c-2').isComplete).toBe(false)
      expect(
        inspectRecoveryPointStatus(fixture.backupDir, replacementJob.snapshotId).isComplete
      ).toBe(true)

      await coord2.shutdown()
    } finally {
      reopened.catalog.close()
    }
  })

  it('abruptly running job at DB reopen transitions to interrupted via initialize(), retains staging, and resumes to completion', async () => {
    const fixture = await createCoordinatorFixture()
    tempDirs.push(fixture.rootDir)

    const coord1 = new BackupCoordinator({
      catalog: fixture.catalog,
      userDataDir: fixture.userDataDir,
      appVersion: '1.0.0'
    })
    coord1.initialize()

    const dest = coord1.configureDestination({
      name: 'USB Drive',
      kind: 'local_fs',
      targetPath: fixture.backupDir
    })

    // Simulate a job that was paused/interrupted with valid staging
    const job = await coord1.startBackup(dest.id, {
      snapshotId: 'snap-interrupted-1',
      hooks: {
        onBeforeChunkWrite: () => {
          const err = new Error('ECONNRESET') as NodeJS.ErrnoException
          err.code = 'ECONNRESET'
          throw err
        }
      }
    })
    await coord1.waitForCompletion()
    await coord1.shutdown()

    // Force status back to 'running' in DB to simulate an ungraceful process crash
    fixture.catalog
      .getRawDb()
      .prepare("UPDATE backup_jobs SET status = 'running', pause_reason = NULL WHERE id = ?")
      .run(job.id)
    fixture.catalog.close()

    const reopened = await reopenDatabase(fixture)
    try {
      const coord2 = new BackupCoordinator({
        catalog: reopened.catalog,
        userDataDir: fixture.userDataDir,
        appVersion: '1.0.0'
      })
      const initSummary = coord2.initialize()
      expect(initSummary.interruptedCount).toBe(1)

      const interruptedJob = coord2.getJob(job.id)
      expect(interruptedJob?.status).toBe('interrupted')
      expect(
        existsSync(join(fixture.userDataDir, '.backup-staging', job.id, 'staging-manifest.json'))
      ).toBe(true)

      await coord2.resumeBackup(job.id)
      const completed = await coord2.waitForCompletion()
      expect(completed?.status).toBe('completed')
      expect(completed?.snapshotId).toBe('snap-interrupted-1')
      expect(inspectRecoveryPointStatus(fixture.backupDir, 'snap-interrupted-1').isComplete).toBe(
        true
      )

      await coord2.shutdown()
    } finally {
      reopened.catalog.close()
    }
  })

  it('wires AsyncCaptureGuard into VaultImportCoordinator and serializes capture-window execution', async () => {
    const fixture = await createCoordinatorFixture()
    tempDirs.push(fixture.rootDir)

    const { VaultImportCoordinator } = await import('../../src/main/services/vault/coordinator')
    const importCoord = new VaultImportCoordinator({ catalog: fixture.catalog })
    const backupCoord = new BackupCoordinator({
      catalog: fixture.catalog,
      userDataDir: fixture.userDataDir,
      appVersion: '1.0.0',
      vaultImportCoordinator: importCoord
    })

    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const guard = backupCoord.getCaptureGuard()
    const p1 = guard.runExclusive(async () => {
      order.push('first-start')
      await firstGate
      order.push('first-end')
    })
    const p2 = guard.runExclusive(async () => {
      order.push('second-start')
      order.push('second-end')
    })

    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(['first-start'])
    releaseFirst()
    await Promise.all([p1, p2])
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end'])

    await backupCoord.shutdown()
    fixture.catalog.close()
  })

  it('reconciles a backup that published complete.json on disk before SQLite commit (both with staging present and staging missing), idempotently and without creating a new snapshot', async () => {
    for (const removeStagingBeforeRestart of [false, true]) {
      const fixture = await createCoordinatorFixture()
      tempDirs.push(fixture.rootDir)

      const coord1 = new BackupCoordinator({
        catalog: fixture.catalog,
        userDataDir: fixture.userDataDir,
        appVersion: '1.0.0'
      })
      coord1.initialize()

      const dest = coord1.configureDestination({
        name: 'USB Drive',
        kind: 'local_fs',
        targetPath: fixture.backupDir
      })

      const job = await coord1.startBackup(dest.id, { snapshotId: 'snap-reconcile-1' })
      const done = await coord1.waitForCompletion()
      expect(done?.status).toBe('completed')

      const completePath = join(
        fixture.backupDir,
        BACKUP_SNAPSHOTS_DIR,
        'snap-reconcile-1',
        'complete.json'
      )
      const completeBytesBefore = readFileSync(completePath, 'utf8')
      const completeMtimeBefore = statSync(completePath).mtimeMs

      // Simulate crash right after on-disk publication, before SQLite commit:
      // revert backup_jobs & backup_destinations in SQLite to pre-commit state.
      const stagingDir = join(fixture.userDataDir, '.backup-staging', job.id)
      if (!removeStagingBeforeRestart) {
        mkdirSync(stagingDir, { recursive: true })
        writeFileSync(join(stagingDir, 'marker.tmp'), 'leftover-staging')
      }
      fixture.catalog
        .getRawDb()
        .prepare(
          `UPDATE backup_jobs
           SET status = 'running',
               verification_scope = NULL,
               manifest_sha256 = NULL,
               completed_at_ms = NULL,
               staging_dir = ?
           WHERE id = ?`
        )
        .run(stagingDir, job.id)
      fixture.catalog
        .getRawDb()
        .prepare(
          `UPDATE backup_destinations
           SET last_verified_snapshot_id = NULL,
               last_verified_at_ms = NULL
           WHERE id = ?`
        )
        .run(dest.id)

      await coord1.shutdown()
      fixture.catalog.close()

      // Reopen real catalog & coordinator
      const reopened = await reopenDatabase(fixture)
      try {
        const coord2 = new BackupCoordinator({
          catalog: reopened.catalog,
          userDataDir: fixture.userDataDir,
          appVersion: '1.0.0'
        })
        const initSummary = coord2.initialize()
        expect(initSummary.interruptedCount).toBe(1)

        const reconciled1 = await coord2.resumeBackup(job.id)
        expect(reconciled1.id).toBe(job.id)
        expect(reconciled1.snapshotId).toBe('snap-reconcile-1')
        expect(reconciled1.status).toBe('completed')
        expect(reconciled1.verificationScope).toBe('full_readback')

        // Idempotent second call
        const reconciled2 = await coord2.resumeBackup(job.id)
        expect(reconciled2.id).toBe(job.id)
        expect(reconciled2.status).toBe('completed')

        // Destination last_verified_snapshot_id updated, staging cleaned, no new snapshot created
        const destAfter = coord2.getDestination(dest.id)
        expect(destAfter?.lastVerifiedSnapshotId).toBe('snap-reconcile-1')
        expect(existsSync(stagingDir)).toBe(false)
        expect(coord2.listJobs({ destinationId: dest.id }).total).toBe(1)

        // Backup files on disk untouched
        expect(readFileSync(completePath, 'utf8')).toBe(completeBytesBefore)
        expect(statSync(completePath).mtimeMs).toBe(completeMtimeBefore)

        await coord2.shutdown()
      } finally {
        reopened.catalog.close()
      }
    }
  })

  it('never adopts a foreign or corrupt snapshot during reconciliation and keeps unavailable destinations recoverable', async () => {
    // 1. Foreign snapshot (different repositoryId / no matching job units) must NOT be adopted
    const f1 = await createCoordinatorFixture()
    tempDirs.push(f1.rootDir)
    const c1 = new BackupCoordinator({
      catalog: f1.catalog,
      userDataDir: f1.userDataDir,
      appVersion: '1.0.0'
    })
    c1.initialize()
    const d1 = c1.configureDestination({
      name: 'Foreign Repo USB',
      kind: 'local_fs',
      targetPath: f1.backupDir
    })
    await c1.startBackup(d1.id, { snapshotId: 'snap-foreign-1' })
    await c1.waitForCompletion()

    // Create a second job in SQLite pointing at the same snapshotId, but with a different repositoryId and no units
    const foreignJob = f1.catalog.getBackupRepository().createJob({
      destinationId: d1.id,
      snapshotId: 'snap-foreign-1',
      repositoryId: randomUUID(),
      status: 'interrupted',
      stagingDir: null
    })
    const resumedForeign = await c1.resumeBackup(foreignJob.id)
    const foreignResult = await c1.waitForCompletion()
    // Should NOT adopt snap-foreign-1 as foreignJob completed; instead abandons & creates new snapshot
    expect(f1.catalog.getBackupRepository().getJob(foreignJob.id)?.status).toBe('abandoned')
    expect(resumedForeign.id).not.toBe(foreignJob.id)
    expect(resumedForeign.snapshotId).not.toBe('snap-foreign-1')
    expect(foreignResult?.status).toBe('completed')
    await c1.shutdown()
    f1.catalog.close()

    // 2. Corrupt snapshot on disk must NOT be adopted
    const f2 = await createCoordinatorFixture()
    tempDirs.push(f2.rootDir)
    const c2 = new BackupCoordinator({
      catalog: f2.catalog,
      userDataDir: f2.userDataDir,
      appVersion: '1.0.0'
    })
    c2.initialize()
    const d2 = c2.configureDestination({
      name: 'Corrupt USB',
      kind: 'local_fs',
      targetPath: f2.backupDir
    })
    const j2 = await c2.startBackup(d2.id, { snapshotId: 'snap-corrupt-1' })
    await c2.waitForCompletion()

    // Flip a byte in a .pvchunk object on disk and revert job to interrupted with missing staging
    const objPrefixDir = join(f2.backupDir, BACKUP_OBJECTS_DIR)
    const firstPrefix = (await import('node:fs')).readdirSync(objPrefixDir)[0]!
    const firstChunk = (await import('node:fs')).readdirSync(join(objPrefixDir, firstPrefix))[0]!
    const chunkPath = join(objPrefixDir, firstPrefix, firstChunk)
    const chunkBuf = readFileSync(chunkPath)
    chunkBuf[0] = chunkBuf[0]! ^ 0xff
    writeFileSync(chunkPath, chunkBuf)

    f2.catalog
      .getRawDb()
      .prepare("UPDATE backup_jobs SET status = 'interrupted', staging_dir = NULL WHERE id = ?")
      .run(j2.id)

    const replacement2 = await c2.resumeBackup(j2.id)
    await c2.waitForCompletion()
    expect(f2.catalog.getBackupRepository().getJob(j2.id)?.status).toBe('abandoned')
    expect(replacement2.snapshotId).not.toBe('snap-corrupt-1')
    await c2.shutdown()
    f2.catalog.close()

    // 3. Unavailable destination during crash window remains recoverable when reconnected
    const f3 = await createCoordinatorFixture()
    tempDirs.push(f3.rootDir)
    const offlineDir = join(f3.rootDir, 'removable-drive')
    mkdirSync(offlineDir, { recursive: true })
    const c3 = new BackupCoordinator({
      catalog: f3.catalog,
      userDataDir: f3.userDataDir,
      appVersion: '1.0.0'
    })
    c3.initialize()
    const d3 = c3.configureDestination({
      name: 'Removable USB',
      kind: 'local_fs',
      targetPath: offlineDir
    })
    const j3 = await c3.startBackup(d3.id, { snapshotId: 'snap-unavail-reconcile' })
    await c3.waitForCompletion()

    f3.catalog
      .getRawDb()
      .prepare("UPDATE backup_jobs SET status = 'interrupted', staging_dir = NULL WHERE id = ?")
      .run(j3.id)

    // Simulate destination disconnected (rename away temporarily)
    const parkedDir = join(f3.rootDir, 'removable-drive-parked')
    ;(await import('node:fs')).renameSync(offlineDir, parkedDir)

    const pausedOnUnavail = await c3.resumeBackup(j3.id)
    expect(pausedOnUnavail.status).toBe('paused')
    expect(pausedOnUnavail.pauseReason).toBe('destination_unavailable')

    // Reconnect destination and reconcile cleanly
    ;(await import('node:fs')).renameSync(parkedDir, offlineDir)
    const recovered = await c3.resumeBackup(j3.id)
    expect(recovered.status).toBe('completed')
    expect(recovered.snapshotId).toBe('snap-unavail-reconcile')
    await c3.shutdown()
    f3.catalog.close()
  })

  it('upgrades a genuine v16 database with existing catalog records, export_jobs, and export_job_items to v17 without data loss', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'pv-8b-v16-v17-'))
    tempDirs.push(tempRoot)
    const dbPath = join(tempRoot, 'vault-catalog.db')
    const sourceRoot = join(tempRoot, 'sources')
    const vaultRoot = join(tempRoot, 'vault')
    const exportDir = join(tempRoot, 'export-bundle')
    mkdirSync(sourceRoot, { recursive: true })
    mkdirSync(vaultRoot, { recursive: true })

    const raw = new DatabaseSync(dbPath)
    raw.exec('PRAGMA foreign_keys = ON;')
    raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      );
    `)
    for (const m of MIGRATIONS.filter((mig) => mig.version <= 16)) {
      raw.exec('PRAGMA foreign_keys = OFF;')
      raw.exec('BEGIN TRANSACTION;')
      m.up(raw)
      raw
        .prepare('INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?);')
        .run(m.version, m.name, 1000)
      raw.exec('COMMIT;')
      raw.exec('PRAGMA foreign_keys = ON;')
    }

    const sha = 'a'.repeat(64)
    const vaultId = randomUUID()
    try {
      raw
        .prepare(
          'INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?);'
        )
        .run(sourceRoot, sourceRoot.toLowerCase(), 1000, 1000)
      raw
        .prepare(
          `INSERT INTO file_locations (
            source_id, original_path, normalized_path, file_name, extension, category,
            created_at_ms, updated_at_ms
          ) VALUES (1, ?, ?, 'v16-doc.pdf', '.pdf', 'document', 1000, 1000);`
        )
        .run(join(sourceRoot, 'v16-doc.pdf'), join(sourceRoot, 'v16-doc.pdf').toLowerCase())
      raw
        .prepare(
          `INSERT INTO discovery_observations (
            file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, observed_at_ms, last_seen_at_ms
          ) VALUES (1, 2048, 900, 950, 1000, 1000);`
        )
        .run()
      raw
        .prepare(
          `INSERT INTO hash_observations (
            file_location_id, discovery_observation_id, sha256, observed_byte_size, hashed_at_ms
          ) VALUES (1, 1, ?, 2048, 1000);`
        )
        .run(sha)
      raw
        .prepare(
          `INSERT INTO vaults (
            vault_id, vault_path, normalized_vault_path, name, is_active, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, 'V16 Vault', 1, 1000, 1000);`
        )
        .run(vaultId, vaultRoot, vaultRoot.toLowerCase())
      raw
        .prepare(
          `INSERT INTO vault_copies (
            vault_id, sha256, byte_size, relative_path, manifest_relative_path, verified_at_ms, created_at_ms, updated_at_ms
          ) VALUES (?, ?, 2048, 'files/aa/doc.pdf', 'files/aa/manifest.json', 1000, 1000, 1000);`
        )
        .run(vaultId, sha)
      raw
        .prepare(
          `INSERT INTO export_jobs (
            id, bundle_dir, bundle_folder_name, status, include_original_paths, include_extracted_text,
            manifest_published, bundle_verified, total_items, exported_items, failed_items,
            cancelled_items, vault_integrity_warnings, started_at_ms, updated_at_ms, completed_at_ms
          ) VALUES ('exp-v16-1', ?, 'export-bundle', 'completed', 0, 0, 1, 1, 1, 1, 0, 0, 0, 1000, 2000, 2000);`
        )
        .run(exportDir)
      raw
        .prepare(
          `INSERT INTO export_job_items (
            job_id, file_location_id, discovery_observation_id, hash_observation_id, category,
            original_file_name, expected_sha256, expected_byte_size, status, exported_file_name,
            sidecar_file_name, byte_source_used, updated_at_ms
          ) VALUES ('exp-v16-1', 1, 1, 1, 'document', 'v16-doc.pdf', ?, 2048, 'completed', 'v16-doc.pdf', 'v16-doc.json', 'vault_copy', 2000);`
        )
        .run(sha)
    } finally {
      raw.close()
    }

    const catalog = CatalogDatabase.open({ catalogPath: dbPath })
    try {
      const db = catalog.getRawDb()
      const versionRow = db
        .prepare('SELECT MAX(version) AS max_version FROM schema_migrations;')
        .get() as { max_version: number }
      expect(versionRow.max_version).toBe(17)

      const backupTables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
            'backup_destinations',
            'backup_jobs',
            'backup_job_units',
            'backup_destination_objects',
            'backup_bandwidth_ledger'
          ) ORDER BY name;`
        )
        .all() as Array<{ name: string }>
      expect(backupTables).toHaveLength(5)

      const loc = db
        .prepare('SELECT file_name, category FROM file_locations WHERE id = 1;')
        .get() as {
        file_name: string
        category: string
      }
      expect(loc).toEqual({ file_name: 'v16-doc.pdf', category: 'document' })

      const vault = db.prepare('SELECT vault_id, name FROM vaults WHERE is_active = 1;').get() as {
        vault_id: string
        name: string
      }
      expect(vault).toEqual({ vault_id: vaultId, name: 'V16 Vault' })

      const copy = db.prepare('SELECT sha256, byte_size FROM vault_copies WHERE id = 1;').get() as {
        sha256: string
        byte_size: number
      }
      expect(copy).toEqual({ sha256: sha, byte_size: 2048 })

      const exportJob = catalog.getExportRepository().getExportJob('exp-v16-1')
      expect(exportJob?.status).toBe('completed')
      expect(exportJob?.bundleVerified).toBe(true)
      expect(exportJob?.exportedItems).toBe(1)

      const exportItems = catalog.getExportRepository().getExportJobItems('exp-v16-1')
      expect(exportItems.total).toBe(1)
      expect(exportItems.items[0]?.originalFileName).toBe('v16-doc.pdf')
      expect(exportItems.items[0]?.expectedSha256).toBe(sha)
    } finally {
      catalog.close()
    }
  })

  it('rolls back both job completion and destination pointer when destination update fails during normal completion, then reconciles atomically on reopen', async () => {
    const fixture = await createCoordinatorFixture()
    tempDirs.push(fixture.rootDir)

    const coord1 = new BackupCoordinator({
      catalog: fixture.catalog,
      userDataDir: fixture.userDataDir,
      appVersion: '1.0.0'
    })
    coord1.initialize()

    const dest = coord1.configureDestination({
      name: 'USB Drive',
      kind: 'local_fs',
      targetPath: fixture.backupDir
    })

    // Force the destination pointer update to fail after the job row update inside the completion transaction
    fixture.catalog.getRawDb().exec(`
      CREATE TRIGGER fail_dest_pointer_update
      BEFORE UPDATE OF last_verified_snapshot_id ON backup_destinations
      WHEN NEW.last_verified_snapshot_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'simulated destination pointer failure');
      END;
    `)

    const job = await coord1.startBackup(dest.id, { snapshotId: 'snap-atomic-rollback-1' })
    await expect(coord1.waitForCompletion()).rejects.toThrow(
      /simulated destination pointer failure/
    )

    // Both backup_jobs and backup_destinations must be rolled back
    const jobAfterFail = coord1.getJob(job.id)
    expect(jobAfterFail?.status).toBe('running')
    expect(jobAfterFail?.completedAtMs).toBeNull()
    expect(jobAfterFail?.manifestSha256).toBeNull()

    const destAfterFail = coord1.getDestination(dest.id)
    expect(destAfterFail?.lastVerifiedSnapshotId).toBeNull()
    expect(destAfterFail?.lastVerifiedAtMs).toBeNull()

    fixture.catalog.getRawDb().exec('DROP TRIGGER fail_dest_pointer_update;')
    await coord1.shutdown()
    fixture.catalog.close()

    // Reopen catalog and recover via the existing reconciliation path
    const reopened = await reopenDatabase(fixture)
    try {
      const coord2 = new BackupCoordinator({
        catalog: reopened.catalog,
        userDataDir: fixture.userDataDir,
        appVersion: '1.0.0'
      })
      const initSummary = coord2.initialize()
      expect(initSummary.interruptedCount).toBe(1)

      const reconciled = await coord2.resumeBackup(job.id)
      expect(reconciled.id).toBe(job.id)
      expect(reconciled.snapshotId).toBe('snap-atomic-rollback-1')
      expect(reconciled.status).toBe('completed')
      expect(reconciled.writtenChunkCount).toBeGreaterThan(0)
      expect(reconciled.verificationScope).toBe('full_readback')

      const destAfterRecover = coord2.getDestination(dest.id)
      expect(destAfterRecover?.lastVerifiedSnapshotId).toBe('snap-atomic-rollback-1')
      expect(destAfterRecover?.lastVerifiedAtMs).toBe(reconciled.completedAtMs)
      expect(coord2.listJobs({ destinationId: dest.id }).total).toBe(1)

      await coord2.shutdown()
    } finally {
      reopened.catalog.close()
    }
  })
})
