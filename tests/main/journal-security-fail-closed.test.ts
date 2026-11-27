/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  AnnotationJournal,
  JournalSecurityError
} from '../../src/main/services/annotations/journal'

describe('Journal Security Fail-Closed & Canonical Overlap (Finding 4)', () => {
  let tempDir: string
  let annotationsDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-sec-fail-closed-'))
    annotationsDir = join(tempDir, 'userData', 'annotations')
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('fails closed during initialize if sourceRoots getter throws or cannot obtain security context', async () => {
    const journal = new AnnotationJournal({
      storageDir: annotationsDir,
      sourceRoots: () => {
        throw new Error('Database catalog locked; cannot retrieve source roots')
      },
      vaultPath: () => null
    })

    await expect(journal.initialize()).rejects.toThrow(JournalSecurityError)
  })

  it('fails closed during initialize if vaultPath getter throws or cannot obtain security context', async () => {
    const journal = new AnnotationJournal({
      storageDir: annotationsDir,
      sourceRoots: () => [],
      vaultPath: () => {
        throw new Error('Vault manager unavailable; cannot verify vault path')
      }
    })

    await expect(journal.initialize()).rejects.toThrow(JournalSecurityError)
  })

  it('fails closed before mutating storage if security context getter throws or returns undefined', async () => {
    let failContext = false
    const journal = new AnnotationJournal({
      storageDir: annotationsDir,
      sourceRoots: () => {
        if (failContext) {
          throw new Error('Catalog closed mid-session')
        }
        return []
      },
      vaultPath: () => null
    })
    await journal.initialize()

    // Mutation succeeds when context is available
    journal.appendCollectionCreatedSync({
      opId: 'op-1',
      collectionId: 1,
      name: 'Safe',
      normalizedName: 'safe'
    })

    // Fail security context
    failContext = true
    expect(() => {
      journal.appendCollectionCreatedSync({
        opId: 'op-2',
        collectionId: 2,
        name: 'Should Fail',
        normalizedName: 'should fail'
      })
    }).toThrow(JournalSecurityError)
  })

  it('does not omit source roots beyond 1,000 when checking overlap', async () => {
    // Generate 1,050 simulated source roots, with the overlapping one at index 1,025
    const largeRoots: string[] = []
    for (let i = 0; i < 1050; i++) {
      largeRoots.push(join(tempDir, `source_${i}`))
    }
    // Put overlapping root at index 1,025
    largeRoots[1025] = join(tempDir, 'userData')

    const journal = new AnnotationJournal({
      storageDir: annotationsDir,
      sourceRoots: () => largeRoots,
      vaultPath: () => null
    })

    // Initialize must fail closed by detecting overlap with index 1,025
    await expect(journal.initialize()).rejects.toThrow(JournalSecurityError)
  })

  it('uses canonical platform-correct overlap check (case-insensitivity, trailing slashes, relative resolution)', async () => {
    // Overlap with case variations and redundant slashes
    const overlappingPath =
      join(tempDir, 'USERDATA') + (process.platform === 'win32' ? '\\\\' : '//')

    const journal = new AnnotationJournal({
      storageDir: annotationsDir,
      sourceRoots: () => [overlappingPath],
      vaultPath: () => null
    })

    await expect(journal.initialize()).rejects.toThrow(JournalSecurityError)
  })
})
