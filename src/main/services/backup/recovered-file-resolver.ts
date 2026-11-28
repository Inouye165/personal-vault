/**
 * Personal Vault — Stage 8B Slice 2: Shared Read-Only File Location Resolver
 *
 * Resolves a catalog `file_locations.id` to a readable file path:
 * - For `source_kind = 'user'` (ordinary profiles), returns `original_path`
 *   with `catalog.getAllSourceRoots()` as approved roots.
 * - For `source_kind = 'recovery_manifest'` (recovered profiles), ALWAYS reads
 *   from the surviving vault's verified `vault_copies` file — even if
 *   `original_path` exists on disk — after checking containment, byte size,
 *   and SHA-256, while preserving `original_path` for provenance.
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync
} from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { CatalogDatabase } from '../catalog/database'
import { assertPathContainedInVault } from '../vault/containment'

const STREAM_CHUNK_BYTES = 64 * 1024

export type ResolvedFileReadSuccess = {
  readonly ok: true
  readonly mode: 'source' | 'vault_copy'
  readonly locationId: number
  readonly filePath: string
  readonly originalPath: string
  readonly expectedByteSize: number
  readonly expectedMtimeMs: number | null
  readonly expectedSha256: string | null
  readonly approvedRoots: readonly string[]
}

export type ResolvedFileReadFailure = {
  readonly ok: false
  readonly locationId: number
  readonly errorCode:
    | 'NOT_FOUND'
    | 'FILE_UNAVAILABLE'
    | 'VAULT_UNAVAILABLE'
    | 'VAULT_CONTAINMENT_ERROR'
    | 'VAULT_COPY_MISSING'
    | 'VAULT_COPY_CORRUPT'
  readonly errorMessage: string
}

export type ResolvedFileReadResult = ResolvedFileReadSuccess | ResolvedFileReadFailure

function streamVerifyVaultPayload(
  filePath: string,
  expectedByteSize: number,
  expectedSha256: string
): { ok: true } | { ok: false; reason: string } {
  const fd = openSync(filePath, fsConstants.O_RDONLY)
  const hash = createHash('sha256')
  const buf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES)
  let totalBytes = 0
  try {
    while (true) {
      const bytesRead = readSync(fd, buf, 0, buf.length, null)
      if (bytesRead === 0) break
      totalBytes += bytesRead
      if (totalBytes > expectedByteSize) {
        return {
          ok: false,
          reason: `Vault copy "${filePath}" exceeds expected byte size ${expectedByteSize}`
        }
      }
      hash.update(buf.subarray(0, bytesRead))
    }
  } finally {
    closeSync(fd)
  }

  if (totalBytes !== expectedByteSize) {
    return {
      ok: false,
      reason: `Vault copy "${filePath}" byte size ${totalBytes} does not match expected ${expectedByteSize}`
    }
  }

  const actualSha256 = hash.digest('hex').toLowerCase()
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    return {
      ok: false,
      reason: `Vault copy "${filePath}" SHA-256 "${actualSha256}" does not match expected "${expectedSha256}"`
    }
  }

  return { ok: true }
}

export interface ResolveReadableFileOptions {
  /**
   * When `false`, skips synchronous main-thread SHA-256 hashing because the
   * caller delegates full-file byte-size and SHA-256 verification to an
   * off-main worker thread (`thumbnail_worker` / `document_worker`).
   * Containment, existence, regular-file checks, and byte-size checks always run.
   */
  readonly verifyPayloadHash?: boolean
  /**
   * When `true` and `source_kind === 'user'` has an unavailable original path,
   * checks whether an active vault holds a verified copy for the cataloged
   * SHA-256 + byte size and resolves to that copy (or returns FILE_UNAVAILABLE).
   */
  readonly allowVaultCopyFallbackForUnavailableSource?: boolean
  /**
   * When `true` and `source_kind === 'user'`, prefers a verified active-vault
   * copy matching the cataloged SHA-256 and byte size before falling back to
   * `original_path` (e.g. scanned-only files). Fails closed if a matching
   * vault copy fails containment or integrity checks.
   */
  readonly preferVaultCopy?: boolean
}

