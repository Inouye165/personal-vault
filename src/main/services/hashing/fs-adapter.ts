import { lstat, open, realpath } from 'node:fs/promises'

/**
 * Narrow, strictly read-only file metadata.
 */
export interface ReadOnlyFileStats {
  readonly size: number
  readonly mtimeMs: number
  readonly birthtimeMs: number
  readonly dev?: number
  readonly ino?: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/**
 * Narrow, strictly read-only file handle supporting bounded chunked reads,
 * metadata inspection via fstat, and deterministic handle closure.
 */
export interface ReadOnlyFileHandle {
  stat(): Promise<ReadOnlyFileStats>
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null
  ): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

/**
 * Strictly read-only filesystem adapter for hashing operations.
 *
 * Intentionally excludes all mutation capabilities (`writeFile`, `unlink`, `rm`,
 * `rename`, `utimes`, `chmod`, `chown`, `truncate`, `copyFile`, `mkdir`).
 * File descriptors are opened strictly with the read-only flag ('r').
 *
 * Note on OS access times: while this adapter performs only read-only operations
 * (`lstat`, `realpath`, `open` in read mode, and chunked `read`), operating systems
 * and filesystems (depending on mount options such as `relatime` or `noatime` on POSIX
 * or NTFS `NtfsDisableLastAccessUpdate` on Windows) may update `atime` at the kernel
 * level during file reads. File contents, creation times (`birthtime`), and modification
 * times (`mtime`) are never altered.
 */
export interface ReadOnlyHashingFsAdapter {
  lstat(path: string): Promise<ReadOnlyFileStats>
  realpath(path: string): Promise<string>
  open(path: string): Promise<ReadOnlyFileHandle>
}

export function createNodeReadOnlyHashingFsAdapter(): ReadOnlyHashingFsAdapter {
  const adapter: ReadOnlyHashingFsAdapter = {
    async lstat(path: string): Promise<ReadOnlyFileStats> {
      const stats = await lstat(path)
      return {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        birthtimeMs: stats.birthtimeMs,
        dev: stats.dev,
        ino: stats.ino,
        isFile: () => stats.isFile(),
        isDirectory: () => stats.isDirectory(),
        isSymbolicLink: () => stats.isSymbolicLink()
      }
    },
    async realpath(path: string): Promise<string> {
      return realpath(path)
    },
    async open(path: string): Promise<ReadOnlyFileHandle> {
      const handle = await open(path, 'r')
      let closed = false

      const readOnlyHandle: ReadOnlyFileHandle = {
        async stat(): Promise<ReadOnlyFileStats> {
          const stats = await handle.stat()
          return {
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            birthtimeMs: stats.birthtimeMs,
            dev: stats.dev,
            ino: stats.ino,
            isFile: () => stats.isFile(),
            isDirectory: () => stats.isDirectory(),
            isSymbolicLink: () => stats.isSymbolicLink()
          }
        },
        async read(
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number | null
        ): Promise<{ bytesRead: number }> {
          const res = await handle.read(buffer, offset, length, position)
          return { bytesRead: res.bytesRead }
        },
        async close(): Promise<void> {
          if (!closed) {
            closed = true
            await handle.close()
          }
        }
      }

      return Object.freeze(readOnlyHandle)
    }
  }

  return Object.freeze(adapter)
}
