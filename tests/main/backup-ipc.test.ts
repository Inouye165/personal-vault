// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import { registerBackupIpcHandlers } from '../../src/main/ipc/backup-handlers'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import { BackupCoordinator } from '../../src/main/services/backup/coordinator'
import { inspectRestoredProfileStatus } from '../../src/main/services/backup/restore'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { initializeVault } from '../../src/main/services/vault/identity'
import { writeVaultManifest } from '../../src/main/services/vault/manifest'
import type { VaultManifest } from '../../src/main/services/vault/types'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

async function createPopulatedProfile(baseDir: string) {
  const userDataDir = join(baseDir, 'userData')
  const sourceDir = join(baseDir, 'source')
  const vaultDir = join(baseDir, 'vault')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })

  const photoBytes = Buffer.from('stage-8b-1c-ipc-test-photo-payload')
  const photoSha = createHash('sha256').update(photoBytes).digest('hex')
  const sourcePath = join(sourceDir, 'sample.jpg')
  writeFileSync(sourcePath, photoBytes)

  const journal = new AnnotationJournal({
    storageDir: join(userDataDir, 'annotations'),
    sourceRoots: () => [sourceDir],
    vaultPath: () => vaultDir
  })
  await journal.initialize()

  const catalog = CatalogDatabase.open({
    catalogPath: join(userDataDir, 'vault-catalog.db'),
    journal
  })

  const now = Date.now()
  catalog.persistDiscoveryBatch(sourceDir, [
    {
      originalPath: sourcePath,
      fileName: 'sample.jpg',
      extension: '.jpg',
      category: 'photo',
      byteSize: photoBytes.length,
      birthtimeMs: now - 5000,
      mtimeMs: now - 5000,
      discoveredAtMs: now
    }
  ])

  const importedLoc = catalog.queryFileLocations({ limit: 10 }).items[0]!
  catalog.recordHashObservationsBatch([
    {
      originalPath: sourcePath,
      sha256: photoSha,
      observedByteSize: photoBytes.length,
      observedMtimeMs: importedLoc.filesystemMtimeMs,
      hashedAtMs: now
    }
  ])
  const hashObs = catalog.getHashObservationsForFile(importedLoc.id).items[0]!

  const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Primary Vault' })
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
    totalBytes: photoBytes.length,
    items: [
      {
        fileLocationId: importedLoc.id,
        discoveryObservationId: importedLoc.discoveryObservationId,
        hashObservationId: hashObs.id,
        sha256: photoSha,
        byteSize: photoBytes.length
      }
    ]
  })

  const prefix = photoSha.slice(0, 2)
  const payloadRel = `files/${prefix}/${photoSha}/sample.jpg`
  const manifestRel = `files/${prefix}/${photoSha}/manifest.json`
  mkdirSync(join(vaultDir, 'files', prefix, photoSha), { recursive: true })
  writeFileSync(join(vaultDir, payloadRel), photoBytes)

  const manifest: VaultManifest = {
    formatVersion: 1,
    vaultId,
    sha256: photoSha,
    byteSize: photoBytes.length,
    managedCopy: {
      relativePath: payloadRel,
      fileName: 'sample.jpg',
      publishedAtMs: now,
      verifiedSha256: photoSha,
      verifiedByteSize: photoBytes.length
    },
    sources: [
      {
        fileLocationId: importedLoc.id,
        originalPath: sourcePath,
        fileName: 'sample.jpg',
        extension: '.jpg',
        category: 'photo',
        recordedFacts: {
          byteSize: photoBytes.length,
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
          verifiedSourceSha256: photoSha,
          verifiedSourceByteSize: photoBytes.length,
          sourceStability: {
            preCopyMtimeMs: importedLoc.filesystemMtimeMs ?? 0,
            postCopyMtimeMs: importedLoc.filesystemMtimeMs ?? 0,
            preCopyByteSize: photoBytes.length,
            postCopyByteSize: photoBytes.length
          }
        }
      }
    ]
  }
  writeVaultManifest(vaultDir, manifest, importJob.id)

  const vaultCopy = catalog.recordVaultCopy({
    vaultId,
    sha256: photoSha,
    byteSize: photoBytes.length,
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
    expectedRevision: `rev:${importedLoc.discoveryObservationId}:${photoBytes.length}:${importedLoc.filesystemMtimeMs}:${photoSha}`,
    expectedVersion: 0,
    rating: 5,
    flag: 'pick'
  })

  return { userDataDir, vaultDir, catalog, photoSha, photoBytes }
}

