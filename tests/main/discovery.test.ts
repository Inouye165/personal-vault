// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BoundedFifoQueue,
  createNodeReadOnlyFsAdapter,
  discoverFiles,
  isInsideApprovedRoot,
  scanSourceRoots,
  type DiscoveredCandidate,
  type DiscoveryEvent,
  type ReadOnlyDirEntry,
  type ReadOnlyDirHandle,
  type ReadOnlyFsAdapter,
  type ReadOnlyFsStats
} from '../../src/main/services/discovery'

function makeDirent(name: string, kind: 'file' | 'dir' | 'symlink' | 'other'): ReadOnlyDirEntry {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'symlink'
  }
}

function makeStats(
  kind: 'file' | 'dir' | 'symlink' | 'other',
  size = 100,
  birthtimeMs = 1700000000000,
  mtimeMs = 1700000060000
): ReadOnlyFsStats {
  return {
    size,
    birthtimeMs,
    mtimeMs,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'symlink'
  }
}

function probeRealJunctionSupport(): boolean {
  const probeRoot = mkdtempSync(join(tmpdir(), 'pv-junction-probe-'))
  try {
    const target = join(probeRoot, 'target')
    const link = join(probeRoot, 'link')
    mkdirSync(target)
    symlinkSync(target, link, 'junction')
    return true
  } catch {
    return false
  } finally {
    rmSync(probeRoot, { recursive: true, force: true })
  }
}

const canCreateRealJunction = probeRealJunctionSupport()

