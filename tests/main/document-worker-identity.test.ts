/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAndVerifySource } from '../../src/main/services/documents/worker'

describe('Document Worker Source Pathname Identity (Stage 7B)', () => {
  it('rejects extraction when the pathname is replaced between open and final lstat even if canonical path and regular-file status match', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pv-doc-worker-id-'))
    try {
      const docsDir = join(tempDir, 'docs')
      mkdirSync(docsDir, { recursive: true })
      const originalFile = join(docsDir, 'doc.txt')
      const replacementFile = join(docsDir, 'replacement.txt')
      writeFileSync(originalFile, 'original content')
      writeFileSync(replacementFile, 'replacement content')

      const origStat = await lstat(originalFile)
      let lstatCount = 0

      const res = await readAndVerifySource(
        {
          id: 1,
          action: 'extract_document',
          sourcePath: originalFile,
          approvedRoots: [docsDir],
          extension: '.txt',
          expectedByteSize: origStat.size,
          expectedMtimeMs: origStat.mtimeMs,
          expectedSha256: null
        },
        {
          lstat: (async (p: Parameters<typeof lstat>[0], opts: Parameters<typeof lstat>[1]) => {
            lstatCount++
            // First lstat (pre-open) sees originalFile; final lstat (post-read) sees replacementFile at the same pathname
            if (lstatCount >= 2 && p === originalFile) {
              return lstat(replacementFile, opts)
            }
            return lstat(p, opts)
          }) as typeof lstat,
          realpath,
          open
        }
      )

      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.errorCode).toBe('FILE_CHANGED')
        expect(res.errorMessage).toMatch(/replaced|modified|identity/i)
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('rejects extraction when the pathname is replaced between pre-open lstat and open', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pv-doc-worker-pre-id-'))
    try {
      const docsDir = join(tempDir, 'docs')
      mkdirSync(docsDir, { recursive: true })
      const originalFile = join(docsDir, 'doc.txt')
      const replacementFile = join(docsDir, 'replacement.txt')
      writeFileSync(originalFile, 'original content')
      writeFileSync(replacementFile, 'replacement content')

      const origStat = await lstat(originalFile)

      const res = await readAndVerifySource(
        {
          id: 2,
          action: 'extract_document',
          sourcePath: originalFile,
          approvedRoots: [docsDir],
          extension: '.txt',
          expectedByteSize: origStat.size,
          expectedMtimeMs: origStat.mtimeMs,
          expectedSha256: null
        },
        {
          lstat,
          realpath,
          open: (async (p: Parameters<typeof open>[0], flags: Parameters<typeof open>[1]) => {
            // Simulate pathname swapped to replacementFile right before open()
            if (p === originalFile) {
              return open(replacementFile, flags)
            }
            return open(p, flags)
          }) as typeof open
        }
      )

      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.errorCode).toBe('FILE_CHANGED')
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
