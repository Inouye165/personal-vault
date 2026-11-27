/**
 * Personal Vault — Portable Metadata Manifest Management (Stage 4)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { VaultManifest, VaultManifestManagedCopy, VaultManifestSourceEntry } from './types'
import { VaultManifestCorruptedError } from './errors'
import { assertPathContainedInVault } from './containment'
import { VaultManifestSchema } from './manifest-schema'

export function getManifestRelativePath(sha256: string): string {
  const prefix = sha256.slice(0, 2)
  return `files/${prefix}/${sha256}/manifest.json`
}

export function getManifestAbsolutePath(vaultPath: string, sha256: string): string {
  const prefix = sha256.slice(0, 2)
  return join(vaultPath, 'files', prefix, sha256, 'manifest.json')
}

export function readVaultManifest(vaultPath: string, sha256: string): VaultManifest | null {
  const filePath = getManifestAbsolutePath(vaultPath, sha256)
  assertPathContainedInVault(vaultPath, filePath, 'manifest path')

  if (!existsSync(filePath)) {
    return null
  }
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new VaultManifestCorruptedError(
      filePath,
      `Failed to read manifest file: ${(err as Error).message}`
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new VaultManifestCorruptedError(
      filePath,
      `Manifest is not valid JSON: ${(err as Error).message}`
    )
  }

  const validation = VaultManifestSchema.safeParse(parsed)
  if (!validation.success) {
    throw new VaultManifestCorruptedError(
      filePath,
      `Manifest content failed strict schema validation: ${validation.error.message}`
    )
  }

  if (validation.data.sha256.toLowerCase() !== sha256.toLowerCase()) {
    throw new VaultManifestCorruptedError(
      filePath,
      `Manifest sha256 "${validation.data.sha256}" does not match path sha256 "${sha256}"`
    )
  }

  return validation.data as unknown as VaultManifest
}

export function writeVaultManifest(
  vaultPath: string,
  manifest: VaultManifest,
  jobId?: string
): void {
  // 1. Strict schema validation before writing to disk
  const validated = VaultManifestSchema.parse(manifest)

  const targetPath = getManifestAbsolutePath(vaultPath, validated.sha256)
  assertPathContainedInVault(vaultPath, targetPath, 'manifest target path')

  const targetDir = dirname(targetPath)
  mkdirSync(targetDir, { recursive: true })

  const stagingDir = join(vaultPath, '.vault-temp')
  assertPathContainedInVault(vaultPath, stagingDir, 'manifest staging directory')
  mkdirSync(stagingDir, { recursive: true })

  const jobPrefix = jobId ? `job_${jobId}_` : ''
  const tempPath = join(
    stagingDir,
    `pv_manifest_${validated.vaultId}_${jobPrefix}${validated.sha256}_${randomUUID()}.tmp`
  )
  assertPathContainedInVault(vaultPath, tempPath, 'manifest staging file')

  const jsonContent = JSON.stringify(validated, null, 2)
  writeFileSync(tempPath, jsonContent, { encoding: 'utf-8', flag: 'wx' })

  try {
    renameSync(tempPath, targetPath)
  } catch (err) {
    try {
      unlinkSync(tempPath)
    } catch {
      // Ignore cleanup error
    }
    throw err
  }
}

export function mergeManifestSources(
  existingManifest: VaultManifest | null,
  newSource: VaultManifestSourceEntry,
  fallbackManagedCopy: VaultManifestManagedCopy,
  vaultId: string,
  sha256: string,
  byteSize: number
): VaultManifest {
  if (!existingManifest) {
    return {
      formatVersion: 1,
      vaultId,
      sha256,
      byteSize,
      managedCopy: fallbackManagedCopy,
      sources: [newSource]
    }
  }

  // Preserve prior observations/import results during repeated imports without unbounded duplication of identical entries.
  // Match on exact provenance: fileLocationId AND discoveryObservationId AND hashObservationId
  const existingSources = [...existingManifest.sources]
  const matchIndex = existingSources.findIndex(
    (s) =>
      s.fileLocationId === newSource.fileLocationId &&
      s.recordedFacts.discoveryObservationId === newSource.recordedFacts.discoveryObservationId &&
      s.recordedFacts.hashObservationId === newSource.recordedFacts.hashObservationId
  )

  if (matchIndex >= 0) {
    existingSources[matchIndex] = newSource
  } else {
    existingSources.push(newSource)
  }

  return {
    ...existingManifest,
    sources: existingSources
  }
}
