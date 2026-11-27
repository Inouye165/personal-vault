import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import {
  DocSemanticSearchCancelRequestSchema,
  DocSemanticSearchRequestSchema,
  SemanticSearchCancelRequestSchema,
  SemanticSearchRequestSchema,
  UnifiedSearchCancelRequestSchema,
  UnifiedSearchCancelResponseSchema,
  UnifiedSearchDocumentsRequestSchema,
  UnifiedSearchDocumentsResponseSchema,
  UnifiedSearchPhotosRequestSchema,
  UnifiedSearchPhotosResponseSchema
} from '../../src/shared/validation/ipc-schemas'

describe('Stage 7F Slice 1: Unified Search IPC Contracts & Zod Schemas', () => {
  it('defines narrow modality-scoped unified search and cancellation channels', () => {
    expect(IPC_CHANNELS.UNIFIED_SEARCH_PHOTOS).toBe('unified:search-photos')
    expect(IPC_CHANNELS.UNIFIED_SEARCH_DOCUMENTS).toBe('unified:search-documents')
    expect(IPC_CHANNELS.UNIFIED_SEARCH_CANCEL).toBe('unified:search-cancel')
  })

  it('applies limit=20 and offset=0 defaults and trims queries on unified requests', () => {
    const photosReq = UnifiedSearchPhotosRequestSchema.parse({
      query: '  sunset beach  ',
      ownerSurface: 'unified',
      ownerGen: 1
    })
    expect(photosReq.query).toBe('sunset beach')
    expect(photosReq.limit).toBe(20)
    expect(photosReq.offset).toBe(0)

    const docsReq = UnifiedSearchDocumentsRequestSchema.parse({
      query: '  tax receipt  ',
      ownerSurface: 'unified',
      ownerGen: 2
    })
    expect(docsReq.query).toBe('tax receipt')
    expect(docsReq.limit).toBe(20)
    expect(docsReq.offset).toBe(0)
  })

  it('rejects empty queries, out-of-range pagination, wrong ownerSurface, and unknown fields (.strict())', () => {
    expect(() =>
      UnifiedSearchPhotosRequestSchema.parse({
        query: '   ',
        ownerSurface: 'unified',
        ownerGen: 1
      })
    ).toThrow()

    expect(() =>
      UnifiedSearchPhotosRequestSchema.parse({
        query: 'beach',
        ownerSurface: 'photos-tab',
        ownerGen: 1
      })
    ).toThrow()

    expect(() =>
      UnifiedSearchPhotosRequestSchema.parse({
        query: 'beach',
        ownerSurface: 'unified',
        ownerGen: 1,
        limit: 101
      })
    ).toThrow()

    expect(() =>
      UnifiedSearchPhotosRequestSchema.parse({
        query: 'beach',
        ownerSurface: 'unified',
        ownerGen: 1,
        extraField: true
      })
    ).toThrow()

    expect(() =>
      UnifiedSearchDocumentsRequestSchema.parse({
        query: 'invoice',
        ownerSurface: 'unified',
        ownerGen: -1
      })
    ).toThrow()

    expect(() =>
      UnifiedSearchDocumentsRequestSchema.parse({
        query: 'invoice',
        ownerSurface: 'unified',
        ownerGen: 1,
        documentFilters: {
          extensionFilter: '.pdf',
          unknownFilter: 'bad'
        }
      })
    ).toThrow()
  })

  it('validates unified cancel requests across all three surfaces with modality default', () => {
    const req = UnifiedSearchCancelRequestSchema.parse({
      ownerSurface: 'photos-tab',
      ownerGen: 4
    })
    expect(req.modality).toBe('all')

    expect(() =>
      UnifiedSearchCancelRequestSchema.parse({
        ownerSurface: 'unknown-tab',
        ownerGen: 1
      })
    ).toThrow()

    expect(UnifiedSearchCancelResponseSchema.parse({ cancelled: true })).toEqual({
      cancelled: true
    })
  })

  it('validates modality-scoped response envelopes and rejects wrong modelId or invalid statuses', () => {
    const validPhotos = UnifiedSearchPhotosResponseSchema.parse({
      status: 'unprovisioned',
      modelId: 'Xenova/clip-vit-base-patch32',
      result: null,
      errorMessage: null
    })
    expect(validPhotos.status).toBe('unprovisioned')

    const validDocs = UnifiedSearchDocumentsResponseSchema.parse({
      status: 'timed_out',
      modelId: 'Xenova/bge-small-en-v1.5',
      result: null,
      errorMessage: 'Timed out waiting for worker budget'
    })
    expect(validDocs.status).toBe('timed_out')

    expect(() =>
      UnifiedSearchPhotosResponseSchema.parse({
        status: 'ready',
        modelId: 'Xenova/bge-small-en-v1.5',
        result: null,
        errorMessage: null
      })
    ).toThrow()

    expect(() =>
      UnifiedSearchDocumentsResponseSchema.parse({
        status: 'invalid_status',
        modelId: 'Xenova/bge-small-en-v1.5',
        result: null,
        errorMessage: null
      })
    ).toThrow()
  })

  it('preserves strict tab search schemas while accepting optional monotonic ownerGen', () => {
    expect(SemanticSearchRequestSchema.parse({ queryText: 'ocean', ownerGen: 5 }).ownerGen).toBe(5)
    expect(SemanticSearchCancelRequestSchema.parse({ ownerGen: 5 }).ownerGen).toBe(5)
    expect(DocSemanticSearchRequestSchema.parse({ query: 'lease', ownerGen: 7 }).ownerGen).toBe(7)
    expect(DocSemanticSearchCancelRequestSchema.parse({ ownerGen: 7 }).ownerGen).toBe(7)
    expect(() => SemanticSearchCancelRequestSchema.parse({ ownerGen: 5, extra: 'nope' })).toThrow()
  })
})
