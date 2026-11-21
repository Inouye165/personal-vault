/**
 * Personal Vault — Stage 8B Capture-Only Staging Path Containment
 *
 * Ensures backup staging directories remain strictly inside app-owned `userDataDir`,
 * free of symbolic links or Windows directory junctions, and disjoint from all
 * registered source roots and vaults.
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { canonicalizeWithAncestorPolicySync } from '../annotations/journal'
import { isSameOrDescendantPath } from '../catalog/path-normalization'
import { BackupContainmentError } from './errors'

export interface ValidateBackupStagingDirParams {
  readonly stagingDir: string
  readonly userDataDir: string
  readonly sourceRoots: readonly string[]
  readonly vaultRoots: readonly string[]
}

function assertNoSymlinkOrJunctionInChain(targetPath: string, label: string): void {
  let curr = resolve(targetPath)
  while (true) {
    if (existsSync(curr)) {
      let st
      try {
        st = lstatSync(curr)
      } catch (err) {
        throw new BackupContainmentError(
          `Unable to inspect ${label} path segment "${curr}": ${(err as Error).message}`
        )
      }
      if (st.isSymbolicLink()) {
        throw new BackupContainmentError(
          `Symbolic link or directory junction rejected in ${label}: "${curr}"`
        )
      }
    }
    const parent = dirname(curr)
    if (parent === curr) {
      break
    }
    curr = parent
  }
}

export function validateBackupStagingDir(params: ValidateBackupStagingDirParams): string {
  if (!params.stagingDir || typeof params.stagingDir !== 'string') {
    throw new BackupContainmentError('Backup staging directory must be a non-empty path')
  }
  if (!params.userDataDir || typeof params.userDataDir !== 'string') {
    throw new BackupContainmentError('App userData directory must be a non-empty path')
  }

  assertNoSymlinkOrJunctionInChain(params.userDataDir, 'app userData directory')
  assertNoSymlinkOrJunctionInChain(params.stagingDir, 'backup staging directory')

  let canonicalUserData: string
  try {
    canonicalUserData = existsSync(params.userDataDir)
      ? realpathSync(params.userDataDir)
      : canonicalizeWithAncestorPolicySync(params.userDataDir)
  } catch (err) {
    throw new BackupContainmentError(
      `Failed to resolve canonical userData directory: ${(err as Error).message}`
    )
  }

  let canonicalStaging: string
  try {
    canonicalStaging = canonicalizeWithAncestorPolicySync(params.stagingDir)
  } catch (err) {
    throw new BackupContainmentError(
      `Failed to resolve canonical staging directory: ${(err as Error).message}`
    )
  }

  if (
    !isSameOrDescendantPath(canonicalUserData, canonicalStaging) ||
    isSameOrDescendantPath(canonicalStaging, canonicalUserData)
  ) {
    throw new BackupContainmentError(
      `Backup staging directory "${params.stagingDir}" must be a strict subdirectory of app userData`
    )
  }

  const rejectOverlap = (protectedRoot: string, kind: string): void => {
    if (!protectedRoot) return
    const canonicalProtected = canonicalizeWithAncestorPolicySync(protectedRoot)
    if (
      isSameOrDescendantPath(canonicalProtected, canonicalStaging) ||
      isSameOrDescendantPath(canonicalStaging, canonicalProtected)
    ) {
      throw new BackupContainmentError(
        `Backup staging directory "${params.stagingDir}" overlaps with ${kind}`
      )
    }
  }

  for (const src of params.sourceRoots) {
    rejectOverlap(src, 'a registered source root')
  }
  for (const vault of params.vaultRoots) {
    rejectOverlap(vault, 'a registered vault')
  }

  return canonicalStaging
}
