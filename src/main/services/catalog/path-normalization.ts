/**
 * Personal Vault — Path Normalization for Lookup Keys
 *
 * Keeps original paths and filenames untouched and factual.
 * Generates platform-aware normalized lookup keys solely for unique indexing
 * and fast case-insensitive lookups on case-insensitive filesystems (such as Windows NTFS/ReFS).
 *
 * Platform Behavior:
 * - On Windows ('win32'):
 *   1. Standardizes directory separators from '/' to '\\'.
 *   2. Resolves relative fragments (via path.win32.normalize).
 *   3. Strips trailing path separators (except for root paths such as 'C:\\').
 *   4. Folds to lowercase (using toLocaleLowerCase('en-US')) so lookups remain case-insensitive.
 *   Note on Windows Limitations:
 *   Windows NTFS and ReFS filesystems support per-directory case sensitivity.
 *   To ensure distinct files with differing case (e.g. 'file.txt' and 'FILE.TXT')
 *   never overwrite each other or discard differing recorded facts, the database
 *   maintains uniqueness and identity on the verbatim 'original_path', using
 *   'normalized_path' as an index for fast lookups.
 * - On POSIX ('linux', 'darwin', etc.):
 *   1. Standardizes directory separators using posix.normalize.
 *   2. Preserves backslashes ('\\') as valid filename characters (does NOT convert '\\' to '/').
 *   3. Strips trailing separators (except '/').
 *   4. Preserves exact case, as POSIX filesystems are case-sensitive by default.
 */

import { posix, win32 } from 'node:path'

export function normalizePathForLookup(
  filePath: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new TypeError('Path must be a non-empty string')
  }

  if (platform === 'win32') {
    // Windows: standardize forward slashes to backslashes and normalize
    let normalized = win32.normalize(filePath.replace(/\//g, '\\'))
    // Strip trailing backslash if not a root like C:\ or \\server\share\
    if (normalized.length > 3 && normalized.endsWith('\\') && !normalized.endsWith(':\\')) {
      normalized = normalized.slice(0, -1)
    }
    return normalized.toLowerCase()
  }

  // POSIX (Linux, Darwin, etc.): do NOT replace backslashes! Backslashes are valid filename characters.
  let normalized = posix.normalize(filePath)
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

export function isSameOrDescendantPath(
  parentPath: string,
  childPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const pNorm = normalizePathForLookup(parentPath, platform)
  const cNorm = normalizePathForLookup(childPath, platform)
  if (pNorm === cNorm) return true
  const sep = platform === 'win32' ? '\\' : '/'
  const prefix = pNorm.endsWith(sep) ? pNorm : pNorm + sep
  return cNorm.startsWith(prefix)
}

export function getEffectiveRoots(
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform
): string[] {
  if (!Array.isArray(roots) || roots.length === 0) return []
  const sorted = [...roots].sort(
    (a, b) =>
      normalizePathForLookup(a, platform).length - normalizePathForLookup(b, platform).length
  )
  const effective: string[] = []
  for (const r of sorted) {
    const isContained = effective.some((parent) => isSameOrDescendantPath(parent, r, platform))
    if (!isContained) {
      effective.push(r)
    }
  }
  return effective
}
