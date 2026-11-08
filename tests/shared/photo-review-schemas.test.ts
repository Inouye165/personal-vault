import { describe, expect, it } from 'vitest'
import {
  AddCollectionMemberRequestSchema,
  AnnotationJournalEntrySchema,
  CreateCollectionRequestSchema,
  GetPhotosPageRequestSchema,
  PhotoItemSchema,
  RemoveCollectionMemberRequestSchema,
  RenameCollectionRequestSchema,
  SetPhotoAnnotationRequestSchema
} from '../../src/shared/validation/ipc-schemas'

describe('Stage 5B Photo Review & Collections IPC Schemas', () => {
  describe('SetPhotoAnnotationRequestSchema', () => {
    it('accepts valid rating (1-5) and flag (pick/reject/none)', () => {
      const valid = SetPhotoAnnotationRequestSchema.safeParse({
        fileLocationId: 42,
        expectedRevision: 'rev:1:1024:1700000000000:hash123',
        expectedVersion: 1,
        rating: 5,
        flag: 'pick'
      })
      expect(valid.success).toBe(true)
      if (valid.success) {
        expect(valid.data.rating).toBe(5)
        expect(valid.data.flag).toBe('pick')
      }
    })

    it('accepts clearing rating (null) and clearing flag (none)', () => {
      const valid = SetPhotoAnnotationRequestSchema.safeParse({
        fileLocationId: 42,
        expectedRevision: 'rev:1:1024:1700000000000:hash123',
        expectedVersion: 0,
        rating: null,
        flag: 'none'
      })
      expect(valid.success).toBe(true)
      if (valid.success) {
        expect(valid.data.rating).toBeNull()
        expect(valid.data.flag).toBe('none')
      }
    })

    it('rejects invalid rating numbers (0, 6, negatives, floats)', () => {
      expect(
        SetPhotoAnnotationRequestSchema.safeParse({
          fileLocationId: 42,
          expectedRevision: 'rev:1:1024:1700000000000:hash123',
          expectedVersion: 0,
          rating: 0,
          flag: 'none'
        }).success
      ).toBe(false)

      expect(
        SetPhotoAnnotationRequestSchema.safeParse({
          fileLocationId: 42,
          expectedRevision: 'rev:1:1024:1700000000000:hash123',
          expectedVersion: 0,
          rating: 6,
          flag: 'none'
        }).success
      ).toBe(false)

      expect(
        SetPhotoAnnotationRequestSchema.safeParse({
          fileLocationId: 42,
          expectedRevision: 'rev:1:1024:1700000000000:hash123',
          expectedVersion: 0,
          rating: 3.5,
          flag: 'none'
        }).success
      ).toBe(false)
    })

    it('rejects invalid flag values', () => {
      expect(
        SetPhotoAnnotationRequestSchema.safeParse({
          fileLocationId: 42,
          expectedRevision: 'rev:1:1024:1700000000000:hash123',
          expectedVersion: 0,
          rating: 3,
          flag: 'favorite'
        }).success
      ).toBe(false)
    })

    it('rejects missing or empty expectedRevision or negative expectedVersion', () => {
      expect(
        SetPhotoAnnotationRequestSchema.safeParse({
          fileLocationId: 42,
          expectedRevision: '',
          expectedVersion: 0,
          rating: 3,
          flag: 'none'
        }).success
      ).toBe(false)

      expect(
        SetPhotoAnnotationRequestSchema.safeParse({
          fileLocationId: 42,
          expectedRevision: 'rev:1',
          expectedVersion: -1,
          rating: 3,
          flag: 'none'
        }).success
      ).toBe(false)
    })
  })

  describe('CreateCollectionRequestSchema and RenameCollectionRequestSchema', () => {
    it('accepts valid 1-80 character collection names', () => {
      const valid = CreateCollectionRequestSchema.safeParse({ name: 'Summer Vacation 2024' })
      expect(valid.success).toBe(true)
      if (valid.success) {
        expect(valid.data.name).toBe('Summer Vacation 2024')
      }
    })

    it('rejects empty or whitespace-only collection names', () => {
      expect(CreateCollectionRequestSchema.safeParse({ name: '' }).success).toBe(false)
      expect(CreateCollectionRequestSchema.safeParse({ name: '    ' }).success).toBe(false)
    })

    it('rejects collection names longer than 80 characters', () => {
      expect(CreateCollectionRequestSchema.safeParse({ name: 'A'.repeat(81) }).success).toBe(false)
    })

    it('rejects collection names with control characters', () => {
      expect(CreateCollectionRequestSchema.safeParse({ name: 'Bad\x00Name' }).success).toBe(false)
      expect(CreateCollectionRequestSchema.safeParse({ name: 'Newline\nName' }).success).toBe(false)
      expect(CreateCollectionRequestSchema.safeParse({ name: 'Tab\tName' }).success).toBe(false)
      expect(CreateCollectionRequestSchema.safeParse({ name: 'Escape\x1bName' }).success).toBe(
        false
      )
    })

    it('validates rename collection with collectionId and new name', () => {
      const valid = RenameCollectionRequestSchema.safeParse({
        collectionId: 3,
        name: 'Family Photos'
      })
      expect(valid.success).toBe(true)
      expect(
        RenameCollectionRequestSchema.safeParse({ collectionId: -1, name: 'Family Photos' }).success
      ).toBe(false)
    })
  })

  describe('GetPhotosPageRequestSchema with Stage 5B filters', () => {
    it('accepts rating filter, flag filter, and collectionId', () => {
      const valid = GetPhotosPageRequestSchema.safeParse({
        offset: 0,
        limit: 50,
        ratingFilter: '4',
        flagFilter: 'pick',
        collectionId: 10
      })
      expect(valid.success).toBe(true)
      if (valid.success) {
        expect(valid.data.ratingFilter).toBe('4')
        expect(valid.data.flagFilter).toBe('pick')
        expect(valid.data.collectionId).toBe(10)
      }
    })

    it('accepts unrated and all filter options and nullable collectionId', () => {
      const valid = GetPhotosPageRequestSchema.safeParse({
        offset: 0,
        limit: 50,
        ratingFilter: 'unrated',
        flagFilter: 'reject',
        collectionId: null
      })
      expect(valid.success).toBe(true)
      if (valid.success) {
        expect(valid.data.ratingFilter).toBe('unrated')
        expect(valid.data.collectionId).toBeNull()
      }
    })

    it('defaults filters to all and null when omitted', () => {
      const valid = GetPhotosPageRequestSchema.safeParse({
        offset: 0,
        limit: 50
      })
      expect(valid.success).toBe(true)
      if (valid.success) {
        expect(valid.data.ratingFilter).toBe('all')
        expect(valid.data.flagFilter).toBe('all')
        expect(valid.data.collectionId).toBeNull()
      }
    })
  })

  describe('PhotoItemSchema with Stage 5B annotations', () => {
    it('parses photo items with rating, flag, and annotationVersion', () => {
      const raw = {
        id: 1,
        sourceId: 10,
        originalPath: 'C:\\photos\\img1.jpg',
        fileName: 'img1.jpg',
        extension: '.jpg',
        category: 'photo',
        discoveryObservationId: 100,
        byteSize: 2048576,
        filesystemBirthtimeMs: 1700000000000,
        filesystemMtimeMs: 1700000005000,
        inferredCaptureTimeMs: null,
        firstDiscoveredAtMs: 1700000010000,
        lastSeenAtMs: 1700000020000,
        activeHash: 'a'.repeat(64),
        activeHashVerifiedAtMs: 1700000030000,
        rating: 4,
        flag: 'pick',
        annotationVersion: 2
      }
      const parsed = PhotoItemSchema.safeParse(raw)
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        expect(parsed.data.rating).toBe(4)
        expect(parsed.data.flag).toBe('pick')
        expect(parsed.data.annotationVersion).toBe(2)
      }
    })

    it('defaults rating to null, flag to none, and annotationVersion to 0 when omitted', () => {
      const raw = {
        id: 1,
        sourceId: 10,
        originalPath: 'C:\\photos\\img1.jpg',
        fileName: 'img1.jpg',
        extension: '.jpg',
        category: 'photo',
        discoveryObservationId: 100,
        byteSize: 2048576,
        filesystemBirthtimeMs: 1700000000000,
        filesystemMtimeMs: 1700000005000,
        inferredCaptureTimeMs: null,
        firstDiscoveredAtMs: 1700000010000,
        lastSeenAtMs: 1700000020000,
        activeHash: 'a'.repeat(64),
        activeHashVerifiedAtMs: 1700000030000
      }
      const parsed = PhotoItemSchema.safeParse(raw)
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        expect(parsed.data.rating).toBeNull()
        expect(parsed.data.flag).toBe('none')
        expect(parsed.data.annotationVersion).toBe(0)
      }
    })
  })

  describe('AddCollectionMemberRequestSchema and RemoveCollectionMemberRequestSchema', () => {
    it('requires collectionId, fileLocationId, and non-empty expectedRevision', () => {
      const validAdd = AddCollectionMemberRequestSchema.safeParse({
        collectionId: 1,
        fileLocationId: 10,
        expectedRevision: 'rev:1:100:1700000000000:hash'
      })
      expect(validAdd.success).toBe(true)

      const invalidAdd = AddCollectionMemberRequestSchema.safeParse({
        collectionId: 1,
        fileLocationId: 10
      })
      expect(invalidAdd.success).toBe(false)

      const validRemove = RemoveCollectionMemberRequestSchema.safeParse({
        collectionId: 1,
        fileLocationId: 10,
        expectedRevision: 'rev:1:100:1700000000000:hash'
      })
      expect(validRemove.success).toBe(true)

      const invalidRemove = RemoveCollectionMemberRequestSchema.safeParse({
        collectionId: 1,
        fileLocationId: 10
      })
      expect(invalidRemove.success).toBe(false)
    })
  })

  describe('AnnotationJournalEntrySchema', () => {
    it('validates a photo_annotation journal entry', () => {
      const entry = {
        formatVersion: 1,
        entrySeq: 1,
        entryTimestampMs: 1700000000000,
        opId: 'op-1',
        kind: 'photo_annotation',
        locationId: 1,
        normalizedPath: 'photos/img.jpg',
        originalPath: 'C:\\photos\\img.jpg',
        byteSize: 1024,
        filesystemMtimeMs: 1700000000000,
        activeHash: 'a'.repeat(64),
        discoveryObservationId: 10,
        expectedRevision: 'rev:10:1024:1700000000000:hash',
        version: 1,
        rating: 5,
        flag: 'pick'
      }
      const parsed = AnnotationJournalEntrySchema.safeParse(entry)
      expect(parsed.success).toBe(true)
    })

    it('validates a collection_created journal entry', () => {
      const entry = {
        formatVersion: 1,
        entrySeq: 2,
        entryTimestampMs: 1700000001000,
        opId: 'op-2',
        kind: 'collection_created',
        collectionId: 1,
        name: 'Portraits',
        normalizedName: 'portraits'
      }
      const parsed = AnnotationJournalEntrySchema.safeParse(entry)
      expect(parsed.success).toBe(true)
    })

    it('validates op_committed and op_aborted entries', () => {
      const commitEntry = {
        formatVersion: 1,
        entrySeq: 3,
        entryTimestampMs: 1700000002000,
        opId: 'op-2',
        kind: 'op_committed',
        targetSeq: 2
      }
      expect(AnnotationJournalEntrySchema.safeParse(commitEntry).success).toBe(true)

      const abortEntry = {
        formatVersion: 1,
        entrySeq: 4,
        entryTimestampMs: 1700000003000,
        opId: 'op-3',
        kind: 'op_aborted',
        targetSeq: 3,
        reason: 'Precondition failed'
      }
      expect(AnnotationJournalEntrySchema.safeParse(abortEntry).success).toBe(true)
    })
  })
})
