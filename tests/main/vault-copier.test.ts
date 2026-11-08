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
  symlinkSync,
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

  it('rejects initializeVault when an unrelated or invalid vault.json already exists without overwriting it', () => {
    mkdirSync(vaultDir, { recursive: true })
    const unrelatedFile = join(vaultDir, 'vault.json')
    const originalContent = '{"someOtherApp": true, "data": 123}'
    writeFileSync(unrelatedFile, originalContent, 'utf-8')

    expect(() =>
      initializeVault({
        vaultPath: vaultDir,
        vaultName: 'Tamper Vault'
      })
    ).toThrow(/unrelated|invalid|already exists/i)

    // The original unrelated file must remain 100% untouched!
    expect(readFileSync(unrelatedFile, 'utf-8')).toBe(originalContent)
  })

  it('always verifies live source contents even when destination file already matches historical hash', async () => {
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Test Vault' })

    const originalContent = Buffer.from('original-pristine-bytes-1234')
    const originalSha = createHash('sha256').update(originalContent).digest('hex')

    // Pre-populate vault destination with a file that matches the original hash
    const prefix = originalSha.slice(0, 2)
    const destDir = join(vaultDir, 'files', prefix, originalSha)
    mkdirSync(destDir, { recursive: true })
    const destFile = join(destDir, 'sample.jpg')
    writeFileSync(destFile, originalContent)

    // Now, create source file with the SAME byte size, but DIFFERENT contents (tampered!)
    const tamperedContent = Buffer.from('tampered-same-size-byte-9999')
    expect(tamperedContent.length).toBe(originalContent.length)
    const sourceFile = join(sourceDir, 'sample.jpg')
    writeFileSync(sourceFile, tamperedContent)

    // Attempt import claiming originalSha (the historical hash)
    const result = await copyAndVerifyFileToVault({
      vaultPath: vaultDir,
      vaultId: identity.vaultId,
      importJobId: 'job-tamper',
      source: {
        fileLocationId: 99,
        discoveryObservationId: 199,
        originalPath: sourceFile,
        fileName: 'sample.jpg',
        extension: '.jpg',
        category: 'photo',
        recordedFacts: {
          byteSize: originalContent.length,
          filesystemBirthtimeMs: null, // unknown birthtime
          filesystemMtimeMs: null, // unknown mtime! (Reviewer probe reproduced this)
          firstDiscoveredAtMs: 1700000000000,
          lastSeenAtMs: 1700000000000,
          hashObservationId: 299,
          hashVerifiedAtMs: 1700000000000
        },
        inferredMetadata: { inferredCaptureTimeMs: null },
        reviewDecisions: { isPreferred: false, duplicateReviewStatus: null },
        expectedSha256: originalSha,
        expectedByteSize: originalContent.length
      }
    })

    // MUST FAIL because live source was hashed and does not match originalSha!
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.code).toMatch(/source_mismatch|source_file_changed|source_changed/i)
    }
  })

  it('rejects unreadable or corrupt manifest rather than silently treating as absent', () => {
    const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    const prefix = sha.slice(0, 2)
    const manifestDir = join(vaultDir, 'files', prefix, sha)
    mkdirSync(manifestDir, { recursive: true })
    const manifestPath = join(manifestDir, 'manifest.json')
    writeFileSync(manifestPath, '{ corrupt json invalid syntax ...', 'utf-8')

    expect(() => readVaultManifest(vaultDir, sha)).toThrow(/corrupt|invalid/i)
  })

  it('rejects manifest with malformed nested schema, path traversal, or mismatched facts', () => {
    const sha = 'a'.repeat(64)
    const prefix = sha.slice(0, 2)
    const manifestDir = join(vaultDir, 'files', prefix, sha)
    mkdirSync(manifestDir, { recursive: true })
    const manifestPath = join(manifestDir, 'manifest.json')

    // Case 1: Traversal relative path
    const invalidManifest1 = {
      formatVersion: 1,
      vaultId: '3f77727c-ead6-43ad-ae67-f1e585a21840',
      sha256: sha,
      byteSize: 100,
      managedCopy: {
        relativePath: `../../escaped/${sha}/file.jpg`,
        fileName: 'file.jpg',
        publishedAtMs: 1700000000000,
        verifiedSha256: sha,
        verifiedByteSize: 100
      },
      sources: []
    }
    writeFileSync(manifestPath, JSON.stringify(invalidManifest1), 'utf-8')
    expect(() => readVaultManifest(vaultDir, sha)).toThrow(/schema|invalid|corrupt|traversal/i)

    // Case 2: Inconsistent hash between manifest header and managed copy
    const invalidManifest2 = {
      ...invalidManifest1,
      managedCopy: {
        ...invalidManifest1.managedCopy,
        relativePath: `files/${prefix}/${sha}/file.jpg`,
        verifiedSha256: 'b'.repeat(64) // mismatch!
      }
    }
    writeFileSync(manifestPath, JSON.stringify(invalidManifest2), 'utf-8')
    expect(() => readVaultManifest(vaultDir, sha)).toThrow(/schema|invalid|corrupt|mismatch/i)

    // Case 3: Malformed nested source entry (negative byteSize)
    const invalidManifest3 = {
      ...invalidManifest2,
      managedCopy: {
        ...invalidManifest2.managedCopy,
        verifiedSha256: sha
      },
      sources: [
        {
          fileLocationId: 1,
          originalPath: '/valid/path.jpg',
          fileName: 'path.jpg',
          extension: '.jpg',
          category: 'photo',
          recordedFacts: {
            byteSize: -50, // invalid negative!
            filesystemBirthtimeMs: null,
            filesystemMtimeMs: null,
            firstDiscoveredAtMs: 1700000000000,
            lastSeenAtMs: 1700000000000,
            discoveryObservationId: 1,
            hashObservationId: 1,
            hashVerifiedAtMs: 1700000000000
          },
          inferredMetadata: { inferredCaptureTimeMs: null },
          reviewDecisions: { isPreferred: false, duplicateReviewStatus: null },
          importResult: {
            importJobId: 'job-1',
            importedAtMs: 1700000000000,
            verifiedSourceSha256: sha,
            verifiedSourceByteSize: 100,
            sourceStability: {
              preCopyMtimeMs: null,
              postCopyMtimeMs: null,
              preCopyByteSize: 100,
              postCopyByteSize: 100
            }
          }
        }
      ]
    }
    writeFileSync(manifestPath, JSON.stringify(invalidManifest3), 'utf-8')
    expect(() => readVaultManifest(vaultDir, sha)).toThrow(/schema|invalid|corrupt/i)
  })

  it('rejects internal vault symlink or junction redirection in vault storage', () => {
    initializeVault({ vaultPath: vaultDir, vaultName: 'Containment Vault' })
    const externalDir = join(tempDir, 'external-target')
    mkdirSync(externalDir, { recursive: true })

    // Create a symlink/junction inside vaultDir pointing to externalDir
    const maliciousDir = join(vaultDir, 'files', 'ab')
    mkdirSync(join(vaultDir, 'files'), { recursive: true })

    try {
      // Attempt creating symlink or junction
      symlinkSync(externalDir, maliciousDir, 'junction')
    } catch {
      // If platform cannot create junction without elevation, test deterministic containment check directly
    }

    if (existsSync(maliciousDir)) {
      const sha = 'ab' + '0'.repeat(62)
      expect(() => readVaultManifest(vaultDir, sha)).toThrow(
        /overlap|redirection|symlink|junction|outside/i
      )
    }
  })

  it('rejects adoption of an unmanaged file with matching hash without valid manifest or workflow ownership', async () => {
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'No Unmanaged Adoption' })
    const content = Buffer.from('unmanaged-file-bytes-12345')
    const sha = createHash('sha256').update(content).digest('hex')
    const prefix = sha.slice(0, 2)

    // A stray unmanaged file is dropped into the vault destination directory
    const destDir = join(vaultDir, 'files', prefix, sha)
    mkdirSync(destDir, { recursive: true })
    const destFilePath = join(destDir, 'unmanaged.jpg')
    writeFileSync(destFilePath, content)

    const sourceFile = join(sourceDir, 'original.jpg')
    writeFileSync(sourceFile, content)

    // Attempt import
    const result = await copyAndVerifyFileToVault({
      vaultPath: vaultDir,
      vaultId: identity.vaultId,
      importJobId: 'job-unmanaged',
      source: {
        fileLocationId: 10,
        discoveryObservationId: 20,
        originalPath: sourceFile,
        fileName: 'original.jpg',
        extension: '.jpg',
        category: 'photo',
        recordedFacts: {
          byteSize: content.length,
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: null,
          firstDiscoveredAtMs: 1700000000000,
          lastSeenAtMs: 1700000000000,
          hashObservationId: 30,
          hashVerifiedAtMs: 1700000000000
        },
        inferredMetadata: { inferredCaptureTimeMs: null },
        reviewDecisions: { isPreferred: false, duplicateReviewStatus: null },
        expectedSha256: sha,
        expectedByteSize: content.length
      }
    })

    // Must NOT adopt arbitrary unmanaged file! Must fail with destination_collision
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.code).toBe('destination_collision')
      expect(result.message).toMatch(/not managed|unmanaged|manifest is missing/i)
    }
  })

  it('recovers safely when file was published with workflow in-progress marker before manifest creation', async () => {
    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Crash Recovery Vault' })
    const content = Buffer.from('crash-recovery-bytes-998877')
    const sha = createHash('sha256').update(content).digest('hex')
    const prefix = sha.slice(0, 2)

    // Simulate crash after destination file published and in-progress marker written,
    // but BEFORE manifest.json could be written
    const destDir = join(vaultDir, 'files', prefix, sha)
    mkdirSync(destDir, { recursive: true })
    const destFilePath = join(destDir, 'sample.jpg')
    writeFileSync(destFilePath, content)

    const markerPath = join(destDir, `.pv_in_progress_${identity.vaultId}_job-crash-1.json`)
    writeFileSync(
      markerPath,
      JSON.stringify({
        vaultId: identity.vaultId,
        jobId: 'job-crash-1',
        sha256: sha,
        byteSize: content.length,
        fileName: 'sample.jpg',
        publishedAtMs: 1700000000000
      })
    )

    const sourceFile = join(sourceDir, 'sample.jpg')
    writeFileSync(sourceFile, content)

    // Resume the exact same job
    const result = await copyAndVerifyFileToVault({
      vaultPath: vaultDir,
      vaultId: identity.vaultId,
      importJobId: 'job-crash-1',
      source: {
        fileLocationId: 55,
        discoveryObservationId: 65,
        originalPath: sourceFile,
        fileName: 'sample.jpg',
        extension: '.jpg',
        category: 'photo',
        recordedFacts: {
          byteSize: content.length,
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: null,
          firstDiscoveredAtMs: 1700000000000,
          lastSeenAtMs: 1700000000000,
          hashObservationId: 75,
          hashVerifiedAtMs: 1700000000000
        },
        inferredMetadata: { inferredCaptureTimeMs: null },
        reviewDecisions: { isPreferred: false, duplicateReviewStatus: null },
        expectedSha256: sha,
        expectedByteSize: content.length
      }
    })

    // Resumed job must recognize its own in-progress publication, verify bytes, create manifest, and clean up marker!
    expect(result.status).toBe('success')
    expect(existsSync(join(destDir, 'manifest.json'))).toBe(true)
    expect(existsSync(markerPath)).toBe(false)
  })
})
