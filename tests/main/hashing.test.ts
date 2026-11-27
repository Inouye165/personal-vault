import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createNodeReadOnlyHashingFsAdapter,
  hashFile,
  type ReadOnlyFileHandle,
  type ReadOnlyFileStats,
  type ReadOnlyHashingFsAdapter
} from '../../src/main/services/hashing'

describe('Stage 2B: Read-only streaming SHA-256 hashing', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(os.tmpdir(), 'pv-hashing-test-'))
  })

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  describe('Resource limit validation and approved roots requirement', () => {
    it('rejects invalid chunkSizeBytes before opening files', async () => {
      const invalidChunks = [0, -1, 500, 1023, 16 * 1024 * 1024 + 1, NaN, Infinity, 1024.5]
      for (const chunk of invalidChunks) {
        await expect(
          hashFile({
            filePath: join(tempDir, 'dummy.txt'),
            approvedRoots: [tempDir],
            limits: { chunkSizeBytes: chunk }
          })
        ).rejects.toThrow(RangeError)
      }
    })

    it('rejects invalid maxFileSizeBytes before opening files', async () => {
      const invalidSizes = [-1, NaN, Infinity, 100.5]
      for (const size of invalidSizes) {
        await expect(
          hashFile({
            filePath: join(tempDir, 'dummy.txt'),
            approvedRoots: [tempDir],
            limits: { maxFileSizeBytes: size }
          })
        ).rejects.toThrow(RangeError)
      }
    })

    it('does not invoke filesystem adapter when limits are invalid', async () => {
      let lstatCalled = false
      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat() {
          lstatCalled = true
          throw new Error('should not be called')
        },
        async realpath(p) {
          return p
        },
        async open() {
          throw new Error('should not be called')
        }
      }

      await expect(
        hashFile({
          filePath: join(tempDir, 'dummy.txt'),
          approvedRoots: [tempDir],
          limits: { chunkSizeBytes: -64 },
          fsAdapter: mockAdapter
        })
      ).rejects.toThrow(RangeError)

      expect(lstatCalled).toBe(false)
    })

    it('rejects missing or empty approvedRoots before filesystem access', async () => {
      let lstatCalled = false
      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat() {
          lstatCalled = true
          throw new Error('should not be called')
        },
        async realpath(p) {
          return p
        },
        async open() {
          throw new Error('should not be called')
        }
      }

      // Missing approvedRoots
      await expect(
        hashFile({
          filePath: join(tempDir, 'dummy.txt'),
          // @ts-expect-error approvedRoots is required by type
          approvedRoots: undefined,
          fsAdapter: mockAdapter
        })
      ).rejects.toThrow(RangeError)

      // Empty approvedRoots array
      await expect(
        hashFile({
          filePath: join(tempDir, 'dummy.txt'),
          approvedRoots: [],
          fsAdapter: mockAdapter
        })
      ).rejects.toThrow(RangeError)

      // Array with blank string
      await expect(
        hashFile({
          filePath: join(tempDir, 'dummy.txt'),
          approvedRoots: ['   '],
          fsAdapter: mockAdapter
        })
      ).rejects.toThrow(RangeError)

      expect(lstatCalled).toBe(false)
    })

    it('rejects approved root that is a regular file or does not exist', async () => {
      const regularFileAsRoot = join(tempDir, 'file-root.txt')
      await fs.writeFile(regularFileAsRoot, 'not a directory')
      const targetFile = join(tempDir, 'target.txt')
      await fs.writeFile(targetFile, 'content')

      const result = await hashFile({
        filePath: targetFile,
        approvedRoots: [regularFileAsRoot]
      })

      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason).toBe('outside_approved_root')
      }

      const missingRoot = join(tempDir, 'nonexistent-root')
      const result2 = await hashFile({
        filePath: targetFile,
        approvedRoots: [missingRoot]
      })

      expect(result2.status).toBe('rejected')
      if (result2.status === 'rejected') {
        expect(result2.reason).toBe('outside_approved_root')
      }
    })
  })

  describe('SHA-256 correctness and streaming bounded reads', () => {
    it('hashes an empty file to the standard SHA-256 empty digest', async () => {
      const filePath = join(tempDir, 'empty.txt')
      await fs.writeFile(filePath, Buffer.alloc(0))

      const result = await hashFile({
        filePath,
        approvedRoots: [tempDir]
      })
      expect(result.status).toBe('success')
      if (result.status === 'success') {
        expect(result.sha256).toBe(
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        )
        expect(result.byteSize).toBe(0)
        expect(result.path).toBe(filePath)
        expect(result.canonicalPath).toBe(await fs.realpath(filePath))
      }
    })

    it('hashes binary files matching Node crypto digest', async () => {
      const filePath = join(tempDir, 'binary.bin')
      const payload = randomBytes(128 * 1024) // 128 KiB
      await fs.writeFile(filePath, payload)

      const expectedSha256 = createHash('sha256').update(payload).digest('hex')

      const result = await hashFile({
        filePath,
        approvedRoots: [tempDir]
      })
      expect(result.status).toBe('success')
      if (result.status === 'success') {
        expect(result.sha256).toBe(expectedSha256)
        expect(result.byteSize).toBe(payload.length)
      }
    })

    it('produces identical digest regardless of chunk boundaries, filenames, and paths', async () => {
      const payload = randomBytes(70 * 1024 + 13) // ~70 KiB + 13 bytes
      const file1 = join(tempDir, 'file1.dat')
      const subDir = join(tempDir, 'sub')
      await fs.mkdir(subDir)
      const file2 = join(subDir, 'file2.renamed')

      await fs.writeFile(file1, payload)
      await fs.writeFile(file2, payload)

      const res1 = await hashFile({
        filePath: file1,
        approvedRoots: [tempDir],
        limits: { chunkSizeBytes: 1024 } // 1 KiB chunks
      })
      const res2 = await hashFile({
        filePath: file2,
        approvedRoots: [tempDir],
        limits: { chunkSizeBytes: 32 * 1024 } // 32 KiB chunks
      })
      const resDefault = await hashFile({
        filePath: file1,
        approvedRoots: [tempDir]
      })

      expect(res1.status).toBe('success')
      expect(res2.status).toBe('success')
      expect(resDefault.status).toBe('success')

      if (
        res1.status === 'success' &&
        res2.status === 'success' &&
        resDefault.status === 'success'
      ) {
        expect(res1.sha256).toBe(res2.sha256)
        expect(res1.sha256).toBe(resDefault.sha256)
      }
    })
  })

  describe('Source preservation and read-only boundary', () => {
    it('preserves file bytes, creation time, and modification time', async () => {
      const filePath = join(tempDir, 'preserve.txt')
      const content = Buffer.from('Preserve source integrity at all costs')
      await fs.writeFile(filePath, content)

      // Set explicit fixed mtime and atime
      const fixedTime = new Date('2023-01-15T12:00:00.000Z')
      await fs.utimes(filePath, fixedTime, fixedTime)

      const statBefore = await fs.stat(filePath)

      const result = await hashFile({
        filePath,
        approvedRoots: [tempDir]
      })
      expect(result.status).toBe('success')

      const statAfter = await fs.stat(filePath)
      const contentAfter = await fs.readFile(filePath)

      // Bytes remain identical
      expect(contentAfter.equals(content)).toBe(true)
      // Mtime remains identical
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs)
      // Birthtime remains identical
      expect(statAfter.birthtimeMs).toBe(statBefore.birthtimeMs)
    })
  })

  describe('Path containment and non-regular file rejection', () => {
    it('rejects symbolic links without opening', async () => {
      const targetFile = join(tempDir, 'real-target.txt')
      await fs.writeFile(targetFile, 'target content')
      const linkFile = join(tempDir, 'link-to-target.txt')

      let linkCreated = false
      try {
        await fs.symlink(targetFile, linkFile)
        linkCreated = true
      } catch {
        // In environments where symlink creation is restricted, skip this test
      }

      if (linkCreated) {
        const result = await hashFile({
          filePath: linkFile,
          approvedRoots: [tempDir]
        })
        expect(result.status).toBe('rejected')
        if (result.status === 'rejected') {
          expect(result.reason).toBe('symbolic_link')
        }
      }
    })

    it('rejects directories with not_regular_file', async () => {
      const dirPath = join(tempDir, 'some-dir')
      await fs.mkdir(dirPath)

      const result = await hashFile({
        filePath: dirPath,
        approvedRoots: [tempDir]
      })
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason).toBe('not_regular_file')
      }
    })

    it('rejects files outside approved roots', async () => {
      const approvedRoot = join(tempDir, 'approved')
      const outsideRoot = join(tempDir, 'outside')
      await fs.mkdir(approvedRoot)
      await fs.mkdir(outsideRoot)

      const outsideFile = join(outsideRoot, 'secret.txt')
      await fs.writeFile(outsideFile, 'secret data')

      const result = await hashFile({
        filePath: outsideFile,
        approvedRoots: [approvedRoot]
      })

      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason).toBe('outside_approved_root')
      }
    })

    it('allows files strictly within approved roots', async () => {
      const approvedRoot = join(tempDir, 'approved')
      await fs.mkdir(approvedRoot)
      const allowedFile = join(approvedRoot, 'document.txt')
      await fs.writeFile(allowedFile, 'allowed content')

      const result = await hashFile({
        filePath: allowedFile,
        approvedRoots: [approvedRoot]
      })

      expect(result.status).toBe('success')
    })

    it('allows files matching secondary approved root in multiple roots list', async () => {
      const root1 = join(tempDir, 'root1')
      const root2 = join(tempDir, 'root2')
      await fs.mkdir(root1)
      await fs.mkdir(root2)
      const fileInRoot2 = join(root2, 'target.txt')
      await fs.writeFile(fileInRoot2, 'second root content')

      const result = await hashFile({
        filePath: fileInRoot2,
        approvedRoots: [root1, root2]
      })

      expect(result.status).toBe('success')
    })

    it('rejects path traversal attempting escape from approved root', async () => {
      const approvedRoot = join(tempDir, 'approved')
      const outsideRoot = join(tempDir, 'outside')
      await fs.mkdir(approvedRoot)
      await fs.mkdir(outsideRoot)

      const secretFile = join(outsideRoot, 'secret.txt')
      await fs.writeFile(secretFile, 'secret')

      const traversalPath = join(approvedRoot, '..', 'outside', 'secret.txt')
      const result = await hashFile({
        filePath: traversalPath,
        approvedRoots: [approvedRoot]
      })

      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason).toBe('outside_approved_root')
      }
    })

    it('rejects files exceeding maxFileSizeBytes before reading', async () => {
      const filePath = join(tempDir, 'large.bin')
      await fs.writeFile(filePath, Buffer.alloc(1000))

      const result = await hashFile({
        filePath,
        approvedRoots: [tempDir],
        limits: { maxFileSizeBytes: 500 }
      })

      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason).toBe('file_size_exceeded')
      }
    })
  })

  describe('Discovery expectation validation and file stability checks', () => {
    it('detects byteSize mismatch against discovery expectation', async () => {
      const filePath = join(tempDir, 'changed.txt')
      await fs.writeFile(filePath, 'hello')
      const stat = await fs.stat(filePath)

      const result = await hashFile({
        filePath,
        approvedRoots: [tempDir],
        expectation: {
          byteSize: stat.size + 10,
          mtimeMs: stat.mtimeMs
        }
      })

      expect(result.status).toBe('file_changed')
      if (result.status === 'file_changed') {
        expect(result.reason).toBe('size_mismatch_discovery')
      }
    })

    it('detects mtime mismatch against discovery expectation', async () => {
      const filePath = join(tempDir, 'changed-time.txt')
      await fs.writeFile(filePath, 'hello')
      const stat = await fs.stat(filePath)

      const result = await hashFile({
        filePath,
        approvedRoots: [tempDir],
        expectation: {
          byteSize: stat.size,
          mtimeMs: stat.mtimeMs - 5000
        }
      })

      expect(result.status).toBe('file_changed')
      if (result.status === 'file_changed') {
        expect(result.reason).toBe('mtime_modified_discovery')
      }
    })

    it('detects birthtime mismatch against discovery expectation', async () => {
      const filePath = join(tempDir, 'changed-birthtime.txt')
      await fs.writeFile(filePath, 'hello')
      const stat = await fs.stat(filePath)

      const result = await hashFile({
        filePath,
        approvedRoots: [tempDir],
        expectation: {
          byteSize: stat.size,
          mtimeMs: stat.mtimeMs,
          birthtimeMs: stat.birthtimeMs - 10000
        }
      })

      expect(result.status).toBe('file_changed')
      if (result.status === 'file_changed') {
        expect(result.reason).toBe('birthtime_modified_discovery')
      }
    })

    it('detects fractional-millisecond mtime change between lstat and open', async () => {
      let lstatCalled = false
      let closed = false

      const stat1: ReadOnlyFileStats = {
        size: 100,
        mtimeMs: 1000.1, // fractional ms
        birthtimeMs: 500,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      const stat2: ReadOnlyFileStats = {
        size: 100,
        mtimeMs: 1000.2, // changed by 0.1 ms (flooring would erroneously treat them as 1000 === 1000)
        birthtimeMs: 500,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat(p): Promise<ReadOnlyFileStats> {
          if (p === '/virtual') {
            return {
              size: 0,
              mtimeMs: 0,
              birthtimeMs: 0,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false
            }
          }
          lstatCalled = true
          return stat1
        },
        async realpath(p: string): Promise<string> {
          return p
        },
        async open(): Promise<ReadOnlyFileHandle> {
          return {
            async stat(): Promise<ReadOnlyFileStats> {
              return stat2
            },
            async read(): Promise<{ bytesRead: number }> {
              return { bytesRead: 0 }
            },
            async close(): Promise<void> {
              closed = true
            }
          }
        }
      }

      const result = await hashFile({
        filePath: '/virtual/fractional.txt',
        approvedRoots: ['/virtual'],
        fsAdapter: mockAdapter
      })

      expect(lstatCalled).toBe(true)
      expect(result.status).toBe('file_changed')
      if (result.status === 'file_changed') {
        expect(result.reason).toBe('mtime_modified_during_read')
      }
      expect(closed).toBe(true)
    })

    it('detects fractional-millisecond mtime change during read (pre vs post stat)', async () => {
      let readCount = 0
      let closed = false

      const preStat: ReadOnlyFileStats = {
        size: 1024,
        mtimeMs: 2000.125,
        birthtimeMs: 500,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      const postStat: ReadOnlyFileStats = {
        size: 1024,
        mtimeMs: 2000.875, // changed within same integer second
        birthtimeMs: 500,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat(p): Promise<ReadOnlyFileStats> {
          if (p === '/virtual') {
            return {
              size: 0,
              mtimeMs: 0,
              birthtimeMs: 0,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false
            }
          }
          return preStat
        },
        async realpath(p: string): Promise<string> {
          return p
        },
        async open(): Promise<ReadOnlyFileHandle> {
          return {
            async stat(): Promise<ReadOnlyFileStats> {
              return readCount > 0 ? postStat : preStat
            },
            async read(buf, offset): Promise<{ bytesRead: number }> {
              readCount++
              if (readCount === 1) {
                buf.fill(0, offset, offset + 1024)
                return { bytesRead: 1024 }
              }
              return { bytesRead: 0 }
            },
            async close(): Promise<void> {
              closed = true
            }
          }
        }
      }

      const result = await hashFile({
        filePath: '/virtual/post-frac.txt',
        approvedRoots: ['/virtual'],
        limits: { chunkSizeBytes: 1024 },
        fsAdapter: mockAdapter
      })

      expect(result.status).toBe('file_changed')
      if (result.status === 'file_changed') {
        expect(result.reason).toBe('mtime_modified_during_read')
      }
      expect(closed).toBe(true)
    })

    it('tolerates integer discovery expectation with live sub-millisecond precision, but detects >= 1ms changes', async () => {
      const mockDirStat: ReadOnlyFileStats = {
        size: 0,
        mtimeMs: 0,
        birthtimeMs: 0,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false
      }

      const liveStat: ReadOnlyFileStats = {
        size: 100,
        mtimeMs: 1700000000123.456, // live stat has fractional ms
        birthtimeMs: 500,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat(p): Promise<ReadOnlyFileStats> {
          return p === '/virtual' ? mockDirStat : liveStat
        },
        async realpath(p): Promise<string> {
          return p
        },
        async open(): Promise<ReadOnlyFileHandle> {
          let readDone = false
          return {
            async stat(): Promise<ReadOnlyFileStats> {
              return liveStat
            },
            async read(buf, offset): Promise<{ bytesRead: number }> {
              if (readDone) return { bytesRead: 0 }
              readDone = true
              buf.fill(0, offset, offset + 100)
              return { bytesRead: 100 }
            },
            async close(): Promise<void> {}
          }
        }
      }

      // Expected integer timestamp with sub-ms truncated in discovery (1700000000123)
      const resMatch = await hashFile({
        filePath: '/virtual/consistent.txt',
        approvedRoots: ['/virtual'],
        expectation: {
          byteSize: 100,
          mtimeMs: 1700000000123 // within 1ms tolerance
        },
        fsAdapter: mockAdapter
      })

      expect(resMatch.status).toBe('success')

      // Expected integer timestamp that differs by >= 1ms (1700000000125)
      const resMismatch = await hashFile({
        filePath: '/virtual/consistent.txt',
        approvedRoots: ['/virtual'],
        expectation: {
          byteSize: 100,
          mtimeMs: 1700000000125
        },
        fsAdapter: mockAdapter
      })

      expect(resMismatch.status).toBe('file_changed')
      if (resMismatch.status === 'file_changed') {
        expect(resMismatch.reason).toBe('mtime_modified_discovery')
      }
    })

    it('detects file size change between lstat and open', async () => {
      let lstatCount = 0
      let closed = false

      const initialStats: ReadOnlyFileStats = {
        size: 100,
        mtimeMs: 1000,
        birthtimeMs: 500,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      const openedStats: ReadOnlyFileStats = {
        size: 200,
        mtimeMs: 1000,
        birthtimeMs: 500,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat(p): Promise<ReadOnlyFileStats> {
          if (p === '/virtual') {
            return {
              size: 0,
              mtimeMs: 0,
              birthtimeMs: 0,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false
            }
          }
          lstatCount++
          return initialStats
        },
        async realpath(p: string): Promise<string> {
          return p
        },
        async open(): Promise<ReadOnlyFileHandle> {
          return {
            async stat(): Promise<ReadOnlyFileStats> {
              return openedStats
            },
            async read(): Promise<{ bytesRead: number }> {
              return { bytesRead: 0 }
            },
            async close(): Promise<void> {
              closed = true
            }
          }
        }
      }

      const result = await hashFile({
        filePath: '/virtual/changed-before-open.txt',
        approvedRoots: ['/virtual'],
        fsAdapter: mockAdapter
      })

      expect(result.status).toBe('file_changed')
      if (result.status === 'file_changed') {
        expect(result.reason).toBe('size_modified_during_read')
      }
      expect(lstatCount).toBe(1)
      expect(closed).toBe(true)
    })

    it('detects dev/ino identity change between lstat and open', async () => {
      let closed = false
      const initialStats: ReadOnlyFileStats = {
        size: 100,
        mtimeMs: 1000,
        birthtimeMs: 500,
        dev: 1,
        ino: 100,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      const replacedStats: ReadOnlyFileStats = {
        size: 100,
        mtimeMs: 1000,
        birthtimeMs: 500,
        dev: 1,
        ino: 200,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat(p): Promise<ReadOnlyFileStats> {
          if (p === '/virtual') {
            return {
              size: 0,
              mtimeMs: 0,
              birthtimeMs: 0,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false
            }
          }
          return initialStats
        },
        async realpath(p: string): Promise<string> {
          return p
        },
        async open(): Promise<ReadOnlyFileHandle> {
          return {
            async stat(): Promise<ReadOnlyFileStats> {
              return replacedStats
            },
            async read(): Promise<{ bytesRead: number }> {
              return { bytesRead: 0 }
            },
            async close(): Promise<void> {
              closed = true
            }
          }
        }
      }

      const result = await hashFile({
        filePath: '/virtual/replaced-before-open.txt',
        approvedRoots: ['/virtual'],
        fsAdapter: mockAdapter
      })

      expect(result.status).toBe('file_changed')
      if (result.status === 'file_changed') {
        expect(result.reason).toBe('file_replaced_before_open')
      }
      expect(closed).toBe(true)
    })
  })

  describe('Post-read pathname revalidation', () => {
    it('detects unchanged descriptor whose pathname now identifies a different file', async () => {
      let readDone = false
      let closed = false

      // Descriptor keeps old inode 100
      const descriptorStat: ReadOnlyFileStats = {
        size: 100,
        mtimeMs: 1000,
        birthtimeMs: 500,
        dev: 1,
        ino: 100,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      // After reading, lstat on pathname returns new inode 999 (replaced file!)
      const replacedPathStat: ReadOnlyFileStats = {
        size: 100,
        mtimeMs: 1000,
        birthtimeMs: 500,
        dev: 1,
        ino: 999,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat(p): Promise<ReadOnlyFileStats> {
          if (p === '/virtual') {
            return {
              size: 0,
              mtimeMs: 0,
              birthtimeMs: 0,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false
            }
          }
          return readDone ? replacedPathStat : descriptorStat
        },
        async realpath(p: string): Promise<string> {
          return p
        },
        async open(): Promise<ReadOnlyFileHandle> {
          return {
            async stat(): Promise<ReadOnlyFileStats> {
              return descriptorStat
            },
            async read(buf, offset): Promise<{ bytesRead: number }> {
              if (readDone) return { bytesRead: 0 }
              readDone = true
              buf.fill(0, offset, offset + 100)
              return { bytesRead: 100 }
            },
            async close(): Promise<void> {
              closed = true
            }
          }
        }
      }

      const result = await hashFile({
        filePath: '/virtual/inode-swapped.txt',
        approvedRoots: ['/virtual'],
        fsAdapter: mockAdapter
      })

      expect(result.status).toBe('file_changed')
      if (result.status === 'file_changed') {
        expect(result.reason).toBe('file_replaced_during_read')
      }
      expect('sha256' in result).toBe(false)
      expect(closed).toBe(true)
    })

    it('detects pathname disappearance after reading', async () => {
      let readDone = false
      let closed = false

      const stat: ReadOnlyFileStats = {
        size: 50,
        mtimeMs: 1000,
        birthtimeMs: 500,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat(p): Promise<ReadOnlyFileStats> {
          if (p === '/virtual') {
            return {
              size: 0,
              mtimeMs: 0,
              birthtimeMs: 0,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false
            }
          }
          if (readDone) {
            const err = new Error('ENOENT: no such file or directory') as Error & { code: string }
            err.code = 'ENOENT'
            throw err
          }
          return stat
        },
        async realpath(p: string): Promise<string> {
          return p
        },
        async open(): Promise<ReadOnlyFileHandle> {
          return {
            async stat(): Promise<ReadOnlyFileStats> {
              return stat
            },
            async read(buf, offset): Promise<{ bytesRead: number }> {
              if (readDone) return { bytesRead: 0 }
              readDone = true
              buf.fill(0, offset, offset + 50)
              return { bytesRead: 50 }
            },
            async close(): Promise<void> {
              closed = true
            }
          }
        }
      }

      const result = await hashFile({
        filePath: '/virtual/disappeared.txt',
        approvedRoots: ['/virtual'],
        fsAdapter: mockAdapter
      })

      expect(result.status).toBe('file_changed')
      if (result.status === 'file_changed') {
        expect(result.reason).toBe('file_replaced_during_read')
      }
      expect('sha256' in result).toBe(false)
      expect(closed).toBe(true)
    })

    it('detects pathname link substitution after reading', async () => {
      let readDone = false
      let closed = false

      const regularStat: ReadOnlyFileStats = {
        size: 50,
        mtimeMs: 1000,
        birthtimeMs: 500,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      const symlinkStat: ReadOnlyFileStats = {
        size: 50,
        mtimeMs: 1000,
        birthtimeMs: 500,
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => true
      }

      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat(p): Promise<ReadOnlyFileStats> {
          if (p === '/virtual') {
            return {
              size: 0,
              mtimeMs: 0,
              birthtimeMs: 0,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false
            }
          }
          return readDone ? symlinkStat : regularStat
        },
        async realpath(p: string): Promise<string> {
          return p
        },
        async open(): Promise<ReadOnlyFileHandle> {
          return {
            async stat(): Promise<ReadOnlyFileStats> {
              return regularStat
            },
            async read(buf, offset): Promise<{ bytesRead: number }> {
              if (readDone) return { bytesRead: 0 }
              readDone = true
              buf.fill(0, offset, offset + 50)
              return { bytesRead: 50 }
            },
            async close(): Promise<void> {
              closed = true
            }
          }
        }
      }

      const result = await hashFile({
        filePath: '/virtual/link-substituted.txt',
        approvedRoots: ['/virtual'],
        fsAdapter: mockAdapter
      })

      expect(result.status).toBe('file_changed')
      if (result.status === 'file_changed') {
        expect(result.reason).toBe('file_replaced_during_read')
      }
      expect('sha256' in result).toBe(false)
      expect(closed).toBe(true)
    })
  })

  describe('AbortSignal cancellation and deterministic resource cleanup', () => {
    it('cancels immediately if signal is already aborted before open', async () => {
      let openCalled = false
      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat(p): Promise<ReadOnlyFileStats> {
          if (p === '/virtual') {
            return {
              size: 0,
              mtimeMs: 0,
              birthtimeMs: 0,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false
            }
          }
          return {
            size: 100,
            mtimeMs: 100,
            birthtimeMs: 100,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false
          }
        },
        async realpath(p: string): Promise<string> {
          return p
        },
        async open(): Promise<ReadOnlyFileHandle> {
          openCalled = true
          throw new Error('should not be called')
        }
      }

      const controller = new AbortController()
      controller.abort()

      const result = await hashFile({
        filePath: '/virtual/cancelled.txt',
        approvedRoots: ['/virtual'],
        signal: controller.signal,
        fsAdapter: mockAdapter
      })

      expect(result.status).toBe('cancelled')
      expect(openCalled).toBe(false)
      expect('sha256' in result).toBe(false)
    })

    it('cancels mid-stream during chunk reading and releases open handle', async () => {
      let handleClosed = false
      const controller = new AbortController()
      let readIterations = 0

      const fakeStats: ReadOnlyFileStats = {
        size: 100_000,
        mtimeMs: 1000,
        birthtimeMs: 500,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      const mockHandle: ReadOnlyFileHandle = {
        async stat(): Promise<ReadOnlyFileStats> {
          return fakeStats
        },
        async read(buffer, offset): Promise<{ bytesRead: number }> {
          readIterations++
          buffer.fill(99, offset, offset + 1024)
          if (readIterations === 2) {
            controller.abort()
          }
          return { bytesRead: 1024 }
        },
        async close(): Promise<void> {
          handleClosed = true
        }
      }

      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat(p): Promise<ReadOnlyFileStats> {
          if (p === '/virtual') {
            return {
              size: 0,
              mtimeMs: 0,
              birthtimeMs: 0,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false
            }
          }
          return fakeStats
        },
        async realpath(p: string): Promise<string> {
          return p
        },
        async open(): Promise<ReadOnlyFileHandle> {
          return mockHandle
        }
      }

      const result = await hashFile({
        filePath: '/virtual/abort-stream.txt',
        approvedRoots: ['/virtual'],
        limits: { chunkSizeBytes: 1024 },
        signal: controller.signal,
        fsAdapter: mockAdapter
      })

      expect(result.status).toBe('cancelled')
      expect(handleClosed).toBe(true)
      expect('sha256' in result).toBe(false)
    })
  })

  describe('Handle close failures and error handling', () => {
    it('returns typed error without digest when processing succeeds but handle.close() throws', async () => {
      const fakeStats: ReadOnlyFileStats = {
        size: 100,
        mtimeMs: 1000,
        birthtimeMs: 500,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      let readDone = false
      const mockHandle: ReadOnlyFileHandle = {
        async stat(): Promise<ReadOnlyFileStats> {
          return fakeStats
        },
        async read(buf, offset): Promise<{ bytesRead: number }> {
          if (readDone) return { bytesRead: 0 }
          readDone = true
          buf.fill(1, offset, offset + 100)
          return { bytesRead: 100 }
        },
        async close(): Promise<void> {
          const err = new Error('EIO: failed to close file descriptor') as Error & { code: string }
          err.code = 'EIO'
          throw err
        }
      }

      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat(p): Promise<ReadOnlyFileStats> {
          if (p === '/virtual') {
            return {
              size: 0,
              mtimeMs: 0,
              birthtimeMs: 0,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false
            }
          }
          return fakeStats
        },
        async realpath(p: string): Promise<string> {
          return p
        },
        async open(): Promise<ReadOnlyFileHandle> {
          return mockHandle
        }
      }

      const result = await hashFile({
        filePath: '/virtual/close-fail.txt',
        approvedRoots: ['/virtual'],
        fsAdapter: mockAdapter
      })

      // Must NOT return success with a digest!
      expect(result.status).toBe('error')
      if (result.status === 'error') {
        expect(result.code).toBe('io_error')
        expect(result.message).toContain('failed to close file descriptor')
      }
      expect('sha256' in result).toBe(false)
    })

    it('preserves primary read error when both processing and cleanup fail', async () => {
      const fakeStats: ReadOnlyFileStats = {
        size: 10_000,
        mtimeMs: 1000,
        birthtimeMs: 500,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      const mockHandle: ReadOnlyFileHandle = {
        async stat(): Promise<ReadOnlyFileStats> {
          return fakeStats
        },
        async read(): Promise<{ bytesRead: number }> {
          const readErr = new Error('Primary read failed') as Error & { code: string }
          readErr.code = 'EIO'
          throw readErr
        },
        async close(): Promise<void> {
          const closeErr = new Error('Secondary close failed') as Error & { code: string }
          closeErr.code = 'EBADF'
          throw closeErr
        }
      }

      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat(p): Promise<ReadOnlyFileStats> {
          if (p === '/virtual') {
            return {
              size: 0,
              mtimeMs: 0,
              birthtimeMs: 0,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false
            }
          }
          return fakeStats
        },
        async realpath(p: string): Promise<string> {
          return p
        },
        async open(): Promise<ReadOnlyFileHandle> {
          return mockHandle
        }
      }

      const result = await hashFile({
        filePath: '/virtual/both-fail.txt',
        approvedRoots: ['/virtual'],
        fsAdapter: mockAdapter
      })

      expect(result.status).toBe('error')
      if (result.status === 'error') {
        // Primary error message preserved, not masked by close error
        expect(result.message).toContain('Primary read failed')
      }
    })

    it('preserves primary file_changed outcome when instability is detected and handle.close() throws', async () => {
      let readDone = false
      const stat1: ReadOnlyFileStats = {
        size: 100,
        mtimeMs: 1000,
        birthtimeMs: 500,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }
      const stat2: ReadOnlyFileStats = {
        size: 150, // modified!
        mtimeMs: 2000,
        birthtimeMs: 500,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }

      const mockHandle: ReadOnlyFileHandle = {
        async stat(): Promise<ReadOnlyFileStats> {
          return readDone ? stat2 : stat1
        },
        async read(buf, offset): Promise<{ bytesRead: number }> {
          if (readDone) return { bytesRead: 0 }
          readDone = true
          buf.fill(0, offset, offset + 100)
          return { bytesRead: 100 }
        },
        async close(): Promise<void> {
          throw new Error('EIO on close')
        }
      }

      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat(p): Promise<ReadOnlyFileStats> {
          if (p === '/virtual') {
            return {
              size: 0,
              mtimeMs: 0,
              birthtimeMs: 0,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false
            }
          }
          return stat1
        },
        async realpath(p: string): Promise<string> {
          return p
        },
        async open(): Promise<ReadOnlyFileHandle> {
          return mockHandle
        }
      }

      const result = await hashFile({
        filePath: '/virtual/unstable-and-close-fail.txt',
        approvedRoots: ['/virtual'],
        fsAdapter: mockAdapter
      })

      expect(result.status).toBe('file_changed')
      if (result.status === 'file_changed') {
        expect(result.reason).toBe('size_modified_during_read')
      }
      expect('sha256' in result).toBe(false)
    })

    it('returns file_not_found for missing file', async () => {
      const missingPath = join(tempDir, 'non-existent-file.txt')
      const result = await hashFile({
        filePath: missingPath,
        approvedRoots: [tempDir]
      })

      expect(result.status).toBe('error')
      if (result.status === 'error') {
        expect(result.code).toBe('file_not_found')
        expect(result.errno).toBe('ENOENT')
      }
    })

    it('returns permission_denied when filesystem reports EACCES or EPERM', async () => {
      const mockAdapter: ReadOnlyHashingFsAdapter = {
        async lstat(p): Promise<ReadOnlyFileStats> {
          if (p === '/virtual') {
            return {
              size: 0,
              mtimeMs: 0,
              birthtimeMs: 0,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false
            }
          }
          const err = new Error('Permission denied') as Error & { code: string }
          err.code = 'EACCES'
          throw err
        },
        async realpath(p: string): Promise<string> {
          return p
        },
        async open(): Promise<ReadOnlyFileHandle> {
          throw new Error('should not be called')
        }
      }

      const result = await hashFile({
        filePath: '/virtual/locked.txt',
        approvedRoots: ['/virtual'],
        fsAdapter: mockAdapter
      })

      expect(result.status).toBe('error')
      if (result.status === 'error') {
        expect(result.code).toBe('permission_denied')
        expect(result.errno).toBe('EACCES')
      }
    })
  })

  describe('createNodeReadOnlyHashingFsAdapter', () => {
    it('is frozen and returns frozen handles with only read-only methods', async () => {
      const adapter = createNodeReadOnlyHashingFsAdapter()
      expect(Object.isFrozen(adapter)).toBe(true)

      const filePath = join(tempDir, 'adapter-test.txt')
      await fs.writeFile(filePath, 'read-only adapter test')

      const stats = await adapter.lstat(filePath)
      expect(stats.isFile()).toBe(true)
      expect(stats.isDirectory()).toBe(false)
      expect(stats.isSymbolicLink()).toBe(false)
      expect(stats.size).toBe(22)

      const real = await adapter.realpath(filePath)
      expect(typeof real).toBe('string')

      const handle = await adapter.open(filePath)
      expect(Object.isFrozen(handle)).toBe(true)

      // Verify no mutation methods exist on handle
      expect('write' in handle).toBe(false)
      expect('truncate' in handle).toBe(false)
      expect('chmod' in handle).toBe(false)

      const handleStats = await handle.stat()
      expect(handleStats.size).toBe(22)

      const buffer = Buffer.alloc(32)
      const readRes = await handle.read(buffer, 0, 32, null)
      expect(readRes.bytesRead).toBe(22)

      await handle.close()
      // Calling close again should be idempotent and not throw
      await expect(handle.close()).resolves.toBeUndefined()
    })
  })
})
