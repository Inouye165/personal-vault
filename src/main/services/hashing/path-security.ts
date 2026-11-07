import { isAbsolute, relative, resolve, sep } from 'node:path'

export function normalizePathForComparison(targetPath: string): string {
  const resolved = resolve(targetPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Checks whether a candidate's canonical realpath is safely contained inside
 * an approved canonical root directory.
 */
export function isPathContainedInRoot(canonicalRoot: string, candidateRealPath: string): boolean {
  const normRoot = normalizePathForComparison(canonicalRoot)
  const normCandidate = normalizePathForComparison(candidateRealPath)
  const rel = relative(normRoot, normCandidate)
  if (rel === '') return true
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false
  }
  return true
}
