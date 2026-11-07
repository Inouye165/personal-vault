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
 * - On POSIX ('linux', 'darwin', etc.):
 *   1. Standardizes directory separators to '/'.
 *   2. Resolves relative fragments (via path.posix.normalize).
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
    // Windows: standardize to backslashes and normalize
    let normalized = win32.normalize(filePath.replace(/\//g, '\\'))
    // Strip trailing backslash if not a root like C:\ or \\server\share\
    if (normalized.length > 3 && normalized.endsWith('\\') && !normalized.endsWith(':\\')) {
      normalized = normalized.slice(0, -1)
    }
    return normalized.toLowerCase()
  }

  // POSIX: standardize to forward slashes and normalize
  let normalized = posix.normalize(filePath.replace(/\\/g, '/'))
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}
