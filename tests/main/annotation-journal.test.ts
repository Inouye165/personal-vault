import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import { AnnotationJournalEntrySchema } from '../../src/shared/validation/ipc-schemas'

describe('AnnotationJournal Service (Stage 5B Portable Persistence)', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = join(
      process.cwd(),
      'temp',
      `test-journal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    )
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  it('initializes the journal directory and creates ownership marker', async () => {
    const journal = new AnnotationJournal({ storageDir: tempDir })
    await journal.initialize()

    const ownerFile = join(tempDir, '.pv_annotations_owner')
    const ownerStat = await fs.stat(ownerFile)
    expect(ownerStat.isFile()).toBe(true)

    const journalFile = join(tempDir, 'review-journal.jsonl')
    const exists = await fs
      .stat(journalFile)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  })

  it('appends structured photo annotation entries with complete provenance', async () => {
    const journal = new AnnotationJournal({ storageDir: tempDir })
    await journal.initialize()

    const entry = await journal.appendPhotoAnnotation({
      locationId: 42,
      normalizedPath: 'photos/vacation.jpg',
      originalPath: 'C:\\Users\\Photos\\vacation.jpg',
      byteSize: 1048576,
      filesystemMtimeMs: 1700000000000,
      activeHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      discoveryObservationId: 10,
      expectedRevision: 'rev:10:1048576:1700000000000:hash',
      version: 1,
      rating: 5,
      flag: 'pick'
    })

    expect(entry.entrySeq).toBe(1)
    expect(entry.kind).toBe('photo_annotation')

    // Read back raw file lines
    const journalFile = join(tempDir, 'review-journal.jsonl')
    const content = await fs.readFile(journalFile, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(1)

    const parsed = AnnotationJournalEntrySchema.parse(JSON.parse(lines[0]!))
    expect(parsed.kind).toBe('photo_annotation')
    if (parsed.kind === 'photo_annotation') {
      expect(parsed.rating).toBe(5)
      expect(parsed.flag).toBe('pick')
      expect(parsed.locationId).toBe(42)
    }
  })

  it('appends collection lifecycle and membership entries', async () => {
    const journal = new AnnotationJournal({ storageDir: tempDir })
    await journal.initialize()

    const c1 = await journal.appendCollectionCreated({
      collectionId: 1,
      name: 'Portraits',
      normalizedName: 'portraits'
    })
    expect(c1.entrySeq).toBe(1)

    const c2 = await journal.appendCollectionRenamed({
      collectionId: 1,
      oldName: 'Portraits',
      newName: 'Studio Portraits',
      normalizedName: 'studio portraits'
    })
    expect(c2.entrySeq).toBe(2)

    const m1 = await journal.appendMembershipAdded({
      collectionId: 1,
      collectionName: 'Studio Portraits',
      locationId: 42,
      normalizedPath: 'photos/vacation.jpg',
      byteSize: 1048576,
      activeHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      discoveryObservationId: 10
    })
    expect(m1.entrySeq).toBe(3)

    const m2 = await journal.appendMembershipRemoved({
      collectionId: 1,
      collectionName: 'Studio Portraits',
      locationId: 42,
      normalizedPath: 'photos/vacation.jpg'
    })
    expect(m2.entrySeq).toBe(4)

    const entries = await journal.readEntries()
    expect(entries.length).toBe(4)
    expect(entries[0]!.kind).toBe('collection_created')
    expect(entries[1]!.kind).toBe('collection_renamed')
    expect(entries[2]!.kind).toBe('membership_added')
    expect(entries[3]!.kind).toBe('membership_removed')
  })

  it('recovers from truncated / corrupted trailing lines on startup', async () => {
    const journal = new AnnotationJournal({ storageDir: tempDir })
    await journal.initialize()

    await journal.appendCollectionCreated({
      collectionId: 1,
      name: 'Favorites',
      normalizedName: 'favorites'
    })

    // Simulate interrupted partial write by appending half a JSON record
    const journalFile = join(tempDir, 'review-journal.jsonl')
    await fs.appendFile(journalFile, '{"entrySeq": 2, "kind": "photo_annotation", "loc\n', 'utf8')

    // Reopen journal on restart
    const restartedJournal = new AnnotationJournal({ storageDir: tempDir })
    await restartedJournal.initialize()

    const entries = await restartedJournal.readEntries()
    expect(entries.length).toBe(1)
    expect(entries[0]!.kind).toBe('collection_created')

    // Next append should use seq 2 and write cleanly
    const nextEntry = await restartedJournal.appendCollectionCreated({
      collectionId: 2,
      name: 'Trips',
      normalizedName: 'trips'
    })
    expect(nextEntry.entrySeq).toBe(2)

    const reloaded = await restartedJournal.readEntries()
    expect(reloaded.length).toBe(2)
    const secondEntry = reloaded[1]!
    expect(secondEntry.kind).toBe('collection_created')
    if (secondEntry.kind === 'collection_created') {
      expect(secondEntry.name).toBe('Trips')
    }
  })

  it('serializes concurrent writes preventing interleaving', async () => {
    const journal = new AnnotationJournal({ storageDir: tempDir })
    await journal.initialize()

    const promises: Promise<unknown>[] = []
    for (let i = 1; i <= 20; i++) {
      promises.push(
        journal.appendCollectionCreated({
          collectionId: i,
          name: `Coll ${i}`,
          normalizedName: `coll ${i}`
        })
      )
    }

    await Promise.all(promises)

    const entries = await journal.readEntries()
    expect(entries.length).toBe(20)
    for (let i = 0; i < 20; i++) {
      expect(entries[i]!.entrySeq).toBe(i + 1)
    }
  })

  it('throws and does not advance sequence when writing fails', async () => {
    const journal = new AnnotationJournal({
      storageDir: tempDir,
      customAppender: async () => {
        throw new Error('ENOSPC: no space left on device')
      }
    })
    await journal.initialize()

    await expect(
      journal.appendCollectionCreated({
        collectionId: 1,
        name: 'Fail',
        normalizedName: 'fail'
      })
    ).rejects.toThrow('ENOSPC')

    expect(journal.getLatestSeq()).toBe(0)
  })

  it('throws synchronously and does not advance sequence when sync writing fails', () => {
    const journal = new AnnotationJournal({
      storageDir: tempDir,
      customAppenderSync: () => {
        throw new Error('ENOSPC: no space left on device')
      }
    })
    journal.initializeSync()

    expect(() =>
      journal.appendCollectionCreatedSync({
        collectionId: 1,
        name: 'FailSync',
        normalizedName: 'failsync'
      })
    ).toThrow('ENOSPC')

    expect(journal.getLatestSeq()).toBe(0)
  })
})
