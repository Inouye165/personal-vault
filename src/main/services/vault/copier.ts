/**
 * Personal Vault — Verified Vault Copier and Pipeline (Stage 4)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isSameOrDescendantPath } from '../catalog/path-normalization'
import { isTimestampConsistentWithExpectation } from '../hashing/hasher'
import { VaultOverlapError } from './errors'
import {
  getManifestRelativePath,
  mergeManifestSources,
  readVaultManifest,
  writeVaultManifest
} from './manifest'
import type {
  CopyFileResult,
  CopyFileToVaultParams,
  VaultManifestManagedCopy,
  VaultManifestSourceEntry
} from './types'

const CHUNK_SIZE = 64 * 1024 // 64 KiB

function sanitizeFileName(name: string): string {
  // Strip control chars and illegal chars on Windows: <>:"/\|?*
  const clean = Array.from(name)
    .map((c) => (c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? '_' : c))
    .join('')
    .trim()
  if (clean.toLowerCase() === 'manifest.json') {
    return 'content_manifest.json'
  }
  return clean || 'file.bin'
}

function getCanonicalPath(targetPath: string): string {
  try {
    return realpathSync(targetPath)
  } catch {
    return resolve(targetPath)
  }
}

export function validateVaultSeparation(vaultPath: string, sourceRoots: readonly string[]): void {
  const canonicalVault = getCanonicalPath(vaultPath)

  for (const root of sourceRoots) {
    const canonicalSource = getCanonicalPath(root)
    if (
      isSameOrDescendantPath(canonicalVault, canonicalSource) ||
      isSameOrDescendantPath(canonicalSource, canonicalVault)
    ) {
      throw new VaultOverlapError(`Vault path "${vaultPath}" overlaps with source root "${root}"`)
    }
  }
}

export function cleanupOwnedStagingFiles(vaultPath: string): number {
  const stagingDir = join(vaultPath, '.vault-temp')
  if (!existsSync(stagingDir)) return 0

  let cleaned = 0
  try {
    const entries = readdirSync(stagingDir)
    for (const entry of entries) {
      if (
        (entry.startsWith('staging_') && entry.endsWith('.tmp')) ||
        (entry.startsWith('manifest_') && entry.endsWith('.tmp'))
      ) {
        try {
          unlinkSync(join(stagingDir, entry))
          cleaned++
        } catch {
          // Ignore individual unlinking failure
        }
      }
    }
  } catch {
    // Ignore readdir failure
  }
  return cleaned
}

export async function copyAndVerifyFileToVault(
  params: CopyFileToVaultParams
): Promise<CopyFileResult> {
  const { vaultPath, vaultId, importJobId, source, signal } = params

  if (signal?.aborted) {
    return { status: 'cancelled' }
  }

  const prefix = source.expectedSha256.slice(0, 2)
  const destDir = join(vaultPath, 'files', prefix, source.expectedSha256)
  const safeName = sanitizeFileName(source.fileName)
  const destFilePath = join(destDir, safeName)
  const destRelativePath = `files/${prefix}/${source.expectedSha256}/${safeName}`
  const manifestRelPath = getManifestRelativePath(source.expectedSha256)

  // 1. Open source file strictly in read-only mode
  let sourceHandle
  try {
    sourceHandle = await open(source.originalPath, 'r')
  } catch (err) {
    return {
      status: 'error',
      code: 'source_open_failed',
      message: `Failed to open source file: ${(err as Error).message}`
    }
  }

  let stagingFilePath: string | null = null

  try {
    // 2. Pre-read fstat verification
    const preStat = await sourceHandle.stat()
    if (!preStat.isFile()) {
      return {
        status: 'error',
        code: 'source_not_regular_file',
        message: 'Source path is not a regular file'
      }
    }
    if (preStat.size !== source.expectedByteSize) {
      return {
        status: 'error',
        code: 'source_changed',
        message: `Source size changed: expected ${source.expectedByteSize}, found ${preStat.size}`
      }
    }
    if (
      source.recordedFacts.filesystemMtimeMs !== null &&
      !isTimestampConsistentWithExpectation(preStat.mtimeMs, source.recordedFacts.filesystemMtimeMs)
    ) {
      return {
        status: 'error',
        code: 'source_changed',
        message: `Source modification timestamp changed: expected ${source.recordedFacts.filesystemMtimeMs}, found ${preStat.mtimeMs}`
      }
    }

    // 3. Check if an existing managed copy already exists and matches integrity
    if (existsSync(destFilePath)) {
      try {
        const destStat = statSync(destFilePath)
        if (destStat.size === source.expectedByteSize) {
          // Verify hash of existing file
          const destFileHandle = await open(destFilePath, 'r')
          try {
            const destHasher = createHash('sha256')
            const buf = Buffer.alloc(CHUNK_SIZE)
            let bytesRead = 0
            while ((bytesRead = (await destFileHandle.read(buf, 0, CHUNK_SIZE)).bytesRead) > 0) {
              destHasher.update(buf.subarray(0, bytesRead))
            }
            const existingHash = destHasher.digest('hex')
            if (existingHash === source.expectedSha256) {
              // Existing copy is valid! Re-use it and update manifest
              const existingManifest = readVaultManifest(vaultPath, source.expectedSha256)
              const sourceEntry: VaultManifestSourceEntry = {
                fileLocationId: source.fileLocationId,
                originalPath: source.originalPath,
                fileName: source.fileName,
                extension: source.extension,
                category: source.category,
                recordedFacts: {
                  byteSize: source.recordedFacts.byteSize,
                  filesystemBirthtimeMs: source.recordedFacts.filesystemBirthtimeMs,
                  filesystemMtimeMs: source.recordedFacts.filesystemMtimeMs,
                  firstDiscoveredAtMs: source.recordedFacts.firstDiscoveredAtMs,
                  lastSeenAtMs: source.recordedFacts.lastSeenAtMs,
                  hashObservationId: source.recordedFacts.hashObservationId,
                  hashVerifiedAtMs: source.recordedFacts.hashVerifiedAtMs
                },
                inferredMetadata: {
                  inferredCaptureTimeMs: source.inferredMetadata.inferredCaptureTimeMs
                },
                reviewDecisions: {
                  isPreferred: source.reviewDecisions.isPreferred,
                  duplicateReviewStatus: source.reviewDecisions.duplicateReviewStatus
                },
                importResult: {
                  importJobId,
                  importedAtMs: Date.now(),
                  verifiedSourceSha256: source.expectedSha256,
                  verifiedSourceByteSize: source.expectedByteSize,
                  sourceStability: {
                    preCopyMtimeMs: preStat.mtimeMs,
                    postCopyMtimeMs: preStat.mtimeMs,
                    preCopyByteSize: preStat.size,
                    postCopyByteSize: preStat.size
                  }
                }
              }

              const managedCopy: VaultManifestManagedCopy = existingManifest?.managedCopy ?? {
                relativePath: destRelativePath,
                fileName: safeName,
                publishedAtMs: Date.now(),
                verifiedSha256: source.expectedSha256,
                verifiedByteSize: source.expectedByteSize
              }

              const updatedManifest = mergeManifestSources(
                existingManifest,
                sourceEntry,
                managedCopy,
                vaultId,
                source.expectedSha256,
                source.expectedByteSize
              )
              writeVaultManifest(vaultPath, updatedManifest)

              return {
                status: 'success',
                sha256: source.expectedSha256,
                byteSize: source.expectedByteSize,
                relativePath: managedCopy.relativePath,
                manifestRelativePath: manifestRelPath,
                reusedExistingCopy: true
              }
            }
          } finally {
            await destFileHandle.close()
          }
        }
      } catch {
        // Fall back to staging fresh copy
      }
    }

    // 4. Staging preparation
    const stagingDir = join(vaultPath, '.vault-temp')
    mkdirSync(stagingDir, { recursive: true })
    stagingFilePath = join(
      stagingDir,
      `staging_${importJobId}_${source.fileLocationId}_${randomUUID()}.tmp`
    )

    const stagingHandle = await open(stagingFilePath, 'wx')
    const sourceHasher = createHash('sha256')

    try {
      const buffer = Buffer.alloc(CHUNK_SIZE)
      let bytesRead = 0

      while ((bytesRead = (await sourceHandle.read(buffer, 0, CHUNK_SIZE)).bytesRead) > 0) {
        if (signal?.aborted) {
          await stagingHandle.close()
          try {
            unlinkSync(stagingFilePath)
          } catch {
            // Ignore staging cleanup failure
          }
          return { status: 'cancelled' }
        }

        const chunk = buffer.subarray(0, bytesRead)
        sourceHasher.update(chunk)
        await stagingHandle.write(chunk)
      }

      // Flush staging descriptor to disk
      await stagingHandle.sync()
    } finally {
      await stagingHandle.close()
    }

    // 5. Post-read fstat verification on source descriptor
    const postStat = await sourceHandle.stat()
    if (
      postStat.size !== preStat.size ||
      !isTimestampConsistentWithExpectation(postStat.mtimeMs, preStat.mtimeMs)
    ) {
      try {
        unlinkSync(stagingFilePath)
      } catch {
        // Ignore cleanup failure
      }
      return {
        status: 'error',
        code: 'source_file_changed',
        message: 'Source file was modified on disk during copy read'
      }
    }

    // 6. Post-read pathname revalidation
    try {
      const liveStat = statSync(source.originalPath)
      if (
        liveStat.size !== preStat.size ||
        !isTimestampConsistentWithExpectation(liveStat.mtimeMs, preStat.mtimeMs)
      ) {
        try {
          unlinkSync(stagingFilePath)
        } catch {
          // Ignore cleanup failure
        }
        return {
          status: 'error',
          code: 'source_file_changed',
          message: 'Source file metadata shifted during copy operation'
        }
      }
    } catch (err) {
      try {
        unlinkSync(stagingFilePath)
      } catch {
        // Ignore cleanup failure
      }
      return {
        status: 'error',
        code: 'source_disappeared',
        message: `Source file disappeared or became inaccessible: ${(err as Error).message}`
      }
    }

    const computedSourceSha = sourceHasher.digest('hex')
    if (computedSourceSha !== source.expectedSha256) {
      try {
        unlinkSync(stagingFilePath)
      } catch {
        // Ignore cleanup failure
      }
      return {
        status: 'error',
        code: 'source_mismatch',
        message: `Source SHA-256 digest ${computedSourceSha} did not match expected ${source.expectedSha256}`
      }
    }

    // 7. Verify destination staging file independently
    const verifyStagingHandle = await open(stagingFilePath, 'r')
    const destHasher = createHash('sha256')
    try {
      const verifyBuf = Buffer.alloc(CHUNK_SIZE)
      let verifyRead = 0
      while (
        (verifyRead = (await verifyStagingHandle.read(verifyBuf, 0, CHUNK_SIZE)).bytesRead) > 0
      ) {
        destHasher.update(verifyBuf.subarray(0, verifyRead))
      }
    } finally {
      await verifyStagingHandle.close()
    }

    const destSha = destHasher.digest('hex')
    if (destSha !== source.expectedSha256) {
      try {
        unlinkSync(stagingFilePath)
      } catch {
        // Ignore cleanup failure
      }
      return {
        status: 'error',
        code: 'destination_hash_mismatch',
        message: `Destination SHA-256 digest ${destSha} did not match expected ${source.expectedSha256}`
      }
    }

    // 8. Publish copy
    mkdirSync(destDir, { recursive: true })
    if (existsSync(destFilePath)) {
      // If destination already exists, verify its integrity before overwriting
      const destCheckHandle = await open(destFilePath, 'r')
      let destCheckSha = ''
      try {
        const checkHasher = createHash('sha256')
        const checkBuf = Buffer.alloc(CHUNK_SIZE)
        let checkRead = 0
        while ((checkRead = (await destCheckHandle.read(checkBuf, 0, CHUNK_SIZE)).bytesRead) > 0) {
          checkHasher.update(checkBuf.subarray(0, checkRead))
        }
        destCheckSha = checkHasher.digest('hex')
      } finally {
        await destCheckHandle.close()
      }

      if (destCheckSha !== source.expectedSha256) {
        try {
          unlinkSync(stagingFilePath)
        } catch {
          // Ignore cleanup failure
        }
        return {
          status: 'error',
          code: 'destination_collision',
          message: `Destination file "${destFilePath}" already exists with different contents`
        }
      }
      // If hashes match, we can safely discard staging file without overwriting
      try {
        unlinkSync(stagingFilePath)
      } catch {
        // Ignore cleanup failure
      }
      stagingFilePath = null
    } else {
      renameSync(stagingFilePath, destFilePath)
      stagingFilePath = null // Successfully published
    }

    // 9. Write portable manifest
    const existingManifest = readVaultManifest(vaultPath, source.expectedSha256)
    const sourceEntry: VaultManifestSourceEntry = {
      fileLocationId: source.fileLocationId,
      originalPath: source.originalPath,
      fileName: source.fileName,
      extension: source.extension,
      category: source.category,
      recordedFacts: {
        byteSize: source.recordedFacts.byteSize,
        filesystemBirthtimeMs: source.recordedFacts.filesystemBirthtimeMs,
        filesystemMtimeMs: source.recordedFacts.filesystemMtimeMs,
        firstDiscoveredAtMs: source.recordedFacts.firstDiscoveredAtMs,
        lastSeenAtMs: source.recordedFacts.lastSeenAtMs,
        hashObservationId: source.recordedFacts.hashObservationId,
        hashVerifiedAtMs: source.recordedFacts.hashVerifiedAtMs
      },
      inferredMetadata: {
        inferredCaptureTimeMs: source.inferredMetadata.inferredCaptureTimeMs
      },
      reviewDecisions: {
        isPreferred: source.reviewDecisions.isPreferred,
        duplicateReviewStatus: source.reviewDecisions.duplicateReviewStatus
      },
      importResult: {
        importJobId,
        importedAtMs: Date.now(),
        verifiedSourceSha256: source.expectedSha256,
        verifiedSourceByteSize: source.expectedByteSize,
        sourceStability: {
          preCopyMtimeMs: preStat.mtimeMs,
          postCopyMtimeMs: postStat.mtimeMs,
          preCopyByteSize: preStat.size,
          postCopyByteSize: postStat.size
        }
      }
    }

    const managedCopy: VaultManifestManagedCopy = {
      relativePath: destRelativePath,
      fileName: safeName,
      publishedAtMs: Date.now(),
      verifiedSha256: source.expectedSha256,
      verifiedByteSize: source.expectedByteSize
    }

    const updatedManifest = mergeManifestSources(
      existingManifest,
      sourceEntry,
      managedCopy,
      vaultId,
      source.expectedSha256,
      source.expectedByteSize
    )
    writeVaultManifest(vaultPath, updatedManifest)

    return {
      status: 'success',
      sha256: source.expectedSha256,
      byteSize: source.expectedByteSize,
      relativePath: destRelativePath,
      manifestRelativePath: manifestRelPath,
      reusedExistingCopy: false
    }
  } catch (err) {
    if (stagingFilePath && existsSync(stagingFilePath)) {
      try {
        unlinkSync(stagingFilePath)
      } catch {
        // Ignore staging cleanup error
      }
    }
    return {
      status: 'error',
      code: 'copy_failed',
      message: (err as Error).message || String(err)
    }
  } finally {
    try {
      await sourceHandle.close()
    } catch {
      // Ignore handle close error
    }
  }
}
