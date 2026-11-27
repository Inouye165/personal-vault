/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { CURRENT_SCHEMA_VERSION } from '../../src/main/services/catalog/migrations'

describe('CatalogDatabase — Stage 4 Vault Migration and Repository', () => {
  let tempDir: string
  let catalogPath: string
  let db: CatalogDatabase

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vault-catalog-test-'))
    catalogPath = join(tempDir, 'catalog.db')
    db = CatalogDatabase.open({ catalogPath })
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // Ignore
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('migrates schema to version 6 and creates vault tables', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(6)

    const raw = new DatabaseSync(catalogPath, { readOnly: true })
    try {
      const tables = (
        raw.prepare("SELECT name FROM sqlite_master WHERE type='table';").all() as Array<{
          name: string
        }>
      ).map((r) => r.name)

      expect(tables).toContain('vaults')
      expect(tables).toContain('vault_copies')
      expect(tables).toContain('vault_imports')
      expect(tables).toContain('vault_import_items')
    } finally {
      raw.close()
    }
  })

  it('registers and activates a vault', () => {
    const vault = db.registerVault({
      vaultId: 'vault-uuid-1',
      vaultPath: join(tempDir, 'my-vault'),
      name: 'Primary Vault',
      createdAtMs: 1730000000000
    })

    expect(vault.vaultId).toBe('vault-uuid-1')
    expect(vault.name).toBe('Primary Vault')
    expect(vault.isActive).toBe(true)

    const active = db.getActiveVault()
    expect(active).not.toBeNull()
    expect(active?.vaultId).toBe('vault-uuid-1')
  })

  it('creates an import job, queues items, and updates progress', () => {
    db.registerVault({
      vaultId: 'vault-uuid-1',
      vaultPath: join(tempDir, 'my-vault'),
      name: 'Primary Vault',
      createdAtMs: 1730000000000
    })

    const sourceRoot = join(tempDir, 'source-root')
    db.registerSource(sourceRoot)
    const originalPhotoPath = join(sourceRoot, 'photo.jpg')
    db.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: originalPhotoPath,
        fileName: 'photo.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 1024,
        birthtimeMs: 1730000000000,
        mtimeMs: 1730000000000,
        discoveredAtMs: 1730000000000
      }
    ])

    const photoLoc = db.getFileLocationByOriginalPath(originalPhotoPath)!
    const locId = photoLoc.id
    const discId = photoLoc.discoveryObservationId
    const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

    db.recordHashObservationsBatch([
      {
        originalPath: originalPhotoPath,
        sha256: sha,
        observedByteSize: 1024,
        observedMtimeMs: 1730000000000,
        hashedAtMs: 1730000100000
      }
    ])

    const job = db.createVaultImportJob({
      jobId: 'import-job-1',
      vaultId: 'vault-uuid-1',
      totalFiles: 1,
      totalBytes: 1024,
      items: [
        {
          fileLocationId: locId,
          discoveryObservationId: discId,
          sha256: sha,
          byteSize: 1024
        }
      ]
    })

    expect(job.id).toBe('import-job-1')
    expect(job.status).toBe('running')
    expect(job.totalFiles).toBe(1)
    expect(job.copiedFiles).toBe(0)

    // Complete the item and update progress
    const copy = db.recordVaultCopy({
      vaultId: 'vault-uuid-1',
      sha256: sha,
      byteSize: 1024,
      relativePath: 'files/e3/photo.jpg',
      manifestRelativePath: 'files/e3/manifest.json',
      verifiedAtMs: 1730000200000
    })

    db.updateVaultImportItem({
      jobId: 'import-job-1',
      fileLocationId: locId,
      status: 'completed',
      vaultCopyId: copy.id,
      completedAtMs: 1730000200000
    })

    db.updateVaultImportProgress({
      jobId: 'import-job-1',
      copiedFiles: 1,
      copiedBytes: 1024,
      verifiedFiles: 1,
      failedFiles: 0
    })

    const updatedJob = db.getVaultImportJob('import-job-1')
    expect(updatedJob?.copiedFiles).toBe(1)
    expect(updatedJob?.verifiedFiles).toBe(1)
  })

  it('marks running and paused import jobs as interrupted on crash recovery', () => {
    db.registerVault({
      vaultId: 'vault-uuid-1',
      vaultPath: join(tempDir, 'my-vault'),
      name: 'Primary Vault',
      createdAtMs: 1730000000000
    })

    db.createVaultImportJob({
      jobId: 'job-crash-1',
      vaultId: 'vault-uuid-1',
      totalFiles: 5,
      totalBytes: 5000,
      items: []
    })

    const interruptedCount = db.markRunningImportJobsAsInterrupted()
    expect(interruptedCount).toBe(1)

    const job = db.getVaultImportJob('job-crash-1')
    expect(job?.status).toBe('interrupted')
  })

  it('queries import candidates with vault status and pagination', () => {
    db.registerVault({
      vaultId: 'vault-uuid-1',
      vaultPath: join(tempDir, 'my-vault'),
      name: 'Primary Vault',
      createdAtMs: 1730000000000
    })

    const sourceRoot = join(tempDir, 'source-root')
    db.registerSource(sourceRoot)
    const picPath = join(sourceRoot, 'pic1.jpg')
    const docPath = join(sourceRoot, 'doc1.txt')
    db.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: picPath,
        fileName: 'pic1.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 200,
        birthtimeMs: 1730000000000,
        mtimeMs: 1730000000000,
        discoveredAtMs: 1730000000000
      },
      {
        originalPath: docPath,
        fileName: 'doc1.txt',
        extension: '.txt',
        category: 'document',
        byteSize: 300,
        birthtimeMs: 1730000000000,
        mtimeMs: 1730000000000,
        discoveredAtMs: 1730000000000
      }
    ])

    const sha1 = '1111111111111111111111111111111111111111111111111111111111111111'
    const sha2 = '2222222222222222222222222222222222222222222222222222222222222222'

    db.recordHashObservationsBatch([
      {
        originalPath: picPath,
        sha256: sha1,
        observedByteSize: 200,
        observedMtimeMs: 1730000000000,
        hashedAtMs: 1730000100000
      },
      {
        originalPath: docPath,
        sha256: sha2,
        observedByteSize: 300,
        observedMtimeMs: 1730000000000,
        hashedAtMs: 1730000100000
      }
    ])

    // Query candidates before any import
    const candidates1 = db.getImportCandidates({ vaultId: 'vault-uuid-1', limit: 10, offset: 0 })
    expect(candidates1.totalCount).toBe(2)
    expect(candidates1.items[0]?.vaultStatus).toBe('not_imported')
    expect(candidates1.items[1]?.vaultStatus).toBe('not_imported')

    // Record a copy for pic1
    db.recordVaultCopy({
      vaultId: 'vault-uuid-1',
      sha256: sha1,
      byteSize: 200,
      relativePath: 'files/11/pic1.jpg',
      manifestRelativePath: 'files/11/manifest.json',
      verifiedAtMs: 1730000200000
    })

    const candidates2 = db.getImportCandidates({ vaultId: 'vault-uuid-1', limit: 10, offset: 0 })
    const picCandidate = candidates2.items.find((i) => i.fileName === 'pic1.jpg')
    const docCandidate = candidates2.items.find((i) => i.fileName === 'doc1.txt')
    expect(picCandidate?.vaultStatus).toBe('copied')
    expect(docCandidate?.vaultStatus).toBe('not_imported')

    // Filter by unimported
    const unimported = db.getImportCandidates({
      vaultId: 'vault-uuid-1',
      filter: 'unimported',
      limit: 10,
      offset: 0
    })
    expect(unimported.totalCount).toBe(1)
    expect(unimported.items[0]?.fileName).toBe('doc1.txt')
  })
})