function resolveVerifiedVaultCopyForLocation(
  catalog: CatalogDatabase,
  locationId: number,
  ctx: {
    readonly originalPath: string
    readonly byteSize: number
    readonly activeHash: string | null
  },
  options?: ResolveReadableFileOptions
): ResolvedFileReadResult {
  const activeVault = catalog.getActiveVault()
  if (!activeVault) {
    return {
      ok: false,
      locationId,
      errorCode: 'VAULT_UNAVAILABLE',
      errorMessage: 'No active vault is registered for vault copy access'
    }
  }

  if (!ctx.activeHash || !/^[0-9a-f]{64}$/i.test(ctx.activeHash)) {
    return {
      ok: false,
      locationId,
      errorCode: 'VAULT_COPY_MISSING',
      errorMessage: `Location ${locationId} lacks a valid active SHA-256 hash`
    }
  }

  const normalizedHash = ctx.activeHash.toLowerCase()
  const vaultCopy = catalog.getVaultCopy(activeVault.vaultId, normalizedHash, ctx.byteSize)
  if (!vaultCopy) {
    return {
      ok: false,
      locationId,
      errorCode: 'VAULT_COPY_MISSING',
      errorMessage: `No matching vault_copies record for sha256=${normalizedHash} byteSize=${ctx.byteSize}`
    }
  }

  const expectedContentDir = join(
    activeVault.vaultPath,
    'files',
    normalizedHash.slice(0, 2),
    normalizedHash
  )
  const vaultCopyPath = resolve(activeVault.vaultPath, vaultCopy.relativePath)

  try {
    assertPathContainedInVault(activeVault.vaultPath, expectedContentDir, 'vault content dir')
    assertPathContainedInVault(activeVault.vaultPath, vaultCopyPath, 'vault copy')
  } catch (err) {
    return {
      ok: false,
      locationId,
      errorCode: 'VAULT_CONTAINMENT_ERROR',
      errorMessage: (err as Error).message
    }
  }

  if (!existsSync(vaultCopyPath)) {
    return {
      ok: false,
      locationId,
      errorCode: 'VAULT_COPY_MISSING',
      errorMessage: `Verified vault copy is missing at "${vaultCopyPath}"`
    }
  }

  try {
    const lst = lstatSync(vaultCopyPath)
    if (lst.isSymbolicLink() || !lst.isFile()) {
      return {
        ok: false,
        locationId,
        errorCode: 'VAULT_CONTAINMENT_ERROR',
        errorMessage: `Vault copy "${vaultCopyPath}" is not a regular file`
      }
    }
    const contentDirReal = realpathSync(expectedContentDir)
    const copyReal = realpathSync(vaultCopyPath)
    const rel = relative(contentDirReal, copyReal)
    if (!rel || rel.startsWith('..') || rel.includes(sep)) {
      return {
        ok: false,
        locationId,
        errorCode: 'VAULT_CONTAINMENT_ERROR',
        errorMessage: `Vault copy "${copyReal}" escapes content directory "${contentDirReal}"`
      }
    }

    const st = statSync(copyReal)
    if (st.size !== vaultCopy.byteSize) {
      return {
        ok: false,
        locationId,
        errorCode: 'VAULT_COPY_CORRUPT',
        errorMessage: `Vault copy "${copyReal}" byte size ${st.size} does not match expected ${vaultCopy.byteSize}`
      }
    }

    if (options?.verifyPayloadHash !== false) {
      const verified = streamVerifyVaultPayload(copyReal, vaultCopy.byteSize, vaultCopy.sha256)
      if (!verified.ok) {
        return {
          ok: false,
          locationId,
          errorCode: 'VAULT_COPY_CORRUPT',
          errorMessage: verified.reason
        }
      }
    }

    return {
      ok: true,
      mode: 'vault_copy',
      locationId,
      filePath: copyReal,
      originalPath: ctx.originalPath,
      expectedByteSize: vaultCopy.byteSize,
      expectedMtimeMs: Number.isFinite(st.mtimeMs) ? st.mtimeMs : null,
      expectedSha256: vaultCopy.sha256,
      approvedRoots: [contentDirReal]
    }
  } catch (err) {
    return {
      ok: false,
      locationId,
      errorCode: 'VAULT_COPY_CORRUPT',
      errorMessage: `Failed to verify vault copy "${vaultCopyPath}": ${(err as Error).message}`
    }
  }
}

export function resolveReadableFileLocation(
  catalog: CatalogDatabase,
  locationId: number,
  options?: ResolveReadableFileOptions
): ResolvedFileReadResult {
  const ctx = catalog.getLocationReadResolutionContext(locationId)
  if (!ctx) {
    return {
      ok: false,
      locationId,
      errorCode: 'NOT_FOUND',
      errorMessage: `File location ID ${locationId} not found in catalog`
    }
  }

  if (ctx.sourceKind === 'user') {
    if (options?.preferVaultCopy) {
      const vaultPreferred = resolveVerifiedVaultCopyForLocation(catalog, locationId, ctx, options)
      if (
        vaultPreferred.ok ||
        vaultPreferred.errorCode === 'VAULT_COPY_CORRUPT' ||
        vaultPreferred.errorCode === 'VAULT_CONTAINMENT_ERROR'
      ) {
        return vaultPreferred
      }
      if (options.allowVaultCopyFallbackForUnavailableSource && !existsSync(ctx.originalPath)) {
        return {
          ok: false,
          locationId,
          errorCode: 'FILE_UNAVAILABLE',
          errorMessage: `Original file is unavailable at "${ctx.originalPath}" and no verified vault copy was found`
        }
      }
    } else if (
      options?.allowVaultCopyFallbackForUnavailableSource &&
      !existsSync(ctx.originalPath)
    ) {
      const vaultFallback = resolveVerifiedVaultCopyForLocation(catalog, locationId, ctx, options)
      if (
        vaultFallback.ok ||
        vaultFallback.errorCode === 'VAULT_COPY_CORRUPT' ||
        vaultFallback.errorCode === 'VAULT_CONTAINMENT_ERROR'
      ) {
        return vaultFallback
      }
      return {
        ok: false,
        locationId,
        errorCode: 'FILE_UNAVAILABLE',
        errorMessage: `Original file is unavailable at "${ctx.originalPath}" and no verified vault copy was found`
      }
    }

    const approvedRoots = catalog.getAllSourceRoots()
    return {
      ok: true,
      mode: 'source',
      locationId,
      filePath: ctx.originalPath,
      originalPath: ctx.originalPath,
      expectedByteSize: ctx.byteSize,
      expectedMtimeMs: ctx.filesystemMtimeMs,
      expectedSha256: ctx.activeHash,
      approvedRoots: approvedRoots.length > 0 ? approvedRoots : [ctx.sourceRootPath]
    }
  }

  // Recovered records MUST read from the verified vault copy even if originalPath exists on disk.
  return resolveVerifiedVaultCopyForLocation(catalog, locationId, ctx, options)
}
