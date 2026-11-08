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
import {
  initializeVault,
  loadVaultIdentity,
  validateVaultSeparation,
  copyAndVerifyFileToVault,
  readVaultManifest,
  cleanupOwnedStagingFiles
} from '../../src/main/services/vault'

describe('Vault Services — Identity, Overlap, Copier, and Manifests', () => {
  let tempDir: string
  let vaultDir: string
  let sourceDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vault-copier-test-'))
    vaultDir = join(tempDir, 'vault')
    sourceDir = join(tempDir, 'source')
    mkdirSync(sourceDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('initializes a new vault with vault.json and loads valid identity', () => {
    const identity = initializeVault({
      vaultPath: vaultDir,
      vaultName: 'Family Archive'
    })

    expect(identity.formatVersion).toBe(1)
    expect(identity.vaultName).toBe('Family Archive')
    expect(typeof identity.vaultId).toBe('string')
    expect(identity.vaultId.length).toBeGreaterThan(0)
    expect(existsSync(join(vaultDir, 'vault.json'))).toBe(true)

    const loaded = loadVaultIdentity(vaultDir)
    expect(loaded).toEqual(identity)
  })

  it('rejects uninitialized vault directory when loading identity', () => {
    const emptyDir = join(tempDir, 'empty-vault')
    mkdirSync(emptyDir, { recursive: true })
    expect(() => loadVaultIdentity(emptyDir)).toThrow(/not an initialized/i)
  })

  it('validates vault separation and rejects source/vault overlap', () => {
    // Normal separate folders: valid
    expect(() => validateVaultSeparation(vaultDir, [sourceDir])).not.toThrow()

    // Vault inside source: reject
    const nestedVault = join(sourceDir, 'vault-inside')
    expect(() => validateVaultSeparation(nestedVault, [sourceDir])).toThrow(/overlap/i)

    // Source inside vault: reject
    const nestedSource = join(vaultDir, 'source-inside')
    expect(() => validateVaultSeparation(vaultDir, [nestedSource])).toThrow(/overlap/i)

    // Identical paths: reject
    expect(() => validateVaultSeparation(sourceDir, [sourceDir])).toThrow(/overlap/i)
  })

  it('performs verified copy to vault with portable manifest and preserves source', async () => {
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Test Vault' })

    const sourceFile = join(sourceDir, 'original.jpg')
    const content = Buffer.from('test-photo-binary-data-content-12345')
    writeFileSync(sourceFile, content)

    const initialStat = statSync(sourceFile)
    const expectedSha256 = createHash('sha256').update(content).digest('hex')

    const result = await copyAndVerifyFileToVault({
      vaultPath: vaultDir,
      vaultId: identity.vaultId,
      importJobId: 'job-1',
      source: {
        fileLocationId: 101,
        discoveryObservationId: 201,
        originalPath: sourceFile,
        fileName: 'original.jpg',
        extension: '.jpg',
        category: 'photo',
        recordedFacts: {
          byteSize: content.length,
          filesystemBirthtimeMs: initialStat.birthtimeMs,
          filesystemMtimeMs: initialStat.mtimeMs,
          firstDiscoveredAtMs: Date.now() - 5000,
          lastSeenAtMs: Date.now() - 5000,
          hashObservationId: 301,
          hashVerifiedAtMs: Date.now() - 4000
        },
        inferredMetadata: {
          inferredCaptureTimeMs: null
        },
        reviewDecisions: {
          isPreferred: true,
          duplicateReviewStatus: 'reviewed'
        },
        expectedSha256,
        expectedByteSize: content.length
      }
    })

    expect(result.status).toBe('success')
    if (result.status !== 'success') return

    // Verify managed destination file
    const prefix = expectedSha256.slice(0, 2)
    const expectedDestDir = join(vaultDir, 'files', prefix, expectedSha256)
    const destFilePath = join(expectedDestDir, 'original.jpg')
    expect(existsSync(destFilePath)).toBe(true)

    const destBytes = readFileSync(destFilePath)
    expect(destBytes.equals(content)).toBe(true)
    const destSha = createHash('sha256').update(destBytes).digest('hex')
    expect(destSha).toBe(expectedSha256)

    // Verify source file is untouched
    const finalStat = statSync(sourceFile)
    expect(finalStat.size).toBe(initialStat.size)
    expect(finalStat.mtimeMs).toBe(initialStat.mtimeMs)
    expect(readFileSync(sourceFile).equals(content)).toBe(true)

    // Verify portable manifest
    const manifest = readVaultManifest(vaultDir, expectedSha256)
    expect(manifest).not.toBeNull()
    expect(manifest?.formatVersion).toBe(1)
    expect(manifest?.vaultId).toBe(identity.vaultId)
    expect(manifest?.sha256).toBe(expectedSha256)
    expect(manifest?.byteSize).toBe(content.length)
    expect(manifest?.managedCopy.fileName).toBe('original.jpg')
    expect(manifest?.sources.length).toBe(1)
    expect(manifest?.sources[0]?.originalPath).toBe(sourceFile)
    expect(manifest?.sources[0]?.inferredMetadata.inferredCaptureTimeMs).toBeNull()
    expect(manifest?.sources[0]?.reviewDecisions.isPreferred).toBe(true)
  })

  it('rejects copy if source file was modified or corrupted before/during copy', async () => {
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Test Vault' })

    const sourceFile = join(sourceDir, 'tampered.jpg')
    writeFileSync(sourceFile, Buffer.from('original-content'))
    const stat = statSync(sourceFile)

    // Expectation claims size 16, but actual size is modified
    const result = await copyAndVerifyFileToVault({
      vaultPath: vaultDir,
      vaultId: identity.vaultId,
      importJobId: 'job-1',
      source: {
        fileLocationId: 102,
        discoveryObservationId: 202,
        originalPath: sourceFile,
        fileName: 'tampered.jpg',
        extension: '.jpg',
        category: 'photo',
        recordedFacts: {
          byteSize: 9999, // mismatch!
          filesystemBirthtimeMs: stat.birthtimeMs,
          filesystemMtimeMs: stat.mtimeMs,
          firstDiscoveredAtMs: Date.now(),
          lastSeenAtMs: Date.now(),
          hashObservationId: 302,
          hashVerifiedAtMs: Date.now()
        },
        inferredMetadata: { inferredCaptureTimeMs: null },
        reviewDecisions: { isPreferred: false, duplicateReviewStatus: null },
        expectedSha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        expectedByteSize: 9999
      }
    })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.code).toMatch(/source_changed|source_mismatch/i)
    }

    // Ensure no files were left in vault files/ directory
    expect(existsSync(join(vaultDir, 'files'))).toBe(false)
  })

  it('reuses existing verified copy and appends source provenance on duplicate/repeated import', async () => {
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Test Vault' })

    const content = Buffer.from('shared-duplicate-payload-bytes')
    const sha = createHash('sha256').update(content).digest('hex')

    const file1 = join(sourceDir, 'copy1.jpg')
    const file2 = join(sourceDir, 'copy2.jpg')
    writeFileSync(file1, content)
    writeFileSync(file2, content)

    const stat1 = statSync(file1)
    const stat2 = statSync(file2)

    // Import file1
    const res1 = await copyAndVerifyFileToVault({
      vaultPath: vaultDir,
      vaultId: identity.vaultId,
      importJobId: 'job-1',
      source: {
        fileLocationId: 1,
        discoveryObservationId: 11,
        originalPath: file1,
        fileName: 'copy1.jpg',
        extension: '.jpg',
        category: 'photo',
        recordedFacts: {
          byteSize: content.length,
          filesystemBirthtimeMs: stat1.birthtimeMs,
          filesystemMtimeMs: stat1.mtimeMs,
          firstDiscoveredAtMs: Date.now(),
          lastSeenAtMs: Date.now(),
          hashObservationId: 10,
          hashVerifiedAtMs: Date.now()
        },
        inferredMetadata: { inferredCaptureTimeMs: null },
        reviewDecisions: { isPreferred: true, duplicateReviewStatus: 'reviewed' },
        expectedSha256: sha,
        expectedByteSize: content.length
      }
    })
    expect(res1.status).toBe('success')

    // Import file2 (duplicate content from second location)
    const res2 = await copyAndVerifyFileToVault({
      vaultPath: vaultDir,
      vaultId: identity.vaultId,
      importJobId: 'job-2',
      source: {
        fileLocationId: 2,
        discoveryObservationId: 22,
        originalPath: file2,
        fileName: 'copy2.jpg',
        extension: '.jpg',
        category: 'photo',
        recordedFacts: {
          byteSize: content.length,
          filesystemBirthtimeMs: stat2.birthtimeMs,
          filesystemMtimeMs: stat2.mtimeMs,
          firstDiscoveredAtMs: Date.now(),
          lastSeenAtMs: Date.now(),
          hashObservationId: 20,
          hashVerifiedAtMs: Date.now()
        },
        inferredMetadata: { inferredCaptureTimeMs: null },
        reviewDecisions: { isPreferred: false, duplicateReviewStatus: 'reviewed' },
        expectedSha256: sha,
        expectedByteSize: content.length
      }
    })
    expect(res2.status).toBe('success')

    // Both sources must now be preserved in the portable manifest!
    const manifest = readVaultManifest(vaultDir, sha)
    expect(manifest?.sources.length).toBe(2)
    const paths = manifest?.sources.map((s) => s.originalPath)
    expect(paths).toContain(file1)
    expect(paths).toContain(file2)
  })

  it('cleans up only workflow-owned staging files', () => {
    const stagingDir = join(vaultDir, '.vault-temp')
    mkdirSync(stagingDir, { recursive: true })

    // An owned staging file
    const ownedFile = join(stagingDir, 'staging_job-1_101_uuid.tmp')
    writeFileSync(ownedFile, 'temp data')

    // An unrelated file in the same directory (must not be deleted)
    const unrelatedFile = join(stagingDir, 'user_important_notes.txt')
    writeFileSync(unrelatedFile, 'keep me')

    cleanupOwnedStagingFiles(vaultDir)

    expect(existsSync(ownedFile)).toBe(false)
    expect(existsSync(unrelatedFile)).toBe(true)
  })
})