describe('Stage 2A: Read-only discovery service', () => {
  let fixtureRoot: string

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'pv-stage2a-'))
  })

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true })
  })

  describe('1. Nested discovery of photo and document candidates & Markdown/text inclusion', () => {
    it('discovers nested photo and document candidates, includes .md and .txt, and skips unsupported extensions', async () => {
      const rootA = join(fixtureRoot, 'source-a')
      const rootB = join(fixtureRoot, 'source-b')
      await mkdir(join(rootA, '2024', 'trip'), { recursive: true })
      await mkdir(join(rootB, 'docs'), { recursive: true })

      const photoJpg = join(rootA, '2024', 'trip', 'IMG_0001.JPG')
      const photoHeic = join(rootA, '2024', 'trip', 'portrait.heic')
      const notesMd = join(rootA, '2024', 'trip', 'travel-notes.md')
      const readmeMd = join(rootA, 'README.md')
      const recipeTxt = join(rootB, 'docs', 'grandma-recipe.txt')
      const invoicePdf = join(rootB, 'docs', 'invoice.pdf')
      const binaryExe = join(rootB, 'docs', 'installer.exe')

      await writeFile(photoJpg, 'fake-jpeg-bytes')
      await writeFile(photoHeic, 'fake-heic-bytes-12345')
      await writeFile(notesMd, '# Trip Notes\nVisited Kyoto.')
      await writeFile(readmeMd, '# Family Archive\nOverview of folders.')
      await writeFile(recipeTxt, 'Flour, water, salt, yeast.')
      await writeFile(invoicePdf, '%PDF-1.7 fake')
      await writeFile(binaryExe, 'MZ-binary')

      const streamed: DiscoveredCandidate[] = []
      const result = await discoverFiles({
        roots: [rootA, rootB],
        onCandidate: (candidate) => {
          streamed.push(candidate)
        }
      })

      expect(result.status).toBe('completed')
      expect(result.errors).toEqual([])
      expect(streamed).toEqual(result.candidates)

      const byName = new Map(result.candidates.map((c) => [c.fileName, c]))
      expect(result.candidates).toHaveLength(6)

      const jpg = byName.get('IMG_0001.JPG')
      expect(jpg).toMatchObject({
        rootPath: rootA,
        absolutePath: photoJpg,
        fileName: 'IMG_0001.JPG',
        extension: '.jpg',
        candidateKind: 'photo',
        byteSize: 15
      })
      expect(jpg?.filesystemModifiedAt).toEqual(expect.any(String))

      expect(byName.get('portrait.heic')?.candidateKind).toBe('photo')
      expect(byName.get('travel-notes.md')).toMatchObject({
        extension: '.md',
        candidateKind: 'document'
      })
      expect(byName.get('README.md')).toMatchObject({
        extension: '.md',
        candidateKind: 'document'
      })
      expect(byName.get('grandma-recipe.txt')).toMatchObject({
        extension: '.txt',
        candidateKind: 'document'
      })
      expect(byName.get('invoice.pdf')).toMatchObject({
        extension: '.pdf',
        candidateKind: 'document'
      })

      expect(result.skips).toContainEqual(
        expect.objectContaining({
          path: binaryExe,
          reason: 'unsupported_extension'
        })
      )
    })

    it('supports custom configurable photo and document extension policies', async () => {
      const root = join(fixtureRoot, 'custom-ext')
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'raw.jxl'), 'jpeg-xl')
      await writeFile(join(root, 'notes.org'), '* Headline')
      await writeFile(join(root, 'ignored.jpg'), 'jpg')

      const result = await discoverFiles({
        roots: [root],
        policy: {
          photoExtensions: ['.jxl'],
          documentExtensions: ['org']
        }
      })

      expect(result.candidates.map((c) => [c.fileName, c.candidateKind])).toEqual([
        ['notes.org', 'document'],
        ['raw.jxl', 'photo']
      ])
      expect(result.skips).toContainEqual(
        expect.objectContaining({
          path: join(root, 'ignored.jpg'),
          reason: 'unsupported_extension'
        })
      )
    })
  })

  describe('2. Explicit exclusions, source-root exclusions, and software-clutter rules', () => {
    it('skips explicit excluded directories, software clutter directories, hidden/system entries, and clutter files with testable reasons', async () => {
      const root = join(fixtureRoot, 'mixed-source')
      const explicitExcludedDir = join(root, 'private-archive')
      const namedExcludedDir = join(root, 'temp-exports')
      const nodeModulesDir = join(root, 'project', 'node_modules', 'pkg')
      const gitDir = join(root, 'project', '.git')
      const hiddenDir = join(root, '.Trash-1000')
      const synologyDir = join(root, '@eaDir')
      const validProjectDocsDir = join(root, 'project', 'specs')

      await mkdir(explicitExcludedDir, { recursive: true })
      await mkdir(namedExcludedDir, { recursive: true })
      await mkdir(nodeModulesDir, { recursive: true })
      await mkdir(gitDir, { recursive: true })
      await mkdir(hiddenDir, { recursive: true })
      await mkdir(synologyDir, { recursive: true })
      await mkdir(validProjectDocsDir, { recursive: true })

      await writeFile(join(explicitExcludedDir, 'secret.pdf'), 'secret')
      await writeFile(join(namedExcludedDir, 'export.jpg'), 'export')
      await writeFile(join(nodeModulesDir, 'README.md'), 'pkg readme')
      await writeFile(join(gitDir, 'description.txt'), 'git description')
      await writeFile(join(hiddenDir, 'deleted.jpg'), 'trash')
      await writeFile(join(synologyDir, 'thumb.jpg'), 'synology thumb')

      const dsStore = join(root, '.DS_Store')
      const thumbsDb = join(root, 'Thumbs.db')
      const cmakeFile = join(root, 'project', 'CMakeLists.txt')
      const requirementsFile = join(root, 'project', 'requirements.txt')
      const changelogFile = join(root, 'project', 'CHANGELOG.md')

      await writeFile(dsStore, 'ds')
      await writeFile(thumbsDb, 'thumbs')
      await writeFile(cmakeFile, 'cmake_minimum_required(VERSION 3.20)')
      await writeFile(requirementsFile, 'pytest==8.0.0')
      await writeFile(changelogFile, '# Changelog')

      const architectureMd = join(validProjectDocsDir, 'design-notes.md')
      const meetingTxt = join(validProjectDocsDir, 'meeting-minutes.txt')
      const whiteboardPng = join(validProjectDocsDir, 'whiteboard.png')
      await writeFile(architectureMd, '# Design Notes')
      await writeFile(meetingTxt, 'Action items')
      await writeFile(whiteboardPng, 'png-bytes')

      const result = await discoverFiles({
        roots: [root],
        policy: {
          excludedPaths: [explicitExcludedDir],
          excludedDirectoryNames: ['temp-exports']
        }
      })

      expect(result.candidates.map((c) => c.fileName).sort()).toEqual([
        'design-notes.md',
        'meeting-minutes.txt',
        'whiteboard.png'
      ])

      const skipMap = new Map(result.skips.map((s) => [s.path, s]))
      expect(skipMap.get(explicitExcludedDir)?.reason).toBe('excluded_directory')
      expect(skipMap.get(namedExcludedDir)?.reason).toBe('excluded_directory')
      expect(skipMap.get(join(root, 'project', 'node_modules'))?.reason).toBe(
        'software_clutter_directory'
      )
      expect(skipMap.get(gitDir)?.reason).toBe('software_clutter_directory')
      expect(skipMap.get(hiddenDir)?.reason).toBe('hidden_or_system_entry')
      expect(skipMap.get(synologyDir)?.reason).toBe('hidden_or_system_entry')
      expect(skipMap.get(dsStore)?.reason).toBe('hidden_or_system_entry')
      expect(skipMap.get(thumbsDb)?.reason).toBe('hidden_or_system_entry')
      expect(skipMap.get(cmakeFile)?.reason).toBe('software_clutter_file')
      expect(skipMap.get(requirementsFile)?.reason).toBe('software_clutter_file')
      expect(skipMap.get(changelogFile)?.reason).toBe('software_clutter_file')
    })

    it('applies explicit path exclusions to source roots and roots nested under an excluded ancestor without opening them', async () => {
      const excludedRoot = join(fixtureRoot, 'excluded-root')
      const excludedAncestor = join(fixtureRoot, 'excluded-ancestor')
      const nestedUnderExcluded = join(excludedAncestor, '2025', 'photos')
      const openedDirs: string[] = []

      const fakeAdapter: ReadOnlyFsAdapter = {
        realpath: async (p) => p,
        lstat: async () => makeStats('dir'),
        opendir: async (p) => {
          openedDirs.push(p)
          return { read: async () => null, close: async () => {} }
        }
      }

      const result = await discoverFiles({
        roots: [excludedRoot, nestedUnderExcluded],
        fsAdapter: fakeAdapter,
        policy: {
          excludedPaths: [excludedRoot, excludedAncestor]
        }
      })

      expect(openedDirs).toEqual([])
      expect(result.stats.directoriesVisited).toBe(0)
      expect(result.skips).toEqual([
        expect.objectContaining({
          path: excludedRoot,
          reason: 'excluded_directory'
        }),
        expect.objectContaining({
          path: nestedUnderExcluded,
          reason: 'excluded_directory'
        })
      ])
    })

    it('enforces documented precedence for name-based and default exclusions on source roots while allowing hidden/clutter ancestors above an explicit root', async () => {
      const rootByExcludedName = join(fixtureRoot, 'raw-dumps')
      const rootByClutterName = join(fixtureRoot, 'node_modules')
      const rootByHiddenName = join(fixtureRoot, '.secret-vault')
      const rootInsideHiddenAncestor = join(fixtureRoot, '.local-share', 'build', 'family-photos')
      const openedDirs: string[] = []

      const fakeAdapter: ReadOnlyFsAdapter = {
        realpath: async (p) => p,
        lstat: async (p) => {
          if (p.endsWith('.jpg')) return makeStats('file', 256)
          return makeStats('dir')
        },
        opendir: async (p) => {
          openedDirs.push(p)
          let done = false
          return {
            read: async () => {
              if (done) return null
              done = true
              return makeDirent('kept.jpg', 'file')
            },
            close: async () => {}
          }
        }
      }

      const result = await discoverFiles({
        roots: [rootByExcludedName, rootByClutterName, rootByHiddenName, rootInsideHiddenAncestor],
        fsAdapter: fakeAdapter,
        policy: {
          excludedDirectoryNames: ['raw-dumps']
        }
      })

      // Only the root whose own name is valid (despite hidden/clutter ancestors) is opened
      expect(openedDirs).toEqual([rootInsideHiddenAncestor])
      expect(result.candidates.map((c) => c.fileName)).toEqual(['kept.jpg'])
      expect(result.skips).toEqual([
        expect.objectContaining({
          path: rootByExcludedName,
          reason: 'excluded_directory'
        }),
        expect.objectContaining({
          path: rootByClutterName,
          reason: 'software_clutter_directory'
        }),
        expect.objectContaining({
          path: rootByHiddenName,
          reason: 'hidden_or_system_entry'
        })
      ])
    })
  })

  describe('3. Preservation of source files, timestamps, and honest missing metadata', () => {
    it('exposes only read-only adapter methods and preserves source file bytes, birthtime, and mtime', async () => {
      const adapter = createNodeReadOnlyFsAdapter()
      expect(Object.keys(adapter).sort()).toEqual(['lstat', 'opendir', 'realpath'])
      expect(Object.isFrozen(adapter)).toBe(true)

      const filePath = join(fixtureRoot, 'family-photo.jpg')
      const originalBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
      await writeFile(filePath, originalBytes)

      const fixedAtime = new Date('2021-06-15T10:20:30.000Z')
      const fixedMtime = new Date('2020-03-10T08:15:00.000Z')
      await utimes(filePath, fixedAtime, fixedMtime)

      const beforeStat = await stat(filePath)
      const beforeContent = await readFile(filePath)

      const result = await discoverFiles({ roots: [fixtureRoot] })
      expect(result.candidates).toHaveLength(1)

      const afterStat = await stat(filePath)
      const afterContent = await readFile(filePath)

      expect(afterContent.equals(beforeContent)).toBe(true)
      expect(afterStat.size).toBe(beforeStat.size)
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
      expect(afterStat.birthtimeMs).toBe(beforeStat.birthtimeMs)
      expect(result.candidates[0]?.filesystemModifiedAt).toBe(fixedMtime.toISOString())
    })

    it('represents missing or unreliable creation/modification timestamps as null without fabricating fallbacks', async () => {
      const rootPath = join(fixtureRoot, 'synthetic-root')
      const filePath = join(rootPath, 'scan.jpg')

      const fakeAdapter: ReadOnlyFsAdapter = {
        realpath: async (p) => p,
        lstat: async (p) => {
          if (p === rootPath) return makeStats('dir')
          return makeStats('file', 2048, 0, Date.parse('2023-05-01T12:00:00.000Z'))
        },
        opendir: async (): Promise<ReadOnlyDirHandle> => {
          let read = false
          return {
            read: async () => {
              if (read) return null
              read = true
              return makeDirent('scan.jpg', 'file')
            },
            close: async () => {}
          }
        }
      }

      const result = await discoverFiles({
        roots: [rootPath],
        fsAdapter: fakeAdapter
      })

      expect(result.candidates).toHaveLength(1)
      expect(result.candidates[0]?.filesystemCreatedAt).toBeNull()
      expect(result.candidates[0]?.filesystemModifiedAt).toBe('2023-05-01T12:00:00.000Z')
      expect(result.candidates[0]?.absolutePath).toBe(filePath)
    })
  })

  describe('4. Symbolic links, directory junctions, queued directory revalidation, and approved-root boundaries', () => {
    it.runIf(canCreateRealJunction)(
      'skips real directory junctions both as source roots and as nested entries without traversing outside the root',
      async () => {
        const approvedRoot = join(fixtureRoot, 'approved')
        const outsideRoot = join(fixtureRoot, 'outside-secret')
        await mkdir(approvedRoot, { recursive: true })
        await mkdir(outsideRoot, { recursive: true })

        await writeFile(join(approvedRoot, 'inside.txt'), 'allowed text')
        await writeFile(join(outsideRoot, 'leaked.txt'), 'must not be discovered')

        const nestedJunction = join(approvedRoot, 'linked-outside')
        const rootJunction = join(fixtureRoot, 'root-junction')
        await symlink(outsideRoot, nestedJunction, 'junction')
        await symlink(outsideRoot, rootJunction, 'junction')

        const result = await discoverFiles({
          roots: [approvedRoot, rootJunction]
        })

        expect(result.candidates.map((c) => c.fileName)).toEqual(['inside.txt'])
        expect(result.skips).toContainEqual(
          expect.objectContaining({
            path: nestedJunction,
            reason: 'symbolic_link_or_junction'
          })
        )
        expect(result.skips).toContainEqual(
          expect.objectContaining({
            path: rootJunction,
            reason: 'symbolic_link_or_junction'
          })
        )
      }
    )

    it('deterministically skips symlink/junction roots, file symlinks, non-regular entries, and paths resolving outside the canonical approved root', async () => {
      const root = join(fixtureRoot, 'root')
      const symlinkRoot = join(fixtureRoot, 'symlink-root')
      const escapedDir = join(root, 'escaped-subdir')
      const symlinkFile = join(root, 'shortcut.jpg')
      const fifoEntry = join(root, 'named.pipe')

      const fakeAdapter: ReadOnlyFsAdapter = {
        realpath: async (p) => {
          if (p === escapedDir) return join(fixtureRoot, 'other-place')
          return p
        },
        lstat: async (p) => {
          if (p === symlinkRoot) return makeStats('symlink')
          if (p === root || p === escapedDir) return makeStats('dir')
          if (p === symlinkFile) return makeStats('symlink')
          return makeStats('file')
        },
        opendir: async (p): Promise<ReadOnlyDirHandle> => {
          const entries =
            p === root
              ? [
                  makeDirent('escaped-subdir', 'dir'),
                  makeDirent('shortcut.jpg', 'symlink'),
                  makeDirent('named.pipe', 'other')
                ]
              : [makeDirent('unreachable.pdf', 'file')]
          let idx = 0
          return {
            read: async () => entries[idx++] ?? null,
            close: async () => {}
          }
        }
      }

      const result = await discoverFiles({
        roots: [symlinkRoot, root],
        fsAdapter: fakeAdapter
      })

      expect(result.candidates).toEqual([])
      expect(result.skips).toContainEqual(
        expect.objectContaining({
          path: symlinkRoot,
          reason: 'symbolic_link_or_junction'
        })
      )
      expect(result.skips).toContainEqual(
        expect.objectContaining({
          path: escapedDir,
          reason: 'outside_approved_root'
        })
      )
      expect(result.skips).toContainEqual(
        expect.objectContaining({
          path: symlinkFile,
          reason: 'symbolic_link_or_junction'
        })
      )
      expect(result.skips).toContainEqual(
        expect.objectContaining({
          path: fifoEntry,
          reason: 'non_regular_entry'
        })
      )
    })

    it('revalidates queued directories immediately before opendir and rejects directories replaced after their parent closes', async () => {
      const root = join(fixtureRoot, 'race-root')
      const becameLinkDir = join(root, 'became-link')
      const retargetedOutsideDir = join(root, 'retargeted-outside')
      const becameFileDir = join(root, 'became-file')
      const vanishedDir = join(root, 'vanished-dir')
      const healthyDir = join(root, 'healthy-dir')
      const healthyPhoto = join(healthyDir, 'ok.jpg')

      let parentClosed = false
      const openedDirs: string[] = []
      const errWithCode = (code: string, message: string): NodeJS.ErrnoException =>
        Object.assign(new Error(message), { code })

      const fakeAdapter: ReadOnlyFsAdapter = {
        realpath: async (p) => {
          if (parentClosed && p === retargetedOutsideDir) {
            return join(fixtureRoot, 'external-secret')
          }
          return p
        },
        lstat: async (p) => {
          if (p === root || p === healthyDir) return makeStats('dir')
          if (p === healthyPhoto) return makeStats('file', 321)
          if (!parentClosed) {
            // While parent is open, all subdirectories appear to be normal directories
            return makeStats('dir')
          }
          // After parent closes, destinations mutated while waiting in queue
          if (p === becameLinkDir) return makeStats('symlink')
          if (p === retargetedOutsideDir) return makeStats('dir')
          if (p === becameFileDir) return makeStats('file', 10)
          if (p === vanishedDir) throw errWithCode('ENOENT', 'Directory removed while queued')
          return makeStats('dir')
        },
        opendir: async (p): Promise<ReadOnlyDirHandle> => {
          openedDirs.push(p)
          const entries =
            p === root
              ? [
                  makeDirent('became-link', 'dir'),
                  makeDirent('retargeted-outside', 'dir'),
                  makeDirent('became-file', 'dir'),
                  makeDirent('vanished-dir', 'dir'),
                  makeDirent('healthy-dir', 'dir')
                ]
              : p === healthyDir
                ? [makeDirent('ok.jpg', 'file')]
                : [makeDirent('leaked.pdf', 'file')]
          let idx = 0
          return {
            read: async () => entries[idx++] ?? null,
            close: async () => {
              if (p === root) parentClosed = true
            }
          }
        }
      }

      const result = await discoverFiles({
        roots: [root],
        fsAdapter: fakeAdapter
      })

      // None of the mutated subdirectories may be passed to opendir
      expect(openedDirs).toEqual([root, healthyDir])
      expect(result.candidates.map((c) => c.fileName)).toEqual(['ok.jpg'])
      expect(result.skips).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: becameLinkDir,
            reason: 'symbolic_link_or_junction'
          }),
          expect.objectContaining({
            path: retargetedOutsideDir,
            reason: 'outside_approved_root'
          }),
          expect.objectContaining({
            path: becameFileDir,
            reason: 'non_regular_entry'
          })
        ])
      )
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          path: vanishedDir,
          code: 'entry_disappeared'
        })
      )
    })

    it('checks root containment accurately including directories starting with double dots', () => {
      const root = join(fixtureRoot, 'vault-root')
      expect(isInsideApprovedRoot(root, root)).toBe(true)
      expect(isInsideApprovedRoot(root, join(root, 'photos', 'a.jpg'))).toBe(true)
      expect(isInsideApprovedRoot(root, join(root, '..notes', 'a.md'))).toBe(true)
      expect(isInsideApprovedRoot(root, join(fixtureRoot, 'vault-root-sibling', 'a.jpg'))).toBe(
        false
      )
      expect(isInsideApprovedRoot(root, fixtureRoot)).toBe(false)
    })
  })

  describe('5. Recoverable filesystem errors', () => {
    it('records missing roots, non-directory roots, unreadable directories, disappearing files, and inaccessible files while completing the scan', async () => {
      const validRoot = join(fixtureRoot, 'valid')
      const missingRoot = join(fixtureRoot, 'missing')
      const fileAsRoot = join(fixtureRoot, 'not-a-dir.txt')
      const lockedDir = join(validRoot, 'locked-album')
      const vanishedFile = join(validRoot, 'vanished.jpg')
      const lockedFile = join(validRoot, 'locked.pdf')
      const healthyFile = join(validRoot, 'healthy.md')

      const errWithCode = (code: string, message: string): NodeJS.ErrnoException =>
        Object.assign(new Error(message), { code })

      const fakeAdapter: ReadOnlyFsAdapter = {
        realpath: async (p) => p,
        lstat: async (p) => {
          if (p === missingRoot) throw errWithCode('ENOENT', 'Root does not exist')
          if (p === fileAsRoot) return makeStats('file', 64)
          if (p === validRoot || p === lockedDir) return makeStats('dir')
          if (p === vanishedFile) throw errWithCode('ENOENT', 'File disappeared')
          if (p === lockedFile) throw errWithCode('EACCES', 'Permission denied on file')
          if (p === healthyFile) return makeStats('file', 512)
          throw errWithCode('ENOENT', 'Unknown path')
        },
        opendir: async (p): Promise<ReadOnlyDirHandle> => {
          if (p === lockedDir) throw errWithCode('EACCES', 'Cannot read directory')
          const entries = [
            makeDirent('locked-album', 'dir'),
            makeDirent('vanished.jpg', 'file'),
            makeDirent('locked.pdf', 'file'),
            makeDirent('healthy.md', 'file')
          ]
          let idx = 0
          return {
            read: async () => entries[idx++] ?? null,
            close: async () => {}
          }
        }
      }

      const result = await discoverFiles({
        roots: [missingRoot, fileAsRoot, validRoot],
        fsAdapter: fakeAdapter
      })

      expect(result.status).toBe('completed')
      expect(result.candidates.map((c) => c.fileName)).toEqual(['healthy.md'])
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: missingRoot, code: 'root_not_found' }),
          expect.objectContaining({ path: fileAsRoot, code: 'root_not_directory' }),
          expect.objectContaining({ path: lockedDir, code: 'permission_denied' }),
          expect.objectContaining({ path: vanishedFile, code: 'entry_disappeared' }),
          expect.objectContaining({ path: lockedFile, code: 'permission_denied' })
        ])
      )
    })
  })

  describe('6. Cancellation and resource cleanup', () => {
    it('stops promptly when AbortSignal fires mid-traversal and closes all open directory handles', async () => {
      const root = join(fixtureRoot, 'cancel-root')
      const controller = new AbortController()
      let openHandles = 0
      let closedHandles = 0
      let maxConcurrentHandles = 0

      const fakeAdapter: ReadOnlyFsAdapter = {
        realpath: async (p) => p,
        lstat: async (p) => {
          if (p === root || p.endsWith('subdir')) return makeStats('dir')
          return makeStats('file', 128)
        },
        opendir: async (p): Promise<ReadOnlyDirHandle> => {
          openHandles++
          maxConcurrentHandles = Math.max(maxConcurrentHandles, openHandles - closedHandles)
          const entries =
            p === root
              ? [
                  makeDirent('first.jpg', 'file'),
                  makeDirent('second.jpg', 'file'),
                  makeDirent('subdir', 'dir'),
                  makeDirent('third.jpg', 'file')
                ]
              : [makeDirent('nested.pdf', 'file')]
          let idx = 0
          return {
            read: async () => {
              const item = entries[idx++] ?? null
              if (item?.name === 'second.jpg') {
                controller.abort()
              }
              return item
            },
            close: async () => {
              closedHandles++
            }
          }
        }
      }

      const result = await discoverFiles({
        roots: [root],
        fsAdapter: fakeAdapter,
        signal: controller.signal
      })

      expect(result.status).toBe('cancelled')
      expect(result.candidates.map((c) => c.fileName)).toEqual(['first.jpg'])
      expect(openHandles).toBe(1)
      expect(closedHandles).toBe(1)
      expect(maxConcurrentHandles).toBe(1)
    })

    it('returns cancelled immediately when given an already-aborted signal without opening handles', async () => {
      const controller = new AbortController()
      controller.abort()
      let opened = 0

      const fakeAdapter: ReadOnlyFsAdapter = {
        realpath: async (p) => p,
        lstat: async () => makeStats('dir'),
        opendir: async () => {
          opened++
          return { read: async () => null, close: async () => {} }
        }
      }

      const result = await discoverFiles({
        roots: [join(fixtureRoot, 'any')],
        fsAdapter: fakeAdapter,
        signal: controller.signal
      })

      expect(result.status).toBe('cancelled')
      expect(result.stats.directoriesVisited).toBe(0)
      expect(opened).toBe(0)
    })
  })

  describe('7. Incremental streaming, backpressure, O(1) queue, and bounded resource limits', () => {
    it('delivers events before traversal finishes and enforces backpressure so a slow consumer prevents read-ahead', async () => {
      const root = join(fixtureRoot, 'stream-root')
      const subA = join(root, 'sub-a')
      const subB = join(root, 'sub-b')
      const openedDirs: string[] = []
      let closedDirs = 0

      const fakeAdapter: ReadOnlyFsAdapter = {
        realpath: async (p) => p,
        lstat: async (p) => {
          if (p === root || p === subA || p === subB) return makeStats('dir')
          return makeStats('file', 100)
        },
        opendir: async (p): Promise<ReadOnlyDirHandle> => {
          openedDirs.push(p)
          const entries =
            p === root
              ? [
                  makeDirent('root-1.jpg', 'file'),
                  makeDirent('sub-a', 'dir'),
                  makeDirent('sub-b', 'dir')
                ]
              : p === subA
                ? [makeDirent('a-1.pdf', 'file'), makeDirent('a-2.xyz', 'file')]
                : [makeDirent('b-1.md', 'file')]
          let idx = 0
          return {
            read: async () => entries[idx++] ?? null,
            close: async () => {
              closedDirs++
            }
          }
        }
      }

      const stream = scanSourceRoots({
        roots: [root],
        fsAdapter: fakeAdapter
      })

      // Pull the very first event (root-1.jpg): sub-a and sub-b must NOT have been opened yet
      const firstStep = await stream.next()
      expect(firstStep.done).toBe(false)
      expect(firstStep.value).toMatchObject({
        kind: 'candidate',
        candidate: expect.objectContaining({ fileName: 'root-1.jpg' })
      })
      expect(openedDirs).toEqual([root])

      // Pull the second event (a-1.pdf inside sub-a): sub-b still must NOT be opened yet
      const secondStep = await stream.next()
      expect(secondStep.done).toBe(false)
      expect(secondStep.value).toMatchObject({
        kind: 'candidate',
        candidate: expect.objectContaining({ fileName: 'a-1.pdf' })
      })
      expect(openedDirs).toEqual([root, subA])

      // Pull remaining events and verify summary return value
      const remainingEvents: DiscoveryEvent[] = []
      while (true) {
        const next = await stream.next()
        if (next.done) {
          expect(next.value).toEqual({
            status: 'completed',
            stats: {
              rootsRequested: 1,
              directoriesVisited: 3,
              candidatesFound: 3,
              skippedCount: 1,
              errorCount: 0
            }
          })
          break
        }
        remainingEvents.push(next.value)
      }

      expect(remainingEvents.map((e) => e.kind)).toEqual(['skip', 'candidate'])
      expect(openedDirs).toEqual([root, subA, subB])
      expect(closedDirs).toBe(3)
    })

    it('reports resource_limit_reached when pending directory frontier exceeds maxPendingDirectories and closes handles', async () => {
      const root = join(fixtureRoot, 'wide-root')
      let closed = 0

      const fakeAdapter: ReadOnlyFsAdapter = {
        realpath: async (p) => p,
        lstat: async () => makeStats('dir'),
        opendir: async (p): Promise<ReadOnlyDirHandle> => {
          const entries =
            p === root
              ? [makeDirent('dir-1', 'dir'), makeDirent('dir-2', 'dir'), makeDirent('dir-3', 'dir')]
              : []
          let idx = 0
          return {
            read: async () => entries[idx++] ?? null,
            close: async () => {
              closed++
            }
          }
        }
      }

      const result = await discoverFiles({
        roots: [root],
        fsAdapter: fakeAdapter,
        limits: { maxPendingDirectories: 2 }
      })

      expect(result.status).toBe('resource_limit_reached')
      expect(result.limitReached).toMatchObject({
        limit: 'maxPendingDirectories',
        maxAllowed: 2
      })
      expect(closed).toBe(1)
    })

    it('reports resource_limit_reached when visited directories exceed maxVisitedDirectories', async () => {
      const root = join(fixtureRoot, 'deep-root')
      let closed = 0

      const fakeAdapter: ReadOnlyFsAdapter = {
        realpath: async (p) => p,
        lstat: async () => makeStats('dir'),
        opendir: async (p): Promise<ReadOnlyDirHandle> => {
          const entries = p === root ? [makeDirent('sub-1', 'dir'), makeDirent('sub-2', 'dir')] : []
          let idx = 0
          return {
            read: async () => entries[idx++] ?? null,
            close: async () => {
              closed++
            }
          }
        }
      }

      const result = await discoverFiles({
        roots: [root],
        fsAdapter: fakeAdapter,
        limits: { maxVisitedDirectories: 2 }
      })

      expect(result.status).toBe('resource_limit_reached')
      expect(result.limitReached).toMatchObject({
        limit: 'maxVisitedDirectories',
        maxAllowed: 2
      })
      expect(result.stats.directoriesVisited).toBe(2)
      expect(closed).toBe(2)
    })

    it('reports resource_limit_reached when discoverFiles exceeds maxCollectedRecords while keeping accurate stats', async () => {
      const root = join(fixtureRoot, 'many-files')
      let closed = 0

      const fakeAdapter: ReadOnlyFsAdapter = {
        realpath: async (p) => p,
        lstat: async (p) => (p === root ? makeStats('dir') : makeStats('file', 10)),
        opendir: async (): Promise<ReadOnlyDirHandle> => {
          const entries = [
            makeDirent('1.jpg', 'file'),
            makeDirent('2.jpg', 'file'),
            makeDirent('3.jpg', 'file')
          ]
          let idx = 0
          return {
            read: async () => entries[idx++] ?? null,
            close: async () => {
              closed++
            }
          }
        }
      }

      const result = await discoverFiles({
        roots: [root],
        fsAdapter: fakeAdapter,
        limits: { maxCollectedRecords: 2 }
      })

      expect(result.status).toBe('resource_limit_reached')
      expect(result.limitReached).toMatchObject({
        limit: 'maxCollectedRecords',
        maxAllowed: 2,
        observed: 3
      })
      expect(result.candidates).toHaveLength(2)
      expect(result.stats.directoriesVisited).toBe(1)
      expect(result.stats.candidatesFound).toBe(3)
      expect(closed).toBe(1)
    })

    it('provides an O(1) FIFO queue without array shift', () => {
      const queue = new BoundedFifoQueue<number>(3)
      expect(queue.enqueue(10)).toBe(true)
      expect(queue.enqueue(20)).toBe(true)
      expect(queue.enqueue(30)).toBe(true)
      expect(queue.enqueue(40)).toBe(false)
      expect(queue.size).toBe(3)
      expect(queue.dequeue()).toBe(10)
      expect(queue.dequeue()).toBe(20)
      expect(queue.enqueue(50)).toBe(true)
      expect(queue.dequeue()).toBe(30)
      expect(queue.dequeue()).toBe(50)
      expect(queue.dequeue()).toBeUndefined()
      expect(queue.size).toBe(0)
    })
  })
})
