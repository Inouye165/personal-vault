/**
 * Personal Vault — Stage 8B Capture-Only Staging Path Containment
 *
 * Ensures backup staging directories remain strictly inside app-owned `userDataDir`,
 * free of symbolic links or Windows directory junctions, and disjoint from all
 * registered source roots and vaults.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import { BackupRepositoryIdentityV1Schema } from '../../../shared/validation/backup-schemas'
import { canonicalizeWithAncestorPolicySync, JournalSecurityError } from '../annotations/journal'
import { isSameOrDescendantPath } from '../catalog/path-normalization'
import { BackupContainmentError } from './errors'

export interface ValidateBackupDestinationPathParams {
  readonly destinationDir: string
  readonly sourceRoots: readonly string[]
  readonly vaultRoots: readonly string[]
  readonly userDataDir: string
  readonly allowUnavailableDestination?: boolean
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
    const canonicalProtected = canonicalizeProtectedPath(protectedRoot)
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

function canonicalizeProtectedPath(targetPath: string): string {
  if (isUncPath(targetPath)) {
    return resolve(normalize(targetPath))
  }
  try {
    return canonicalizeWithAncestorPolicySync(targetPath)
  } catch (err) {
    if (err instanceof JournalSecurityError) {
      return resolve(normalize(targetPath))
    }
    throw err
  }
}

export function validateBackupDestinationPath(params: ValidateBackupDestinationPathParams): string {
  if (!params.destinationDir || typeof params.destinationDir !== 'string') {
    throw new BackupContainmentError('Backup destination directory must be a non-empty path')
  }

  const resolvedDest = resolve(params.destinationDir)
  assertNoSymlinkOrJunctionInChain(resolvedDest, 'backup destination directory')

  let canonicalDest: string
  let existingEntries: string[] | null = null
  if (existsSync(resolvedDest)) {
    const st = lstatSync(resolvedDest)
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new BackupContainmentError('Backup destination path must be a regular directory')
    }
    canonicalDest = realpathSync(resolvedDest)
    existingEntries = readdirSync(canonicalDest)
  } else if (isUncPath(resolvedDest)) {
    canonicalDest = resolvedDest
  } else {
    try {
      canonicalDest = canonicalizeWithAncestorPolicySync(resolvedDest)
    } catch (err) {
      if (err instanceof JournalSecurityError && params.allowUnavailableDestination) {
        canonicalDest = resolve(normalize(resolvedDest))
      } else {
        throw err
      }
    }
  }

  const checkProtected = (protectedPath: string, kind: string): void => {
    if (!protectedPath) return
    const canonicalProtected = canonicalizeProtectedPath(protectedPath)
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

  if (existingEntries && existingEntries.length > 0) {
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

  return canonicalDest
}

export interface ValidateRestoreTargetPathsParams {
  readonly targetProfileDir: string
  readonly targetVaultDir: string | null
  readonly backupRepoDir: string
  readonly activeUserDataDir?: string
  readonly activeSourceRoots: readonly string[]
  readonly activeVaultRoots: readonly string[]
}

export interface ValidatedRestoreTargetPaths {
  readonly targetProfileDir: string
  readonly targetVaultDir: string | null
  readonly backupRepoDir: string
}

function validateIsolatedEmptyTargetDir(targetDir: string, label: string): string {
  if (!targetDir || typeof targetDir !== 'string') {
    throw new BackupContainmentError(`${label} must be a non-empty path`)
  }
  const resolved = resolve(targetDir)
  assertNoSymlinkOrJunctionInChain(resolved, label)

  if (existsSync(resolved)) {
    const st = lstatSync(resolved)
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new BackupContainmentError(`${label} must be a regular directory`)
    }
    const canonical = realpathSync(resolved)
    if (readdirSync(canonical).length > 0) {
      throw new BackupContainmentError(
        `${label} "${targetDir}" must be a fresh or strictly empty directory`
      )
    }
    return canonical
  }

  try {
    return canonicalizeWithAncestorPolicySync(resolved)
  } catch (err) {
    throw new BackupContainmentError(
      `Failed to resolve canonical ${label}: ${(err as Error).message}`
    )
  }
}

export function validateRestoreTargetPaths(
  params: ValidateRestoreTargetPathsParams
): ValidatedRestoreTargetPaths {
  if (!params.backupRepoDir || typeof params.backupRepoDir !== 'string') {
    throw new BackupContainmentError('Backup repository directory must be a non-empty path')
  }
  const resolvedRepo = resolve(params.backupRepoDir)
  assertNoSymlinkOrJunctionInChain(resolvedRepo, 'backup repository directory')
  const canonicalRepo = existsSync(resolvedRepo)
    ? realpathSync(resolvedRepo)
    : isUncPath(resolvedRepo)
      ? resolvedRepo
      : canonicalizeWithAncestorPolicySync(resolvedRepo)

  const canonicalProfile = validateIsolatedEmptyTargetDir(
    params.targetProfileDir,
    'restore target profile directory'
  )
  const canonicalVault =
    params.targetVaultDir !== null
      ? validateIsolatedEmptyTargetDir(params.targetVaultDir, 'restore target vault directory')
      : null

  const assertDisjoint = (a: string, b: string, labelA: string, labelB: string): void => {
    if (isSameOrDescendantPath(a, b) || isSameOrDescendantPath(b, a)) {
      throw new BackupContainmentError(`${labelA} overlaps with ${labelB}`)
    }
  }

  if (canonicalVault !== null) {
    assertDisjoint(
      canonicalProfile,
      canonicalVault,
      'restore target profile directory',
      'restore target vault directory'
    )
  }

  const checkAgainstProtected = (protectedPath: string, kind: string): void => {
    if (!protectedPath) return
    const canonicalProtected = canonicalizeProtectedPath(protectedPath)
    assertDisjoint(canonicalProfile, canonicalProtected, 'restore target profile directory', kind)
    if (canonicalVault !== null) {
      assertDisjoint(canonicalVault, canonicalProtected, 'restore target vault directory', kind)
    }
  }

  checkAgainstProtected(canonicalRepo, 'the backup repository')
  if (params.activeUserDataDir) {
    checkAgainstProtected(params.activeUserDataDir, 'active app userData')
  }
  for (const src of params.activeSourceRoots) {
    checkAgainstProtected(src, 'a registered source root')
  }
  for (const vault of params.activeVaultRoots) {
    checkAgainstProtected(vault, 'a registered vault')
  }

  return {
    targetProfileDir: canonicalProfile,
    targetVaultDir: canonicalVault,
    backupRepoDir: canonicalRepo
  }
}