describe('Stage 8B Sub-slice 1C — Backup & Restore IPC handlers', () => {
  it('rejects untrusted senders and event-only channel invocations', async () => {
    const fakeHandlers = new Map<string, (...args: unknown[]) => Promise<unknown> | unknown>()
    registerBackupIpcHandlers({
      handle: (ch, fn) => {
        fakeHandlers.set(ch, async (event: unknown, ...rest: unknown[]) => {
          if (event === 'untrusted') {
            throw new Error(`Unauthorized IPC sender for ${ch}`)
          }
          return fn(...rest)
        })
      }
    })

    const startHandler = fakeHandlers.get(IPC_CHANNELS.BACKUP_START)!
    await expect(startHandler('untrusted', { destinationId: 'x' })).rejects.toThrow(
      /Unauthorized IPC sender/
    )

    const progressHandler = fakeHandlers.get(IPC_CHANNELS.BACKUP_PROGRESS_EVENT)!
    await expect(progressHandler('trusted')).rejects.toThrow(/Event-only channel/)
    expect(typeof registerIpcHandlers).toBe('function')
  })

  it('configures destination, runs backup, lists/verifies recovery point, and restores to isolated profile', async () => {
    const baseDir = makeTempDir('pv-1c-ipc-')
    const { userDataDir, catalog, photoSha, photoBytes } = await createPopulatedProfile(baseDir)
    const backupRepoDir = join(baseDir, 'backup-usb')
    const restoreProfileDir = join(baseDir, 'restored-profile')
    const restoreVaultDir = join(baseDir, 'restored-vault')
    mkdirSync(backupRepoDir, { recursive: true })

    const backupCoordinator = new BackupCoordinator({
      catalog,
      userDataDir,
      appVersion: '0.1.0'
    })
    backupCoordinator.initialize()

    try {
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown> | unknown>()
      registerBackupIpcHandlers({
        handle: (ch, fn) => handlers.set(ch, fn),
        backupCoordinator,
        catalog,
        userDataDir,
        selectBackupDirectory: async () => ({ canceled: false, directoryPath: backupRepoDir })
      })

      const listJobs = handlers.get(IPC_CHANNELS.BACKUP_LIST_JOBS)!
      expect(await listJobs({ limit: 20, offset: 0 })).toEqual({
        items: [],
        total: 0,
        limit: 20,
        offset: 0
      })

      const picked = (await handlers.get(IPC_CHANNELS.BACKUP_SELECT_DIRECTORY)!({
        title: 'Pick'
      })) as { canceled: boolean; directoryPath: string | null }
      expect(picked).toEqual({ canceled: false, directoryPath: backupRepoDir })

      const dest = (await handlers.get(IPC_CHANNELS.BACKUP_CONFIGURE_DESTINATION)!({
        name: 'Test USB',
        kind: 'local_fs',
        targetPath: backupRepoDir,
        maxBytesPerSecond: null
      })) as { id: string }

      const job = (await handlers.get(IPC_CHANNELS.BACKUP_START)!({
        destinationId: dest.id
      })) as { id: string; snapshotId: string }

      const deadline = Date.now() + 15_000
      let current = (await handlers.get(IPC_CHANNELS.BACKUP_GET_JOB)!({ jobId: job.id })) as {
        status: string
      }
      while (Date.now() < deadline) {
        if (current.status === 'completed' || current.status === 'failed') break
        await new Promise((r) => setTimeout(r, 50))
        current = (await handlers.get(IPC_CHANNELS.BACKUP_GET_JOB)!({ jobId: job.id })) as {
          status: string
        }
      }
      expect(current.status).toBe('completed')
      expect(await listJobs({})).toMatchObject({
        items: [{ id: job.id, status: 'completed' }],
        total: 1,
        limit: 50,
        offset: 0
      })
      expect(await listJobs({ limit: 1, offset: 1 })).toEqual({
        items: [],
        total: 1,
        limit: 1,
        offset: 1
      })

      const listRes = (await handlers.get(IPC_CHANNELS.BACKUP_LIST_RECOVERY_POINTS)!({
        backupRepoDir
      })) as { recoveryPoints: Array<{ snapshotId: string; isComplete: boolean }> }
      expect(listRes.recoveryPoints).toHaveLength(1)
      expect(listRes.recoveryPoints[0]!.isComplete).toBe(true)

      const verifyRes = (await handlers.get(IPC_CHANNELS.BACKUP_VERIFY_RECOVERY_POINT)!({
        backupRepoDir,
        snapshotId: job.snapshotId
      })) as { snapshotId: string; verifiedFileCount: number; hasVault: boolean }
      expect(verifyRes.snapshotId).toBe(job.snapshotId)
      expect(verifyRes.verifiedFileCount).toBeGreaterThanOrEqual(4)
      expect(verifyRes.hasVault).toBe(true)

      const restoreRes = (await handlers.get(IPC_CHANNELS.BACKUP_RESTORE_RECOVERY_POINT)!({
        backupRepoDir,
        snapshotId: job.snapshotId,
        targetProfileDir: restoreProfileDir,
        targetVaultDir: restoreVaultDir
      })) as { verifiedFileCount: number; restoredProfilePath: string }
      expect(restoreRes.verifiedFileCount).toBeGreaterThanOrEqual(4)
      expect(restoreRes.restoredProfilePath).toBe(restoreProfileDir)
      expect(inspectRestoredProfileStatus(restoreProfileDir, restoreVaultDir).status).toBe(
        'complete'
      )

      const restoredFile = join(
        restoreVaultDir,
        'files',
        photoSha.slice(0, 2),
        photoSha,
        'sample.jpg'
      )
      expect(readFileSync(restoredFile)).toEqual(photoBytes)

      // Recover catalog directly from the surviving vault via BACKUP_RECOVER_CATALOG_FROM_VAULT IPC
      const recoveredProfileDir = join(baseDir, 'recovered-from-vault-profile')
      const recoverRes = (await handlers.get(IPC_CHANNELS.BACKUP_RECOVER_CATALOG_FROM_VAULT)!({
        sourceVaultDir: restoreVaultDir,
        targetProfileDir: recoveredProfileDir
      })) as {
        recoveredVaultCopies: number
        recoveredFileLocations: number
        targetProfileDir: string
        currentVersionSelectionNote: string
      }
      expect(recoverRes.recoveredVaultCopies).toBe(1)
      expect(recoverRes.recoveredFileLocations).toBe(1)
      expect(recoverRes.targetProfileDir).toBe(recoveredProfileDir)
      expect(recoverRes.currentVersionSelectionNote).toBe('inferred_from_manifest_evidence')
    } finally {
      await backupCoordinator.shutdown()
      catalog.close()
    }
  })
})
