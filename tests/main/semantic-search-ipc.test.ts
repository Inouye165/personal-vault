import { describe, expect, it } from 'vitest'
import {
  SemanticSearchRequestSchema,
  SemanticSearchResponseSchema,
  type SemanticSearchRequest,
  type SemanticSearchResponse
} from '../../src/shared/validation/ipc-schemas'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'

describe('Stage 6D: Semantic Search IPC Validation & Contracts', () => {
  it('defines narrow IPC channels for semantic search and cancellation', () => {
    expect(IPC_CHANNELS.SEMANTIC_SEARCH_PHOTOS).toBe('semantic:search-photos')
    expect(IPC_CHANNELS.SEMANTIC_SEARCH_CANCEL).toBe('semantic:search-cancel')
  })

  describe('SemanticSearchRequestSchema', () => {
    it('accepts valid query with defaults', () => {
      const valid: SemanticSearchRequest = {
        queryText: 'sunset over water'
      }
      const parsed = SemanticSearchRequestSchema.parse(valid)
      expect(parsed.queryText).toBe('sunset over water')
      expect(parsed.limit).toBe(50)
      expect(parsed.offset).toBe(0)
      expect(parsed.minScore).toBe(0.0)
      expect(parsed.ratingFilter).toBe('all')
      expect(parsed.flagFilter).toBe('all')
    })

    it('accepts combined metadata and review filters', () => {
      const valid: SemanticSearchRequest = {
        queryText: 'red car',
        offset: 10,
        limit: 25,
        minScore: 0.22,
        ratingFilter: '4',
        flagFilter: 'pick',
        collectionId: 3,
        cameraNormalized: 'canon eos r5',
        fileTypeBasis: 'detected_format',
        fileTypeValue: 'jpeg'
      }
      const parsed = SemanticSearchRequestSchema.parse(valid)
      expect(parsed.ratingFilter).toBe('4')
      expect(parsed.cameraNormalized).toBe('canon eos r5')
      expect(parsed.limit).toBe(25)
    })

    it('rejects empty query or query exceeding 500 characters', () => {
      expect(() => SemanticSearchRequestSchema.parse({ queryText: '' })).toThrow()
      expect(() =>
        SemanticSearchRequestSchema.parse({
          queryText: 'a'.repeat(501)
        })
      ).toThrow()
    })

    it('rejects limits > 100 or negative offsets', () => {
      expect(() =>
        SemanticSearchRequestSchema.parse({
          queryText: 'ocean',
          limit: 101
        })
      ).toThrow()

      expect(() =>
        SemanticSearchRequestSchema.parse({
          queryText: 'ocean',
          offset: -1
        })
      ).toThrow()
    })

    it('rejects unrecognized extra fields (.strict())', () => {
      expect(() =>
        SemanticSearchRequestSchema.parse({
          queryText: 'ocean',
          arbitraryInjection: 'rm -rf /'
        })
      ).toThrow()
    })
  })

  describe('SemanticSearchResponseSchema', () => {
    it('validates a complete honest search response', () => {
      const sampleResponse: SemanticSearchResponse = {
        items: [
          {
            photo: {
              id: 1,
              sourceId: 1,
              originalPath: '/path/to/photo.jpg',
              fileName: 'photo.jpg',
              extension: '.jpg',
              category: 'photo',
              discoveryObservationId: 1,
              byteSize: 2048,
              filesystemBirthtimeMs: 1700000000000,
              filesystemMtimeMs: 1700000000000,
              inferredCaptureTimeMs: null,
              firstDiscoveredAtMs: 1700000000000,
              lastSeenAtMs: 1700000000000,
              activeHash: 'a'.repeat(64),
              activeHashVerifiedAtMs: 1700000000000,
              rating: 5,
              flag: 'pick',
              annotationVersion: 1
            },
            score: 0.3245,
            rank: 1
          }
        ],
        totalMatched: 1,
        eligibleCount: 1,
        unindexedCount: 0,
        staleCount: 0,
        offset: 0,
        limit: 50,
        hasMore: false,
        queryLatencyMs: 15.2,
        truncated: false,
        tokenCount: 6,
        modelStatus: 'ready'
      }

      const parsed = SemanticSearchResponseSchema.parse(sampleResponse)
      expect(parsed.totalMatched).toBe(1)
      expect(parsed.items[0]?.score).toBeCloseTo(0.3245, 4)
      expect(parsed.modelStatus).toBe('ready')
    })
  })
})
