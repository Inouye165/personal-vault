/**
 * Personal Vault — Stage 8B Capture-Only Staging Path Containment
 *
 * Ensures backup staging directories remain strictly inside app-owned `userDataDir`,
 * free of symbolic links or Windows directory junctions, and disjoint from all
 * registered source roots and vaults.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { BackupRepositoryIdentityV1Schema } from '../../../shared/validation/backup-schemas'
import { canonicalizeWithAncestorPolicySync } from '../annotations/journal'
import { isSameOrDescendantPath } from '../catalog/path-normalization'
import { BackupContainmentError } from './errors'

export interface ValidateBackupDestinationPathParams {
  readonly destinationDir: string
  readonly sourceRoots: readonly string[]
  readonly vaultRoots: readonly string[]
  readonly userDataDir: string
}

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

function isUncPath(targetPath: string): boolean {
  return /^\\\\[^\\]+\\[^\\]+/.test(targetPath)
}

export function validateBackupDestinationPath(params: ValidateBackupDestinationPathParams): string {
  if (!params.destinationDir || typeof params.destinationDir !== 'string') {
    throw new BackupContainmentError('Backup destination directory must be a non-empty path')
  }

  const resolvedDest = resolve(params.destinationDir)
  assertNoSymlinkOrJunctionInChain(resolvedDest, 'backup destination directory')

  let canonicalDest: string
  if (existsSync(resolvedDest)) {
    const st = lstatSync(resolvedDest)
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new BackupContainmentError('Backup destination path must be a regular directory')
    }
    canonicalDest = realpathSync(resolvedDest)

    const entries = readdirSync(canonicalDest)
    if (entries.length > 0) {
      const repoJsonPath = join(canonicalDest, 'repository.json')
      if (!existsSync(repoJsonPath)) {
        throw new BackupContainmentError(
          'Backup destination directory is non-empty and does not contain a valid repository.json'
        )
      }
      try {
        const raw = readFileSync(repoJsonPath, 'utf8')
        BackupRepositoryIdentityV1Schema.parse(JSON.parse(raw))
      } catch (err) {
        throw new BackupContainmentError(
          `Existing backup destination repository.json is invalid: ${(err as Error).message}`
        )
      }
    }
  } else {
    canonicalDest = isUncPath(resolvedDest)
      ? resolvedDest
      : canonicalizeWithAncestorPolicySync(resolvedDest)
  }

  const checkProtected = (protectedPath: string, kind: string): void => {
    if (!protectedPath) return
    const canonicalProtected = canonicalizeWithAncestorPolicySync(protectedPath)
    if (
      isSameOrDescendantPath(canonicalProtected, canonicalDest) ||
      isSameOrDescendantPath(canonicalDest, canonicalProtected)
    ) {
      throw new BackupContainmentError(`Backup destination directory overlaps with ${kind}`)
    }
  }

  for (const src of params.sourceRoots) checkProtected(src, 'a registered source root')
  for (const vault of params.vaultRoots) checkProtected(vault, 'a registered vault')
  checkProtected(params.userDataDir, 'app-owned data storage')

  return canonicalDest
}
