import { describe, it, expect } from 'vitest'
import {
  GetDuplicateGroupsRequestSchema,
  GetDuplicateGroupsResponseSchema,
  GetDuplicateGroupMembersRequestSchema,
  GetDuplicateGroupMembersResponseSchema,
  SetDuplicateReviewRequestSchema,
  SetDuplicateReviewResponseSchema,
  DuplicateReviewStatusSchema,
  DuplicateReviewFilterSchema
} from '../../src/shared/validation/ipc-schemas'

describe('Stage 3 — IPC Duplicate Review Schema Validation', () => {
  it('validates review status and filter enums', () => {
    expect(DuplicateReviewStatusSchema.parse('unreviewed')).toBe('unreviewed')
    expect(DuplicateReviewStatusSchema.parse('reviewed')).toBe('reviewed')
    expect(() => DuplicateReviewStatusSchema.parse('invalid')).toThrow()

    expect(DuplicateReviewFilterSchema.parse('all')).toBe('all')
    expect(DuplicateReviewFilterSchema.parse('unreviewed')).toBe('unreviewed')
    expect(DuplicateReviewFilterSchema.parse('reviewed')).toBe('reviewed')
    expect(() => DuplicateReviewFilterSchema.parse('unknown')).toThrow()
  })

  it('validates GetDuplicateGroupsRequest and Response schemas', () => {
    // Valid request
    const validReq = GetDuplicateGroupsRequestSchema.parse({
      offset: 0,
      limit: 20,
      filter: 'unreviewed'
    })
    expect(validReq.offset).toBe(0)
    expect(validReq.limit).toBe(20)

    // Negative offset/limit rejected
    expect(() => GetDuplicateGroupsRequestSchema.parse({ offset: -1 })).toThrow()
    expect(() => GetDuplicateGroupsRequestSchema.parse({ limit: 0 })).toThrow()

    // Valid response
    const validResp = GetDuplicateGroupsResponseSchema.parse({
      items: [
        {
          sha256: 'a'.repeat(64),
          byteSize: 1024,
          fileCount: 2,
          groupSignature: 'sig123',
          reviewStatus: 'unreviewed',
          preferredLocationId: null,
          hasStaleDecision: false,
          reviewedAtMs: null,
          previewLocations: [
            {
              id: 1,
              sourceId: 1,
              originalPath: 'C:\\data\\1.jpg',
              normalizedPath: 'c:/data/1.jpg',
              fileName: '1.jpg',
              extension: '.jpg',
              category: 'photo',
              byteSize: 1024,
              filesystemBirthtimeMs: null,
              filesystemMtimeMs: 12345678,
              inferredCaptureTimeMs: null,
              firstDiscoveredAtMs: 12345678,
              lastSeenAtMs: 12345678,
              activeHash: 'a'.repeat(64),
              activeHashVerifiedAtMs: 12345678,
              discoveryObservationId: 1,
              hashObservationId: 1
            }
          ],
          truncatedLocations: true
        }
      ],
      totalCount: 1,
      offset: 0,
      limit: 20,
      hasMore: false
    })
    expect(validResp.items).toHaveLength(1)
    expect(validResp.items[0]!.sha256).toBe('a'.repeat(64))

    // Malformed sha256 rejected
    expect(() =>
      GetDuplicateGroupsResponseSchema.parse({
        items: [{ ...validResp.items[0]!, sha256: 'short' }],
        totalCount: 1,
        offset: 0,
        limit: 20,
        hasMore: false
      })
    ).toThrow()
  })

  it('validates GetDuplicateGroupMembersRequest and Response schemas', () => {
    const validReq = GetDuplicateGroupMembersRequestSchema.parse({
      sha256: 'f'.repeat(64),
      byteSize: 4096,
      offset: 0,
      limit: 50
    })
    expect(validReq.sha256).toBe('f'.repeat(64))

    // Invalid sha256 or negative byte size rejected
    expect(() =>
      GetDuplicateGroupMembersRequestSchema.parse({
        sha256: 'short',
        byteSize: 10
      })
    ).toThrow()
    expect(() =>
      GetDuplicateGroupMembersRequestSchema.parse({
        sha256: 'f'.repeat(64),
        byteSize: -1
      })
    ).toThrow()

    const validResp = GetDuplicateGroupMembersResponseSchema.parse({
      sha256: 'f'.repeat(64),
      byteSize: 4096,
      groupSignature: 'sig456',
      reviewStatus: 'reviewed',
      preferredLocationId: 2,
      hasStaleDecision: false,
      items: [
        {
          fileLocationId: 1,
          sourceId: 1,
          originalPath: 'C:\\a\\file.png',
          normalizedPath: 'c:/a/file.png',
          fileName: 'file.png',
          extension: '.png',
          category: 'photo',
          byteSize: 4096,
          filesystemBirthtimeMs: 1000,
          filesystemMtimeMs: 2000,
          inferredCaptureTimeMs: null,
          firstDiscoveredAtMs: 3000,
          lastSeenAtMs: 3000,
          discoveryObservationId: 10,
          hashObservationId: 20,
          activeHash: 'f'.repeat(64),
          activeHashVerifiedAtMs: 4000,
          isPreferred: false
        },
        {
          fileLocationId: 2,
          sourceId: 1,
          originalPath: 'C:\\b\\file.png',
          normalizedPath: 'c:/b/file.png',
          fileName: 'file.png',
          extension: '.png',
          category: 'photo',
          byteSize: 4096,
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: 2000,
          inferredCaptureTimeMs: null,
          firstDiscoveredAtMs: 3000,
          lastSeenAtMs: 3000,
          discoveryObservationId: 11,
          hashObservationId: 21,
          activeHash: 'f'.repeat(64),
          activeHashVerifiedAtMs: 4000,
          isPreferred: true
        }
      ],
      totalCount: 2,
      offset: 0,
      limit: 50,
      hasMore: false
    })
    expect(validResp.items[1]!.isPreferred).toBe(true)
  })

  it('validates SetDuplicateReviewRequest and Response schemas', () => {
    const validReq = SetDuplicateReviewRequestSchema.parse({
      sha256: 'b'.repeat(64),
      byteSize: 500,
      status: 'reviewed',
      preferredLocationId: 42,
      expectedGroupSignature: 'signature123'
    })
    expect(validReq.status).toBe('reviewed')
    expect(validReq.preferredLocationId).toBe(42)

    // Negative preferredLocationId rejected
    expect(() =>
      SetDuplicateReviewRequestSchema.parse({
        ...validReq,
        preferredLocationId: -1
      })
    ).toThrow()

    const validResp = SetDuplicateReviewResponseSchema.parse({
      sha256: 'b'.repeat(64),
      byteSize: 500,
      status: 'reviewed',
      preferredLocationId: 42,
      groupSignature: 'signature123',
      reviewedAtMs: 1700000000000
    })
    expect(validResp.status).toBe('reviewed')
  })
})
