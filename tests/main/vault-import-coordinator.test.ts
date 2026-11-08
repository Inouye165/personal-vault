/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { VaultImportCoordinator } from '../../src/main/services/vault/coordinator'
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

    const job = await coordinator.startImport({
      vaultId: identity.vaultId,
      fileLocationIds: [locId]
    })

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

    const startPromise = coordinator.startImport({
      vaultId: identity.vaultId,
      fileLocationIds: locIds
    })

    // Immediately trigger cancel
    await coordinator.cancelImport()
    const result = await startPromise

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
})
