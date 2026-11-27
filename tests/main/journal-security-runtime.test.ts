/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  AnnotationJournal,
  JournalSecurityError
} from '../../src/main/services/annotations/journal'

describe('Journal Security Runtime Wiring & Dynamic Overlap (Finding 3)', () => {
  let tempDir: string
  let annotationsDir: string
  let activeSources: string[]
  let activeVault: string | null

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-runtime-sec-test-'))
    annotationsDir = join(tempDir, 'userData', 'annotations')
    activeSources = []
    activeVault = null
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('rejects mutations when dynamic source roots are updated to overlap journal directory', async () => {
    const journal = new AnnotationJournal({
      storageDir: annotationsDir,
      sourceRoots: () => activeSources,
      vaultPath: () => activeVault
    })
    await journal.initialize()

    // Mutation succeeds initially with safe paths
    journal.appendCollectionCreatedSync({
      opId: 'op-1',
      collectionId: 1,
      name: 'Safe',
      normalizedName: 'safe'
    })

    // Now user adds a source root that encompasses or overlaps the userData annotationsDir
    activeSources.push(join(tempDir, 'userData'))

    // Next mutation MUST detect the dynamic overlap and reject with JournalSecurityError
    expect(() => {
      journal.appendCollectionCreatedSync({
        opId: 'op-2',
        collectionId: 2,
        name: 'Unsafe',
        normalizedName: 'unsafe'
      })
    }).toThrow(JournalSecurityError)
  })

  it('rejects mutations when active vault path is updated to overlap journal directory', async () => {
    const journal = new AnnotationJournal({
      storageDir: annotationsDir,
      sourceRoots: () => activeSources,
      vaultPath: () => activeVault
    })
    await journal.initialize()

    // Mutation succeeds initially
    journal.appendCollectionCreatedSync({
      opId: 'op-1',
      collectionId: 1,
      name: 'Safe',
      normalizedName: 'safe'
    })

    // Active vault path is set to annotationsDir or its parent
    activeVault = annotationsDir

    expect(() => {
      journal.appendCollectionCreatedSync({
        opId: 'op-2',
        collectionId: 2,
        name: 'Unsafe',
        normalizedName: 'unsafe'
      })
    }).toThrow(JournalSecurityError)
  })

  it('detects runtime symlink/junction redirection of storage directory ancestors before mutations', async () => {
    if (process.platform === 'win32') {
      // On Windows, test junction or symlink if permitted
    }
    const realTargetDir = join(tempDir, 'real_target')
    mkdirSync(realTargetDir, { recursive: true })
    const linkDir = join(tempDir, 'symlinked_ancestor', 'annotations')

    mkdirSync(join(tempDir, 'symlinked_ancestor'), { recursive: true })

    try {
      symlinkSync(realTargetDir, linkDir, 'dir')
    } catch {
      // If symlink creation not permitted in environment, skip link test
      return
    }

    const journal = new AnnotationJournal({
      storageDir: linkDir,
      sourceRoots: () => [],
      vaultPath: () => null
    })

    expect(() => journal.initializeSync()).toThrow(JournalSecurityError)
  })
})
