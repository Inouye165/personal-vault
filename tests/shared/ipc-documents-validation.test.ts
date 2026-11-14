import { describe, expect, it } from 'vitest'
import {
  GetDocumentsPageRequestSchema,
  GetDocumentsPageResponseSchema,
  GetDocumentDetailRequestSchema,
  GetDocumentDetailResponseSchema,
  GetDocumentExtensionFacetsRequestSchema,
  GetDocumentExtensionFacetsResponseSchema,
  validatePayload
} from '../../src/shared/validation/ipc-schemas'

describe('Stage 7A — Document IPC Zod Validation', () => {
  it('validates GetDocumentsPageRequestSchema bounds', () => {
    expect(
      validatePayload(GetDocumentsPageRequestSchema, {
        offset: 0,
        limit: 50,
        extensionFilter: '.pdf',
        filenameQuery: 'invoice'
      }).success
    ).toBe(true)

    expect(validatePayload(GetDocumentsPageRequestSchema, { offset: -1, limit: 50 }).success).toBe(
      false
    )
    expect(validatePayload(GetDocumentsPageRequestSchema, { offset: 0, limit: 101 }).success).toBe(
      false
    )
    expect(validatePayload(GetDocumentsPageRequestSchema, { offset: 0, limit: 0 }).success).toBe(
      false
    )
  })

  it('validates GetDocumentsPageResponseSchema and GetDocumentDetailResponseSchema', () => {
    const sampleItem = {
      fileLocationId: 1,
      sourceId: 1,
      fileName: 'notes.md',
      extension: '.md',
      originalPath: 'D:\\docs\\notes.md',
      byteSize: 256,
      filesystemBirthtimeMs: null,
      filesystemMtimeMs: 1_700_000_000_000,
      firstDiscoveredAtMs: 1_700_000_001_000,
      lastSeenAtMs: 1_700_000_002_000,
      discoveryObservationId: 10,
      activeHash: null,
      activeHashVerifiedAtMs: null,
      extractionStatus: 'not_extracted',
      previewStatus: 'not_implemented'
    }

    expect(
      validatePayload(GetDocumentsPageResponseSchema, {
        items: [sampleItem],
        totalCount: 1,
        offset: 0,
        limit: 50
      }).success
    ).toBe(true)

    // Rejects fabricated extraction status in 7A
    expect(
      validatePayload(GetDocumentsPageResponseSchema, {
        items: [{ ...sampleItem, extractionStatus: 'extracted' }],
        totalCount: 1,
        offset: 0,
        limit: 50
      }).success
    ).toBe(false)

    expect(validatePayload(GetDocumentDetailRequestSchema, { fileLocationId: 1 }).success).toBe(
      true
    )
    expect(validatePayload(GetDocumentDetailRequestSchema, { fileLocationId: 0 }).success).toBe(
      false
    )

    expect(
      validatePayload(GetDocumentDetailResponseSchema, {
        item: {
          ...sampleItem,
          sourceRootPath: 'D:\\docs',
          normalizedPath: 'd:\\docs\\notes.md'
        }
      }).success
    ).toBe(true)
    expect(validatePayload(GetDocumentDetailResponseSchema, { item: null }).success).toBe(true)
  })

  it('validates paginated extension facets contracts', () => {
    expect(
      validatePayload(GetDocumentExtensionFacetsRequestSchema, { offset: 0, limit: 50 }).success
    ).toBe(true)
    expect(
      validatePayload(GetDocumentExtensionFacetsRequestSchema, { offset: 0, limit: 101 }).success
    ).toBe(false)
    expect(
      validatePayload(GetDocumentExtensionFacetsResponseSchema, {
        items: [{ extension: '.pdf', count: 5 }],
        totalCount: 1,
        offset: 0,
        limit: 50
      }).success
    ).toBe(true)
  })
})
