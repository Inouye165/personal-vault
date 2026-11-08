import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'

describe('AnnotationJournal Safe Recovery & Crash Consistency (Findings 1 & 2)', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = join(
      process.cwd(),
      'temp',
      `test-journal-rec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
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

  it('rejects startup and preserves evidence when interior corruption is detected (does not discard subsequent records)', async () => {
    const journal = new AnnotationJournal({ storageDir: tempDir })
    await journal.initialize()

    // Append 3 valid entries
    await journal.appendCollectionCreated({
      opId: 'op-1',
      collectionId: 1,
      name: 'First',
      normalizedName: 'first'
    })
    await journal.appendCollectionCreated({
      opId: 'op-2',
      collectionId: 2,
      name: 'Second',
      normalizedName: 'second'
    })
    await journal.appendCollectionCreated({
      opId: 'op-3',
      collectionId: 3,
      name: 'Third',
      normalizedName: 'third'
    })

    // Corrupt entry 2 in the interior of the file
    const journalFile = join(tempDir, 'review-journal.jsonl')
    const content = await fs.readFile(journalFile, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(3)
    lines[1] = '{"corrupted": true, bad_json'
    await fs.writeFile(journalFile, lines.join('\n') + '\n', 'utf8')

    // Restarting must REFUSE to blindly truncate lines[2], must preserve evidence and throw
    const restarting = new AnnotationJournal({ storageDir: tempDir })
    await expect(restarting.initialize()).rejects.toThrow(/interior|corruption|unsafe/i)

    // File content must be preserved for forensics/actionable repair
    const preservedContent = await fs.readFile(journalFile, 'utf8')
    expect(preservedContent).toContain('Third')
  })

  it('detects and rejects sequence disorder (sequence jump or regression)', async () => {
    const journal = new AnnotationJournal({ storageDir: tempDir })
    await journal.initialize()

    await journal.appendCollectionCreated({
      opId: 'op-1',
      collectionId: 1,
      name: 'First',
      normalizedName: 'first'
    })

    // Manually inject an entry with sequence 5 instead of 2
    const journalFile = join(tempDir, 'review-journal.jsonl')
    const badSeqEntry = JSON.stringify({
      formatVersion: 1,
      entrySeq: 5,
      entryTimestampMs: Date.now(),
      opId: 'op-jump',
      kind: 'collection_created',
      collectionId: 2,
      name: 'Jumped',
      normalizedName: 'jumped'
    })
    await fs.appendFile(journalFile, badSeqEntry + '\n', 'utf8')

    const restarting = new AnnotationJournal({ storageDir: tempDir })
    await expect(restarting.initialize()).rejects.toThrow(/sequence|disorder|ordering/i)
  })

  it('safely recovers and truncates only an incomplete final record at EOF', async () => {
    const journal = new AnnotationJournal({ storageDir: tempDir })
    await journal.initialize()

    await journal.appendCollectionCreated({
      opId: 'op-1',
      collectionId: 1,
      name: 'Valid First',
      normalizedName: 'valid first'
    })

    // Append partial unclosed JSON without trailing newline (incomplete final record)
    const journalFile = join(tempDir, 'review-journal.jsonl')
    await fs.appendFile(
      journalFile,
      '{"formatVersion": 1, "entrySeq": 2, "opId": "op-2", "kin',
      'utf8'
    )

    const restarting = new AnnotationJournal({ storageDir: tempDir })
    await restarting.initialize()

    const entries = await restarting.readEntries()
    expect(entries.length).toBe(1)
    expect(entries[0]!.kind).toBe('collection_created')
    expect(restarting.getLatestSeq()).toBe(1)

    // Can continue appending cleanly
    await restarting.appendCollectionCreated({
      opId: 'op-2-retry',
      collectionId: 2,
      name: 'Valid Second',
      normalizedName: 'valid second'
    })
    expect(restarting.getLatestSeq()).toBe(2)
  })

  it('supports the operation/commit protocol with op_committed and op_aborted records', async () => {
    const journal = new AnnotationJournal({ storageDir: tempDir })
    await journal.initialize()

    // Append operation
    const op = await journal.appendCollectionCreated({
      opId: 'op-commit-1',
      collectionId: 1,
      name: 'Album',
      normalizedName: 'album'
    })
    expect(op.opId).toBe('op-commit-1')
    expect(op.entrySeq).toBe(1)

    // Append commit marker
    const commit = await journal.appendCommitRecord({
      opId: 'op-commit-1',
      targetSeq: 1
    })
    expect(commit.kind).toBe('op_committed')
    expect(commit.entrySeq).toBe(2)

    // Append another operation then abort it
    const op2 = await journal.appendCollectionCreated({
      opId: 'op-abort-2',
      collectionId: 2,
      name: 'Draft',
      normalizedName: 'draft'
    })
    expect(op2.entrySeq).toBe(3)

    const abort = await journal.appendAbortRecord({
      opId: 'op-abort-2',
      targetSeq: 3,
      reason: 'Transaction rolled back'
    })
    expect(abort.kind).toBe('op_aborted')
    expect(abort.entrySeq).toBe(4)

    const entries = await journal.readEntries()
    expect(entries.length).toBe(4)
  })
})
