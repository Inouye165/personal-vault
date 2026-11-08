/**
 * Personal Vault — Portable Metadata Manifest Management (Stage 4)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { VaultManifest, VaultManifestManagedCopy, VaultManifestSourceEntry } from './types'

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
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed.formatVersion !== 1 || parsed.sha256 !== sha256) {
      return null
    }
    return parsed as VaultManifest
  } catch {
    return null
  }
}

export function writeVaultManifest(vaultPath: string, manifest: VaultManifest): void {
  const targetPath = getManifestAbsolutePath(vaultPath, manifest.sha256)
  const targetDir = dirname(targetPath)
  mkdirSync(targetDir, { recursive: true })

  const stagingDir = join(vaultPath, '.vault-temp')
  mkdirSync(stagingDir, { recursive: true })

  const tempPath = join(stagingDir, `manifest_${manifest.sha256}_${randomUUID()}.tmp`)
  const jsonContent = JSON.stringify(manifest, null, 2)

  writeFileSync(tempPath, jsonContent, 'utf-8')

  try {
    // Atomic rename
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

  // Check if originalPath is already present
  const existingSources = [...existingManifest.sources]
  const matchIndex = existingSources.findIndex((s) => s.originalPath === newSource.originalPath)

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
