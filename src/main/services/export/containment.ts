/**
 * Personal Vault — Stage 8A Two-Tier Export Path Containment & Separation
 *
 * Allows a safe sibling export when the chosen parent is above a registered source root,
 * while strictly forbidding the parent or bundle from overlapping inside a source root,
 * vault root, or app-owned userData directory, and rejecting symlinks/junctions.
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isSameOrDescendantPath } from '../catalog/path-normalization'
import { canonicalizeWithAncestorPolicySync } from '../annotations/journal'
import { ExportContainmentError } from './errors'
import { sanitizeBundleFolderName } from './naming'

export interface ValidateExportPathParams {
  readonly parentDir: string
  readonly bundleFolderName: string
  readonly sourceRoots: readonly string[]
  readonly vaultRoots: readonly string[]
  readonly userDataDir: string
}

export interface ValidatedExportPaths {
  readonly canonicalParentDir: string
  readonly sanitizedBundleFolderName: string
  readonly bundleDir: string
}

function assertNoSymlinkOrJunctionInExistingChain(targetPath: string, label: string): void {
  let curr = resolve(targetPath)
  while (true) {
    if (existsSync(curr)) {
      const st = lstatSync(curr)
      if (st.isSymbolicLink()) {
        throw new ExportContainmentError(
          `Symbolic link or directory junction rejected in ${label}: "${curr}"`
        )
      }
    }
    const parent = dirname(curr)
    if (parent === curr) break
    curr = parent
  }
}

export function validateExportParentAndBundlePath(
  params: ValidateExportPathParams
): ValidatedExportPaths {
  if (!params.parentDir || typeof params.parentDir !== 'string') {
    throw new ExportContainmentError('Export parent directory must be a non-empty path')
  }

  const resolvedParent = resolve(params.parentDir)
  if (!existsSync(resolvedParent)) {
    throw new ExportContainmentError('Selected export parent directory does not exist')
  }

  assertNoSymlinkOrJunctionInExistingChain(resolvedParent, 'export parent directory')

  const parentLstat = lstatSync(resolvedParent)
  if (parentLstat.isSymbolicLink() || !parentLstat.isDirectory()) {
    throw new ExportContainmentError('Selected export parent path is not a regular directory')
  }

  const canonicalParentDir = realpathSync(resolvedParent)

  const checkProtectedParent = (protectedPath: string, kind: string): void => {
    if (!protectedPath) return
    const canonicalProtected = canonicalizeWithAncestorPolicySync(protectedPath)
    // Parent CANNOT be equal to or inside a source root, vault root, or app userData.
    // Parent MAY be a strict ancestor of a source root (enabling sibling export folders).
    if (isSameOrDescendantPath(canonicalProtected, canonicalParentDir)) {
      throw new ExportContainmentError(
        `Export parent directory cannot be inside or equal to ${kind}`
      )
    }
  }

  for (const src of params.sourceRoots) checkProtectedParent(src, 'a registered source root')
  for (const vault of params.vaultRoots) checkProtectedParent(vault, 'a registered vault')
  checkProtectedParent(params.userDataDir, 'app-owned data storage')

  const sanitizedBundleFolderName = sanitizeBundleFolderName(params.bundleFolderName)
  const bundleDir = join(canonicalParentDir, sanitizedBundleFolderName)

  if (existsSync(bundleDir)) {
    throw new ExportContainmentError(
      'Export bundle folder already exists and will not be overwritten'
    )
  }

  assertNoSymlinkOrJunctionInExistingChain(bundleDir, 'export bundle path')

  const checkProtectedBundle = (protectedPath: string, kind: string): void => {
    if (!protectedPath) return
    const canonicalProtected = canonicalizeWithAncestorPolicySync(protectedPath)
    // The actual bundle path cannot equal, be inside, OR be an ancestor of any protected root.
    if (
      isSameOrDescendantPath(canonicalProtected, bundleDir) ||
      isSameOrDescendantPath(bundleDir, canonicalProtected)
    ) {
      throw new ExportContainmentError(`Export bundle directory overlaps with ${kind}`)
    }
  }

  for (const src of params.sourceRoots) checkProtectedBundle(src, 'a registered source root')
  for (const vault of params.vaultRoots) checkProtectedBundle(vault, 'a registered vault')
  checkProtectedBundle(params.userDataDir, 'app-owned data storage')

  return {
    canonicalParentDir,
    sanitizedBundleFolderName,
    bundleDir
  }
}
