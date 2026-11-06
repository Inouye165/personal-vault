import { lstat, opendir, realpath } from 'node:fs/promises'

/**
 * Narrow, strictly read-only directory entry representation.
 */
export interface ReadOnlyDirEntry {
  readonly name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/**
 * Narrow, strictly read-only directory handle supporting incremental iteration
 * and deterministic handle release.
 */
export interface ReadOnlyDirHandle {
  read(): Promise<ReadOnlyDirEntry | null>
  close(): Promise<void>
}

/**
 * Narrow, strictly read-only file/directory metadata.
 */
export interface ReadOnlyFsStats {
  readonly size: number
  readonly mtimeMs: number
  readonly birthtimeMs: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/**
 * Strictly read-only filesystem adapter for discovery.
 *
 * Intentionally excludes all mutation capabilities (`writeFile`, `unlink`, `rm`,
 * `rename`, `utimes`, `chmod`, `chown`, `truncate`, `copyFile`, `mkdir`, `open`).
 *
 * Note on OS access times: while this adapter performs only read-only metadata
 * and directory listing calls (`lstat`, `realpath`, `opendir`), operating systems
 * and filesystems (Depending on mount options such as `relatime` or `noatime` on
 * POSIX or NTFS `NtfsDisableLastAccessUpdate` on Windows) may update `atime` at the
 * kernel level during directory traversal. File contents, creation times (`birthtime`),
 * and modification times (`mtime`) are never altered.
 */
export interface ReadOnlyFsAdapter {
  lstat(path: string): Promise<ReadOnlyFsStats>
  realpath(path: string): Promise<string>
  opendir(path: string): Promise<ReadOnlyDirHandle>
}

export function createNodeReadOnlyFsAdapter(): ReadOnlyFsAdapter {
  const adapter: ReadOnlyFsAdapter = {
    async lstat(path: string): Promise<ReadOnlyFsStats> {
      const stats = await lstat(path)
      return {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        birthtimeMs: stats.birthtimeMs,
        isFile: () => stats.isFile(),
        isDirectory: () => stats.isDirectory(),
        isSymbolicLink: () => stats.isSymbolicLink()
      }
    },
    async realpath(path: string): Promise<string> {
      return realpath(path)
    },
    async opendir(path: string): Promise<ReadOnlyDirHandle> {
      const dir = await opendir(path)
      return {
        async read(): Promise<ReadOnlyDirEntry | null> {
          const entry = await dir.read()
          if (!entry) return null
          return {
            name: entry.name,
            isFile: () => entry.isFile(),
            isDirectory: () => entry.isDirectory(),
            isSymbolicLink: () => entry.isSymbolicLink()
          }
        },
        async close(): Promise<void> {
          await dir.close()
        }
      }
    }
  }

  return Object.freeze(adapter)
}
