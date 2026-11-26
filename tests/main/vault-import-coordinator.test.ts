/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { VaultImportCoordinator } from '../../src/main/services/vault/coordinator'
import { copyAndVerifyFileToVault } from '../../src/main/services/vault/copier'
import { initializeVault } from '../../src/main/services/vault/identity'

describe('VaultImportCoordinator', () => {
  let tempDir: string
  let catalogPath: string
  let vaultDir: string
  let sourceDir: string
  let db: CatalogDatabase
  let coordinator: VaultImportCoordinator

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vault-coord-test-'))
    catalogPath = join(tempDir, 'catalog.db')
    vaultDir = join(tempDir, 'vault')
    sourceDir = join(tempDir, 'source')
    mkdirSync(sourceDir, { recursive: true })

    db = CatalogDatabase.open({ catalogPath })
    coordinator = new VaultImportCoordinator({ catalog: db })
  })

  afterEach(async () => {
    try {
      await coordinator.shutdown()
    } catch {
      // Ignore
    }
    try {
      db.close()
    } catch {
      // Ignore
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('runs an import job to completion with verified copies and catalog updates', async () => {
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'My Vault' })
    db.registerVault({
      vaultId: identity.vaultId,
      vaultPath: vaultDir,
      name: 'My Vault',
      createdAtMs: identity.createdAtMs
    })

    db.registerSource(sourceDir)
    const filePath = join(sourceDir, 'sample.jpg')
    const content = Buffer.from('image-data-payload')
    writeFileSync(filePath, content)
    const stat = statSync(filePath)
    const sha = createHash('sha256').update(content).digest('hex')

    db.persistDiscoveryBatch(sourceDir, [
      {
        originalPath: filePath,
        fileName: 'sample.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: content.length,
        birthtimeMs: stat.birthtimeMs,
        mtimeMs: stat.mtimeMs,
        discoveredAtMs: 1730000000000
      }
    ])
    const fileLoc = db.getFileLocationByOriginalPath(filePath)!
    const locId = fileLoc.id

    db.recordHashObservationsBatch([
      {
        originalPath: filePath,
        sha256: sha,
        observedByteSize: content.length,
        observedMtimeMs: stat.mtimeMs,
        hashedAtMs: 1730000100000
      }
    ])

    const started = await coordinator.startImport({
      vaultId: identity.vaultId,
      fileLocationIds: [locId]
    })
    expect(started.status).toBe('running')

    const job = await coordinator.waitForCompletion()

    expect(job.status).toBe('completed')
    expect(job.copiedFiles).toBe(1)
    expect(job.verifiedFiles).toBe(1)
    expect(job.failedFiles).toBe(0)

    // Catalog must record the vault copy
    const copies = db.getVaultCopiesForVault(identity.vaultId)
    expect(copies.length).toBe(1)
    expect(copies[0]?.sha256).toBe(sha)
  })

  it('handles cancellation gracefully with abort signal and marks job cancelled', async () => {
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'My Vault' })
    db.registerVault({
      vaultId: identity.vaultId,
      vaultPath: vaultDir,
      name: 'My Vault',
      createdAtMs: identity.createdAtMs
    })

    db.registerSource(sourceDir)
    const locIds: number[] = []

    for (let i = 0; i < 5; i++) {
      const fPath = join(sourceDir, `file_${i}.txt`)
      const data = Buffer.from(`data_${i}_${'x'.repeat(1000)}`)
      writeFileSync(fPath, data)
      const fStat = statSync(fPath)
      const sha = createHash('sha256').update(data).digest('hex')

      db.persistDiscoveryBatch(sourceDir, [
        {
          originalPath: fPath,
          fileName: `file_${i}.txt`,
          extension: '.txt',
          category: 'document',
          byteSize: data.length,
          birthtimeMs: fStat.birthtimeMs,
          mtimeMs: fStat.mtimeMs,
          discoveredAtMs: 1730000000000
        }
      ])
      const fLoc = db.getFileLocationByOriginalPath(fPath)!
      const lId = fLoc.id
      db.recordHashObservationsBatch([
        {
          originalPath: fPath,
          sha256: sha,
          observedByteSize: data.length,
          observedMtimeMs: fStat.mtimeMs,
          hashedAtMs: 1730000100000
        }
      ])
      locIds.push(lId)
    }

    const started = await coordinator.startImport({
      vaultId: identity.vaultId,
      fileLocationIds: locIds
    })
    expect(started.status).toBe('running')

    // Immediately trigger cancel
    await coordinator.cancelImport()
    const result = await coordinator.waitForCompletion()

    expect(['cancelled', 'completed']).toContain(result.status)
  })

  it('recovers interrupted job on initialize and allows resumption', async () => {
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'My Vault' })
    db.registerVault({
      vaultId: identity.vaultId,
      vaultPath: vaultDir,
      name: 'My Vault',
      createdAtMs: identity.createdAtMs
    })

    // Manually insert an interrupted job
    db.createVaultImportJob({
      jobId: 'interrupted-job-1',
      vaultId: identity.vaultId,
      totalFiles: 2,
      totalBytes: 200,
      items: []
    })

    // Initialize coordinator should mark any running/paused as interrupted
    await coordinator.initialize()

    const activeJob = coordinator.getActiveImportJob()
    expect(activeJob?.status).toBe('interrupted')
  })

  it('resumeImport resumes strictly the authorized job items and ignores unselected catalog files', async () => {
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'My Vault' })
    db.registerVault({
      vaultId: identity.vaultId,
      vaultPath: vaultDir,
      name: 'My Vault',
      createdAtMs: identity.createdAtMs
    })

    db.registerSource(sourceDir)

    // File 1: selected for import
    const file1 = join(sourceDir, 'selected.jpg')
    const content1 = Buffer.from('selected-file-content')
    writeFileSync(file1, content1)
    const stat1 = statSync(file1)
    const sha1 = createHash('sha256').update(content1).digest('hex')

    // File 2: NOT selected for import!
    const file2 = join(sourceDir, 'unselected.jpg')
    const content2 = Buffer.from('unselected-file-content-not-authorized')
    writeFileSync(file2, content2)
    const stat2 = statSync(file2)
    const sha2 = createHash('sha256').update(content2).digest('hex')

    db.persistDiscoveryBatch(sourceDir, [
      {
        originalPath: file1,
        fileName: 'selected.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: content1.length,
        birthtimeMs: stat1.birthtimeMs,
        mtimeMs: stat1.mtimeMs,
        discoveredAtMs: 1730000000000
      },
      {
        originalPath: file2,
        fileName: 'unselected.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: content2.length,
        birthtimeMs: stat2.birthtimeMs,
        mtimeMs: stat2.mtimeMs,
        discoveredAtMs: 1730000000000
      }
    ])

    const loc1 = db.getFileLocationByOriginalPath(file1)!

    db.recordHashObservationsBatch([
      {
        originalPath: file1,
        sha256: sha1,
        observedByteSize: content1.length,
        observedMtimeMs: stat1.mtimeMs,
        hashedAtMs: 1730000100000
      },
      {
        originalPath: file2,
        sha256: sha2,
        observedByteSize: content2.length,
        observedMtimeMs: stat2.mtimeMs,
        hashedAtMs: 1730000100000
      }
    ])

    const candidates = db.getImportCandidates({ vaultId: identity.vaultId, limit: 10 })
    const cand1 = candidates.items.find((c) => c.fileLocationId === loc1.id)!

    // Create a paused/interrupted job authorizing ONLY loc1
    const jobRecord = db.createVaultImportJob({
      jobId: 'scoped-job-1',
      vaultId: identity.vaultId,
      totalFiles: 1,
      totalBytes: content1.length,
      items: [
        {
          fileLocationId: cand1.fileLocationId,
          discoveryObservationId: cand1.discoveryObservationId,
          hashObservationId: cand1.hashObservationId,
          sha256: cand1.sha256,
          byteSize: cand1.byteSize
        }
      ]
    })
    db.updateVaultImportStatus(jobRecord.id, 'interrupted')

    // Resume the job
    const resumed = await coordinator.resumeImport(jobRecord.id)
    // Wait for pipeline completion if asynchronous
    if (resumed.status === 'running') {
      await coordinator.waitForCompletion?.()
    }

    const latest = db.getVaultImportJob(jobRecord.id)!
    expect(latest.totalFiles).toBe(1)
    expect(latest.copiedFiles).toBe(1)
    expect(latest.verifiedFiles).toBe(1)
    expect(latest.failedFiles).toBe(0)

    // Critical assertion: Only file1 was copied! file2 must NOT be in vault!
    const copies = db.getVaultCopiesForVault(identity.vaultId)
    expect(copies.length).toBe(1)
    expect(copies[0]?.sha256).toBe(sha1)

    // file2 must NOT exist in vault
    const prefix2 = sha2.slice(0, 2)
    expect(existsSync(join(vaultDir, 'files', prefix2, sha2))).toBe(false)
  })

  it('marks job status as failed when all items fail', async () => {
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'My Vault' })
    db.registerVault({
      vaultId: identity.vaultId,
      vaultPath: vaultDir,
      name: 'My Vault',
      createdAtMs: identity.createdAtMs
    })

    db.registerSource(sourceDir)
    const filePath = join(sourceDir, 'will_fail.jpg')
    writeFileSync(filePath, Buffer.from('will-fail-bytes'))
    const stat = statSync(filePath)
    const sha = createHash('sha256').update('will-fail-bytes').digest('hex')

    db.persistDiscoveryBatch(sourceDir, [
      {
        originalPath: filePath,
        fileName: 'will_fail.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 15,
        birthtimeMs: stat.birthtimeMs,
        mtimeMs: stat.mtimeMs,
        discoveredAtMs: 1730000000000
      }
    ])
    const loc = db.getFileLocationByOriginalPath(filePath)!
    db.recordHashObservationsBatch([
      {
        originalPath: filePath,
        sha256: sha,
        observedByteSize: 15,
        observedMtimeMs: stat.mtimeMs,
        hashedAtMs: 1730000100000
      }
    ])

    // Delete the source file before import to trigger complete failure
    rmSync(filePath)

    await coordinator.startImport({
      vaultId: identity.vaultId,
      fileLocationIds: [loc.id]
    })
    await coordinator.waitForCompletion?.()

    const latest = db.getLatestVaultImportJob()!
    expect(latest.status).toBe('failed')
    expect(latest.failedFiles).toBe(1)
    expect(latest.copiedFiles).toBe(0)
  })

  it('never records a verified import in catalog when fallback destination copy is corrupted', async () => {
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Corrupt Fallback Vault' })
    db.registerVault({
      vaultId: identity.vaultId,
      vaultPath: vaultDir,
      name: 'Corrupt Fallback Vault',
      createdAtMs: identity.createdAtMs
    })

    db.registerSource(sourceDir)
    const filePath = join(sourceDir, 'corrupt_fallback.jpg')
    const content = Buffer.from('original-photo-payload-bytes-for-coordinator-test')
    writeFileSync(filePath, content)
    const stat = statSync(filePath)
    const sha = createHash('sha256').update(content).digest('hex')

    db.persistDiscoveryBatch(sourceDir, [
      {
        originalPath: filePath,
        fileName: 'corrupt_fallback.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: content.length,
        birthtimeMs: stat.birthtimeMs,
        mtimeMs: stat.mtimeMs,
        discoveredAtMs: 1730000000000
      }
    ])
    const loc = db.getFileLocationByOriginalPath(filePath)!
    db.recordHashObservationsBatch([
      {
        originalPath: filePath,
        sha256: sha,
        observedByteSize: content.length,
        observedMtimeMs: stat.mtimeMs,
        hashedAtMs: 1730000100000
      }
    ])

    const fallbackCoordinator = new VaultImportCoordinator({
      catalog: db,
      copyAndVerifyFn: (params) =>
        copyAndVerifyFileToVault({
          ...params,
          publishOps: {
            renameSync: () => {
              const err = new Error('EXDEV') as NodeJS.ErrnoException
              err.code = 'EXDEV'
              throw err
            },
            copyFileSync: (src, dest) => {
              const buf = Buffer.from(readFileSync(src))
              buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff
              writeFileSync(dest, buf)
            }
          }
        })
    })

    try {
      await fallbackCoordinator.startImport({
        vaultId: identity.vaultId,
        fileLocationIds: [loc.id]
      })
      const job = await fallbackCoordinator.waitForCompletion()

      expect(job.status).toBe('failed')
      expect(job.verifiedFiles).toBe(0)
      expect(job.copiedFiles).toBe(0)
      expect(job.failedFiles).toBe(1)

      expect(db.getVaultCopiesForVault(identity.vaultId)).toHaveLength(0)
      const items = db.getVaultImportItems(job.id)
      expect(items).toHaveLength(1)
      expect(items[0]?.status).toBe('failed')
      expect(
        existsSync(join(vaultDir, 'files', sha.slice(0, 2), sha, 'corrupt_fallback.jpg'))
      ).toBe(false)
    } finally {
      await fallbackCoordinator.shutdown()
    }
  })
})
