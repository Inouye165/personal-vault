/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  AnnotationJournal,
  JournalCorruptionError
} from '../../src/main/services/annotations/journal'

describe('Journal UTF-8 Safety, Record Bounds & Recovery (Finding 2)', () => {
  let tempDir: string
  let annotationsDir: string
  let journal: AnnotationJournal

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-utf8-bounds-test-'))
    annotationsDir = join(tempDir, 'annotations')
    journal = new AnnotationJournal({ storageDir: annotationsDir })
    await journal.initialize()
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('preserves multibyte UTF-8 characters across the 64 KiB chunk boundary', async () => {
    const journalPath = join(annotationsDir, 'review-journal.jsonl')

    // Write enough entries so that a multibyte character lands exactly across the 64 KiB (65536 byte) boundary
    // A 4-byte emoji 📸 or 🚀
    const multiByteString = '📸 Special Collection 🚀 日本語 🌟'
    let currentBytes = 0

    let seq = 1
    // Pad until we are near 65480 bytes
    while (currentBytes < 65480) {
      journal.appendCollectionCreatedSync({
        opId: `pad-op-${seq}`,
        collectionId: seq,
        name: `Pad Collection ${seq}`,
        normalizedName: `pad collection ${seq}`
      })
      journal.appendCommitRecordSync({
        opId: `pad-op-${seq}`,
        targetSeq: seq * 2 - 1
      })
      seq++
      currentBytes = Buffer.byteLength(readFileSync(journalPath, 'utf8'), 'utf8')
    }

    // Now append an entry containing multibyte UTF-8 string that will span across the 65536 offset
    const straddlingEntry = journal.appendCollectionCreatedSync({
      opId: 'straddle-op',
      collectionId: 9999,
      name: multiByteString.repeat(2),
      normalizedName: 'straddle'
    })
    journal.appendCommitRecordSync({
      opId: 'straddle-op',
      targetSeq: straddlingEntry.entrySeq
    })

    // Reopen a fresh journal instance on the same directory
    const freshJournal = new AnnotationJournal({ storageDir: annotationsDir })
    freshJournal.initializeSync()

    // Bounded iteration must yield the straddling entry intact without corrupted  characters
    let foundStraddling = false
    for (const entry of freshJournal.iterateEntriesSync()) {
      if (entry.kind === 'collection_created' && entry.collectionId === 9999) {
        expect(entry.name).toBe(multiByteString.repeat(2))
        expect(entry.name).not.toContain('\uFFFD')
        foundStraddling = true
      }
    }
    expect(foundStraddling).toBe(true)
  })

  it('rejects complete malformed final record ending in newline as corruption (does not truncate)', () => {
    const journalPath = join(annotationsDir, 'review-journal.jsonl')

    // Append a valid entry
    journal.appendCollectionCreatedSync({
      opId: 'op-1',
      collectionId: 1,
      name: 'Valid Collection',
      normalizedName: 'valid collection'
    })
    journal.appendCommitRecordSync({ opId: 'op-1', targetSeq: 1 })

    // Append a COMPLETE malformed line with trailing \n
    writeFileSync(journalPath, '{"invalid_json": true\n', { flag: 'a' })

    const freshJournal = new AnnotationJournal({ storageDir: annotationsDir })
    expect(() => freshJournal.initializeSync()).toThrow(JournalCorruptionError)

    // The malformed record MUST NOT have been silently truncated!
    const content = readFileSync(journalPath, 'utf8')
    expect(content).toContain('{"invalid_json": true\n')
  })

  it('safely truncates incomplete tail without trailing newline at EOF', () => {
    const journalPath = join(annotationsDir, 'review-journal.jsonl')

    journal.appendCollectionCreatedSync({
      opId: 'op-1',
      collectionId: 1,
      name: 'Valid Collection',
      normalizedName: 'valid collection'
    })
    journal.appendCommitRecordSync({ opId: 'op-1', targetSeq: 1 })

    // Append an INCOMPLETE tail without \n (torn write)
    writeFileSync(journalPath, '{"entrySeq": 3, "kind": "photo_ann', { flag: 'a' })

    const freshJournal = new AnnotationJournal({ storageDir: annotationsDir })
    freshJournal.initializeSync()

    // Truncated back to valid records
    const content = readFileSync(journalPath, 'utf8')
    expect(content).not.toContain('photo_ann')
    expect(freshJournal.getLatestSeq()).toBe(2)
  })

  it('rejects oversized records exceeding maximum record length bound', () => {
    const journalPath = join(annotationsDir, 'review-journal.jsonl')

    // An oversized line > 64 KiB with trailing newline
    const hugeLine =
      JSON.stringify({ entrySeq: 1, kind: 'collection_created', padding: 'x'.repeat(70000) }) + '\n'
    writeFileSync(journalPath, hugeLine, { flag: 'w' })

    const freshJournal = new AnnotationJournal({ storageDir: annotationsDir })
    expect(() => freshJournal.initializeSync()).toThrow(JournalCorruptionError)
  })

  it('safely recovers file state after write/fsync failure before permitting later appends', () => {
    const journalPath = join(annotationsDir, 'review-journal.jsonl')

    journal.appendCollectionCreatedSync({
      opId: 'op-1',
      collectionId: 1,
      name: 'First',
      normalizedName: 'first'
    })
    const initialSize = Buffer.byteLength(readFileSync(journalPath, 'utf8'), 'utf8')

    // Simulate append failure
    journal.setCustomAppenderSync(() => {
      // Simulate partial write before crash
      writeFileSync(journalPath, 'PARTIAL_BYTES', { flag: 'a' })
      throw new Error('Disk full during append')
    })

    expect(() => {
      journal.appendCollectionCreatedSync({
        opId: 'op-2',
        collectionId: 2,
        name: 'Second',
        normalizedName: 'second'
      })
    }).toThrow('Disk full')

    // Journal should have reverted partial write
    journal.setCustomAppenderSync(null)
    const sizeAfterFail = Buffer.byteLength(readFileSync(journalPath, 'utf8'), 'utf8')
    expect(sizeAfterFail).toBe(initialSize)

    // Subsequent append must succeed cleanly
    journal.appendCollectionCreatedSync({
      opId: 'op-3',
      collectionId: 3,
      name: 'Third',
      normalizedName: 'third'
    })
    expect(journal.getLatestSeq()).toBe(2)
  })
})
