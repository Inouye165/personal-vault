import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'

describe('AnnotationJournal Ownership and Path Containment (Finding 3)', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = join(
      process.cwd(),
      'temp',
      `test-ownership-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    )
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('rejects foreign or hostile existing ownership marker', async () => {
    const markerPath = join(tempDir, '.pv_annotations_owner')
    // Write a hostile / invalid marker
    await fs.writeFile(
      markerPath,
      JSON.stringify({ app: 'malicious-app', format: 'arbitrary-file', data: 'junk' }),
      'utf8'
    )

    const journal = new AnnotationJournal({ storageDir: tempDir })
    await expect(journal.initialize()).rejects.toThrow(/marker|ownership/i)
  })

  it('rejects an existing journal file if ownership marker is missing or invalid', async () => {
    const journalPath = join(tempDir, 'review-journal.jsonl')
    await fs.writeFile(journalPath, '{"some":"foreign-data"}\n', 'utf8')

    // Marker does not exist, but journal does! Must not adopt or overwrite foreign file!
    const journal = new AnnotationJournal({ storageDir: tempDir })
    await expect(journal.initialize()).rejects.toThrow(/unrelated|conflict|ownership/i)
  })

  it('rejects storage directory that overlaps with a source directory or vault directory', async () => {
    const sourceDir = join(tempDir, 'source-photos')
    const nestedStorageDir = join(sourceDir, 'nested-journal')
    await fs.mkdir(sourceDir, { recursive: true })
    await fs.mkdir(nestedStorageDir, { recursive: true })

    const journal = new AnnotationJournal({
      storageDir: nestedStorageDir,
      forbiddenOverlapPaths: [sourceDir]
    })
    await expect(journal.initialize()).rejects.toThrow(/overlap/i)
  })

  it('rejects storage directory containing symbolic links or junctions', async () => {
    const targetDir = join(tempDir, 'actual-target')
    const linkDir = join(tempDir, 'symlink-storage')
    await fs.mkdir(targetDir, { recursive: true })

    try {
      await fs.symlink(targetDir, linkDir, 'junction')
    } catch {
      // If symlink/junction creation is not supported on this host without elevation, skip
      return
    }

    const journal = new AnnotationJournal({ storageDir: linkDir })
    await expect(journal.initialize()).rejects.toThrow(/symlink|junction/i)
  })
})
