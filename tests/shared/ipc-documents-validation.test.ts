import { describe, expect, it } from 'vitest'
import {
  DocumentExtractionProgressSchema,
  ExtractSelectedDocumentsRequestSchema,
  GetDocumentPreviewRequestSchema,
  GetDocumentPreviewResponseSchema,
  GetDocumentsPageRequestSchema,
  GetDocumentsPageResponseSchema,
  GetDocumentDetailRequestSchema,
  GetDocumentDetailResponseSchema,
  GetDocumentExtensionFacetsRequestSchema,
  GetDocumentExtensionFacetsResponseSchema,
  StartDocumentExtractionRequestSchema,
  OcrModelStatusSchema,
  OcrSelectedDocumentsRequestSchema,
  StartDocumentOcrRequestSchema,
  DocumentOcrProgressSchema,
  GetDocumentOcrPreviewResponseSchema,
  isSupportedOcrImageExtension,
  ClassifySelectedDocumentsRequestSchema,
  StartDocumentClassificationRequestSchema,
  DocumentClassificationProgressSchema,
  SetDocumentClassificationOverrideRequestSchema,
  ResetDocumentClassificationOverrideRequestSchema,
  DocumentClassificationOverrideAckSchema,
  GetDocumentClassificationFacetsResponseSchema,
  DocSemanticSearchRequestSchema,
  DocSemanticSearchResponseSchema,
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
      previewStatus: 'not_extracted'
    }

    expect(
      validatePayload(GetDocumentsPageResponseSchema, {
        items: [sampleItem],
        totalCount: 1,
        offset: 0,
        limit: 50
      }).success
    ).toBe(true)

    // Validates all 9 Stage 7B extraction statuses and rejects unknown statuses
    for (const status of [
      'not_extracted',
      'processing',
      'extracted',
      'no_text_ocr_required',
      'password_protected',
      'unsupported',
      'corrupt_or_failed',
      'stale',
      'truncated'
    ]) {
      expect(
        validatePayload(GetDocumentsPageResponseSchema, {
          items: [{ ...sampleItem, extractionStatus: status }],
          totalCount: 1,
          offset: 0,
          limit: 50
        }).success
      ).toBe(true)
    }

    expect(
      validatePayload(GetDocumentsPageResponseSchema, {
        items: [{ ...sampleItem, extractionStatus: 'unknown_magic_status' }],
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

  it('validates Stage 7B preview and extraction request/progress schemas', () => {
    expect(validatePayload(GetDocumentPreviewRequestSchema, { fileLocationId: 1 }).success).toBe(
      true
    )
    expect(validatePayload(GetDocumentPreviewRequestSchema, { fileLocationId: -5 }).success).toBe(
      false
    )

    expect(
      validatePayload(GetDocumentPreviewResponseSchema, {
        preview: {
          fileLocationId: 1,
          extractionStatus: 'truncated',
          previewStatus: 'truncated',
          extractedText: 'Sample extracted text',
          extractedCharCount: 500_000,
          previewCharCount: 21,
          previewTruncated: true,
          extractionTruncated: true,
          truncationReason: 'Exceeded character limit',
          pageCount: 12,
          statusDetail: null,
          recipeVersion: 'doc_extract_v1',
          detectedEncoding: 'utf-8',
          extractedAtMs: 1_700_000_000_000,
          contentRevision: 'rev:1:100:100:abc'
        }
      }).success
    ).toBe(true)

    expect(
      validatePayload(ExtractSelectedDocumentsRequestSchema, {
        fileLocationIds: [1, 2],
        forceReextract: true
      }).success
    ).toBe(true)
    expect(
      validatePayload(ExtractSelectedDocumentsRequestSchema, { fileLocationIds: [] }).success
    ).toBe(false)

    expect(
      validatePayload(StartDocumentExtractionRequestSchema, {
        scope: 'filtered',
        extensionFilter: '.pdf',
        filenameQuery: 'tax'
      }).success
    ).toBe(true)

    expect(
      validatePayload(DocumentExtractionProgressSchema, {
        jobId: 'job-1',
        status: 'running',
        scopeKind: 'all',
        recipeVersion: 'doc_extract_v1',
        totalDocuments: 5,
        processedDocuments: 2,
        extractedDocuments: 1,
        noTextDocuments: 1,
        passwordProtectedDocuments: 0,
        unsupportedDocuments: 0,
        failedDocuments: 0,
        truncatedDocuments: 0,
        reusedDocuments: 0,
        pendingDocuments: 3,
        activeFileLocationId: 3,
        startedAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_001_000,
        completedAtMs: null,
        lastError: null,
        coverage: {
          totalDocuments: 5,
          notExtractedDocuments: 3,
          extractedDocuments: 1,
          noTextDocuments: 1,
          passwordProtectedDocuments: 0,
          unsupportedDocuments: 0,
          failedDocuments: 0,
          truncatedDocuments: 0,
          staleDocuments: 0
        }
      }).success
    ).toBe(true)
  })

  it('validates Stage 7C OCR model, scope, preview, and progress contracts', () => {
    expect(isSupportedOcrImageExtension('.png')).toBe(true)
    expect(isSupportedOcrImageExtension('JPG')).toBe(true)
    expect(isSupportedOcrImageExtension('.cr2')).toBe(false)

    expect(
      validatePayload(OcrModelStatusSchema, {
        state: 'ready',
        modelId: 'tesseract-ocr/tessdata_fast:eng@65727574',
        modelCommit: '65727574dfcd264acbb0c3e07860e4e9e9b22185',
        modelManifestSha256: 'a'.repeat(64),
        language: 'eng',
        enginePackage: 'tesseract.js-core@7.0.0',
        requiredBytes: 4_113_088,
        downloadedBytes: 4_113_088,
        currentArtifact: null,
        verifiedAtMs: 1_700_000_000_000,
        error: null,
        lastReplacementError: null
      }).success
    ).toBe(true)

    expect(
      validatePayload(OcrSelectedDocumentsRequestSchema, { fileLocationIds: [1, 2] }).success
    ).toBe(true)
    expect(
      validatePayload(OcrSelectedDocumentsRequestSchema, { fileLocationIds: [] }).success
    ).toBe(false)

    expect(validatePayload(StartDocumentOcrRequestSchema, {}).success).toBe(true)
    expect(validatePayload(StartDocumentOcrRequestSchema, { scope: 'ocr_needed' }).success).toBe(
      true
    )
    expect(validatePayload(StartDocumentOcrRequestSchema, { scope: 'photos' }).success).toBe(false)

    expect(
      validatePayload(DocumentOcrProgressSchema, {
        jobId: 'doc-ocr-1',
        status: 'running',
        scopeKind: 'ocr_needed',
        recipeVersion: 'doc_ocr_v1',
        ocrModelId: 'tesseract-ocr/tessdata_fast:eng@65727574',
        ocrModelManifestSha256: 'a'.repeat(64),
        ocrLanguage: 'eng',
        totalItems: 3,
        processedItems: 1,
        extractedItems: 1,
        noTextItems: 0,
        passwordProtectedItems: 0,
        unsupportedItems: 0,
        failedItems: 0,
        truncatedItems: 0,
        reusedItems: 0,
        skippedStaleItems: 0,
        pendingItems: 2,
        activeFileLocationId: 2,
        startedAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_001_000,
        completedAtMs: null,
        lastError: null,
        coverage: {
          totalDocuments: 5,
          ocrNeededDocuments: 2,
          notProcessedDocuments: 2,
          extractedDocuments: 1,
          noTextDocuments: 0,
          passwordProtectedDocuments: 0,
          unsupportedDocuments: 0,
          failedDocuments: 0,
          truncatedDocuments: 0,
          staleDocuments: 0,
          selectedImageOcrCount: 0
        },
        coverageReady: true,
        coverageRefreshing: false
      }).success
    ).toBe(true)

    expect(validatePayload(GetDocumentOcrPreviewResponseSchema, { preview: null }).success).toBe(
      true
    )
  })
})

describe('Stage 7E Slice 3 — Classification & Clutter IPC Zod Validation', () => {
  it('validates GetDocumentsPageRequestSchema and DocSemanticSearchRequestSchema classification filters', () => {
    expect(
      validatePayload(GetDocumentsPageRequestSchema, {
        offset: 0,
        limit: 50,
        purposeFilter: 'other',
        originFilter: 'personal',
        clutterFilter: 'hide_clutter'
      }).success
    ).toBe(true)

    expect(
      validatePayload(GetDocumentsPageRequestSchema, {
        offset: 0,
        limit: 50,
        purposeFilter: 'not_a_purpose'
      }).success
    ).toBe(false)

    expect(
      validatePayload(DocSemanticSearchRequestSchema, {
        query: 'lease agreement',
        purposeFilter: 'legal',
        originFilter: 'unknown',
        clutterFilter: 'only_clutter'
      }).success
    ).toBe(true)

    expect(
      validatePayload(DocSemanticSearchRequestSchema, {
        query: 'lease',
        clutterFilter: 'invalid_clutter_mode'
      }).success
    ).toBe(false)

    expect(
      validatePayload(DocSemanticSearchResponseSchema, {
        items: [],
        totalMatched: 0,
        hasMore: false,
        eligibleChunkCount: 0,
        corruptChunkCount: 0,
        queryTokenCount: 2,
        queryTruncated: false,
        queryLatencyMs: 1.5,
        clutterFilterActive: true,
        coverage: {
          totalExtractableTracks: 0,
          totalDocumentsWithText: 0,
          indexedTracks: 0,
          truncatedTracks: 0,
          emptyTextTracks: 0,
          failedTracks: 0,
          unindexedTracks: 0,
          staleTracks: 0,
          corruptChunks: 0,
          indexedDocuments: 0
        }
      }).success
    ).toBe(true)
  })

  it('validates classification requests, progress, facets, and override acks including persistencePending & conflict', () => {
    expect(
      validatePayload(ClassifySelectedDocumentsRequestSchema, {
        fileLocationIds: [1, 2],
        forceReclassify: true
      }).success
    ).toBe(true)
    expect(
      validatePayload(ClassifySelectedDocumentsRequestSchema, { fileLocationIds: [] }).success
    ).toBe(false)

    expect(
      validatePayload(StartDocumentClassificationRequestSchema, {
        scope: 'unclassified_or_stale'
      }).success
    ).toBe(true)

    expect(
      validatePayload(DocumentClassificationProgressSchema, {
        jobId: 'cls-1',
        status: 'completed',
        scopeKind: 'all',
        ruleVersion: 'doc_classify_rules_v1',
        totalItems: 10,
        processedItems: 10,
        classifiedItems: 6,
        otherItems: 3,
        unknownItems: 1,
        clutterItems: 2,
        reusedItems: 0,
        skippedStaleItems: 0,
        failedItems: 0,
        pendingItems: 0,
        activeFileLocationId: null,
        startedAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_001_000,
        completedAtMs: 1_700_000_001_000,
        lastError: null,
        coverage: {
          totalDocuments: 10,
          classifiedDocuments: 6,
          otherDocuments: 3,
          unknownDocuments: 1,
          unclassifiedDocuments: 0,
          staleDocuments: 0,
          hiddenClutterCount: 2,
          overriddenDocuments: 1
        },
        coverageReady: true,
        coverageRefreshing: false
      }).success
    ).toBe(true)

    expect(
      validatePayload(SetDocumentClassificationOverrideRequestSchema, {
        fileLocationId: 1,
        expectedRevision: 'rev-1',
        expectedOverrideVersion: 0,
        purposeLabels: ['legal'],
        originLabels: ['personal'],
        clutterOverride: 'force_keep'
      }).success
    ).toBe(true)

    expect(
      validatePayload(ResetDocumentClassificationOverrideRequestSchema, {
        fileLocationId: 1,
        expectedRevision: 'rev-1',
        expectedOverrideVersion: 1
      }).success
    ).toBe(true)

    expect(
      validatePayload(DocumentClassificationOverrideAckSchema, {
        ok: true,
        persistencePending: true,
        persistenceError: 'DISK_IO_AFTER_COMMIT',
        effectiveClassification: null
      }).success
    ).toBe(true)

    expect(
      validatePayload(DocumentClassificationOverrideAckSchema, {
        ok: false,
        conflict: 'STALE_OVERRIDE_VERSION',
        errorMessage: 'Expected version 0, current 1',
        persistencePending: false,
        effectiveClassification: null
      }).success
    ).toBe(true)

    expect(
      validatePayload(GetDocumentClassificationFacetsResponseSchema, {
        purposeCounts: {
          legal: 1,
          lists: 2,
          instructions: 0,
          receipts: 1,
          recipes: 0,
          other: 3,
          unknown: 1
        },
        originCounts: {
          personal: 4,
          software_project: 1,
          application_system: 1,
          unknown: 2
        },
        clutterCount: 2,
        totalDocuments: 8,
        overriddenCount: 1
      }).success
    ).toBe(true)
  })
})
