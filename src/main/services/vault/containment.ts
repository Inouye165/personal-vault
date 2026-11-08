/**
 * Personal Vault — Vault Path Containment & Security (Stage 4)
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { isPathContainedInRoot } from '../hashing/path-security'
import { VaultOverlapError } from './errors'

/**
 * Ensures that a target path is strictly contained within the canonical vault root
 * and that no existing path segment along the traversal is a symlink or junction redirection.
 */
export function assertPathContainedInVault(
  vaultPath: string,
  targetPath: string,
  contextDesc = 'path'
): void {
  let canonicalVault: string
  try {
    canonicalVault = realpathSync(vaultPath)
  } catch {
    canonicalVault = resolve(vaultPath)
  }

  const resolvedTarget = resolve(targetPath)

  // 1. Textual / normalized containment verification
  if (!isPathContainedInRoot(canonicalVault, resolvedTarget)) {
    throw new VaultOverlapError(
      `${contextDesc} "${targetPath}" resolves outside vault boundary "${canonicalVault}"`
    )
  }

  // 2. Walk path segments from canonicalVault to resolvedTarget checking for symlinks/junctions
  const rel = relative(canonicalVault, resolvedTarget)
  if (rel && rel !== '.' && !rel.startsWith('..')) {
    const parts = rel.split(sep)
    let current = canonicalVault
    for (const part of parts) {
      current = resolve(current, part)
      if (existsSync(current)) {
        try {
          const st = lstatSync(current)
          if (st.isSymbolicLink()) {
            throw new VaultOverlapError(
              `Symlink or junction redirection rejected inside vault for ${contextDesc}: "${current}"`
            )
          }

          // Verify realpath of existing directory/file doesn't redirect outside vault root
          const realCurrent = realpathSync(current)
          if (!isPathContainedInRoot(canonicalVault, realCurrent)) {
            throw new VaultOverlapError(
              `Path redirection rejected inside vault: "${current}" resolves outside vault boundary`
            )
          }
        } catch (err) {
          if (err instanceof VaultOverlapError) throw err
        }
      }
    }
  }
}
