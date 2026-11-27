import { describe, expect, it } from 'vitest'
import {
  GetPhotosPageRequestSchema,
  GetPhotosPageResponseSchema,
  GetThumbnailRequestSchema,
  ThumbnailResultSchema
} from '../../src/shared/validation/ipc-schemas'

describe('Photos & Thumbnail IPC Validation Schemas', () => {
  describe('GetPhotosPageRequestSchema', () => {
    it('accepts valid pagination parameters', () => {
      const valid = GetPhotosPageRequestSchema.safeParse({ offset: 0, limit: 50 })
      expect(valid.success).toBe(true)
      if (valid.success) {
        expect(valid.data.offset).toBe(0)
        expect(valid.data.limit).toBe(50)
      }
    })

    it('rejects negative offset and non-positive limit', () => {
      expect(GetPhotosPageRequestSchema.safeParse({ offset: -1, limit: 50 }).success).toBe(false)
      expect(GetPhotosPageRequestSchema.safeParse({ offset: 0, limit: 0 }).success).toBe(false)
      expect(GetPhotosPageRequestSchema.safeParse({ offset: 0, limit: -5 }).success).toBe(false)
    })

    it('rejects limit exceeding safe maximum bound (200)', () => {
      expect(GetPhotosPageRequestSchema.safeParse({ offset: 0, limit: 201 }).success).toBe(false)
    })

    it('rejects floating point values and NaN', () => {
      expect(GetPhotosPageRequestSchema.safeParse({ offset: 1.5, limit: 50 }).success).toBe(false)
      expect(GetPhotosPageRequestSchema.safeParse({ offset: 0, limit: 50.2 }).success).toBe(false)
      expect(GetPhotosPageRequestSchema.safeParse({ offset: NaN, limit: 50 }).success).toBe(false)
    })
  })

  describe('GetPhotosPageResponseSchema', () => {
    it('validates a complete paginated photos response', () => {
      const payload = {
        items: [
          {
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
        ],
        totalCount: 1,
        offset: 0,
        limit: 50,
        hasMore: false
      }
      const parsed = GetPhotosPageResponseSchema.safeParse(payload)
      expect(parsed.success).toBe(true)
    })

    it('preserves distinct items even with identical activeHash', () => {
      const payload = {
        items: [
          {
            id: 1,
            sourceId: 10,
            originalPath: 'C:\\photos\\img1.jpg',
            fileName: 'img1.jpg',
            extension: '.jpg',
            category: 'photo',
            discoveryObservationId: 100,
            byteSize: 2048576,
            filesystemBirthtimeMs: null,
            filesystemMtimeMs: 1700000005000,
            inferredCaptureTimeMs: null,
            firstDiscoveredAtMs: 1700000010000,
            lastSeenAtMs: 1700000020000,
            activeHash: 'a'.repeat(64),
            activeHashVerifiedAtMs: 1700000030000
          },
          {
            id: 2,
            sourceId: 10,
            originalPath: 'C:\\photos\\sub\\copy.jpg',
            fileName: 'copy.jpg',
            extension: '.jpg',
            category: 'photo',
            discoveryObservationId: 101,
            byteSize: 2048576,
            filesystemBirthtimeMs: null,
            filesystemMtimeMs: 1700000005000,
            inferredCaptureTimeMs: null,
            firstDiscoveredAtMs: 1700000010000,
            lastSeenAtMs: 1700000020000,
            activeHash: 'a'.repeat(64),
            activeHashVerifiedAtMs: 1700000030000
          }
        ],
        totalCount: 2,
        offset: 0,
        limit: 50,
        hasMore: false
      }
      const parsed = GetPhotosPageResponseSchema.safeParse(payload)
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        expect(parsed.data.items).toHaveLength(2)
        expect(parsed.data.items[0]!.id).toBe(1)
        expect(parsed.data.items[1]!.id).toBe(2)
      }
    })
  })

  describe('GetThumbnailRequestSchema', () => {
    it('accepts location ID with optional expected revision info and priority', () => {
      const req = {
        locationId: 42,
        expectedByteSize: 1024,
        expectedMtimeMs: 1700000000000,
        priority: 'high' as const
      }
      const parsed = GetThumbnailRequestSchema.safeParse(req)
      expect(parsed.success).toBe(true)
    })

    it('rejects non-positive locationId or invalid priority', () => {
      expect(GetThumbnailRequestSchema.safeParse({ locationId: 0 }).success).toBe(false)
      expect(GetThumbnailRequestSchema.safeParse({ locationId: -10 }).success).toBe(false)
      expect(
        GetThumbnailRequestSchema.safeParse({ locationId: 1, priority: 'urgent' }).success
      ).toBe(false)
    })

    it('rejects arbitrary filesystem path injection', () => {
      const malicious = {
        locationId: 1,
        path: 'C:\\Windows\\System32\\cmd.exe'
      }
      const parsed = GetThumbnailRequestSchema.safeParse(malicious)
      // Zod strips or rejects unexpected properties, but ensuring path is never passed
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        expect('path' in parsed.data).toBe(false)
      }
    })
  })

  describe('ThumbnailResultSchema', () => {
    it('validates a ready thumbnail result with bounded dataUrl', () => {
      const ready = {
        status: 'ready' as const,
        locationId: 123,
        dataUrl:
          'data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoB+AA/vlNAAA==',
        mimeType: 'image/webp',
        width: 1,
        height: 1
      }
      const parsed = ThumbnailResultSchema.safeParse(ready)
      expect(parsed.success).toBe(true)
    })

    it('validates unsupported format result', () => {
      const unsupported = {
        status: 'unsupported' as const,
        locationId: 456,
        reason: 'HEIC format decoding requires unsupported external toolchains'
      }
      const parsed = ThumbnailResultSchema.safeParse(unsupported)
      expect(parsed.success).toBe(true)
    })

    it('validates error result', () => {
      const err = {
        status: 'error' as const,
        locationId: 789,
        code: 'DECODE_FAILED',
        message: 'Corrupted image stream'
      }
      const parsed = ThumbnailResultSchema.safeParse(err)
      expect(parsed.success).toBe(true)
    })

    it('rejects file: protocol data URL to prevent CSP violation', () => {
      const fileUrl = {
        status: 'ready' as const,
        locationId: 123,
        dataUrl: 'file:///C:/path/to/thumb.webp',
        mimeType: 'image/webp',
        width: 1,
        height: 1
      }
      const parsed = ThumbnailResultSchema.safeParse(fileUrl)
      expect(parsed.success).toBe(false)
    })
  })
})
