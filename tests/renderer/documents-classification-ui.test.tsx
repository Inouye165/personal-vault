// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentsPanel } from '../../src/renderer/src/components/DocumentsPanel'

function makeClsSummary(overrides: Record<string, unknown> = {}) {
  return {
    isClassified: true,
    isStale: false,
    machineRuleVersion: 'doc_classify_rules_v1',
    machineTextSourceKind: 'native',
    machinePurposeStatus: 'classified',
    machineOriginStatus: 'classified',
    machinePurposeLabels: ['receipts'],
    machineOriginLabels: ['personal'],
    confidenceBand: 'high',
    uncertaintyReason: null,
    uncertaintyReasons: [],
    isClutterCandidate: false,
    hasPersonalVeto: false,
    effectivePurposeStatus: 'classified',
    effectiveOriginStatus: 'classified',
    effectivePurposeLabels: ['receipts'],
    effectiveOriginLabels: ['personal'],
    effectiveIsClutter: false,
    hasOverride: false,
    hasStaleOverride: false,
    hasUnverifiedOverride: false,
    clutterOverride: 'inherit',
    overrideVersion: 0,
    contentRevision: 'rev-1',
    evidence: [],
    ...overrides
  }
}

function makeDocItem(id: number, fileName: string, clsOverrides: Record<string, unknown> = {}) {
  return {
    fileLocationId: id,
    sourceId: 1,
    fileName,
    extension: '.txt',
    originalPath: `D:\\docs\\${fileName}`,
    byteSize: 256,
    filesystemBirthtimeMs: null,
    filesystemMtimeMs: 1_700_000_000_000,
    firstDiscoveredAtMs: 1_700_000_001_000,
    lastSeenAtMs: 1_700_000_002_000,
    discoveryObservationId: 10,
    activeHash: 'a'.repeat(64),
    activeHashVerifiedAtMs: 1_700_000_002_000,
    extractionStatus: 'extracted',
    previewStatus: 'ready',
    classification: makeClsSummary(clsOverrides)
  }
}

describe('Stage 7E Slice 3 — DocumentsPanel Classification & Clutter Filter UI', () => {
  const originalApi = window.api

  beforeEach(() => {
    window.api = {
      getDocumentsPage: vi.fn().mockResolvedValue({
        items: [
          makeDocItem(1, 'grocery_receipt.txt'),
          makeDocItem(2, 'THIRD_PARTY_NOTICES.md', {
            machinePurposeLabels: ['legal'],
            machineOriginLabels: ['software_project'],
            effectivePurposeLabels: ['legal'],
            effectiveOriginLabels: ['software_project'],
            isClutterCandidate: true,
            effectiveIsClutter: true
          }),
          makeDocItem(3, 'summer_note.txt', {
            machinePurposeStatus: 'other',
            machinePurposeLabels: [],
            effectivePurposeStatus: 'other',
            effectivePurposeLabels: [],
            machineOriginStatus: 'unknown',
            machineOriginLabels: [],
            effectiveOriginStatus: 'unknown',
            effectiveOriginLabels: []
          }),
          makeDocItem(4, 'scan_pending.pdf', {
            isClassified: false,
            machineRuleVersion: null,
            machineTextSourceKind: null,
            machinePurposeStatus: 'unknown',
            machinePurposeLabels: [],
            effectivePurposeStatus: 'unknown',
            effectivePurposeLabels: [],
            machineOriginStatus: 'unknown',
            machineOriginLabels: [],
            effectiveOriginStatus: 'unknown',
            effectiveOriginLabels: [],
            confidenceBand: 'low',
            uncertaintyReason: 'no_extracted_text',
            uncertaintyReasons: ['no_extracted_text']
          })
        ],
        totalCount: 4,
        offset: 0,
        limit: 50,
        hiddenClutterCount: 1
      }),
      getDocumentDetail: vi.fn().mockResolvedValue({
        item: {
          ...makeDocItem(2, 'THIRD_PARTY_NOTICES.md', {
            machinePurposeLabels: ['legal'],
            machineOriginLabels: ['software_project'],
            effectivePurposeLabels: ['legal'],
            effectiveOriginLabels: ['software_project'],
            isClutterCandidate: true,
            effectiveIsClutter: true,
            uncertaintyReasons: ['truncated_input'],
            evidence: [
              {
                axis: 'origin',
                targetLabel: 'software_project',
                family: 'spdx',
                ruleId: 'spdx_header',
                weight: 1,
                summary: 'Matched SPDX-License-Identifier'
              }
            ]
          }),
          sourceRootPath: 'D:\\docs',
          normalizedPath: 'd:/docs/third_party_notices.md'
        }
      }),
      getDocumentExtensionFacets: vi.fn().mockResolvedValue({
        items: [{ extension: '.txt', count: 4 }],
        totalCount: 1,
        offset: 0,
        limit: 50
      }),
      getDocumentPreview: vi.fn().mockResolvedValue({ preview: null }),
      getDocumentExtractionProgress: vi.fn().mockResolvedValue(null),
      onDocumentExtractionProgress: vi.fn().mockReturnValue(() => {}),
      getOcrModelStatus: vi.fn().mockResolvedValue(null),
      onOcrModelStatus: vi.fn().mockReturnValue(() => {}),
      getDocumentOcrProgress: vi.fn().mockResolvedValue(null),
      onDocumentOcrProgress: vi.fn().mockReturnValue(() => {}),
      getDocumentOcrState: vi.fn().mockResolvedValue({ state: null }),
      getDocumentOcrPreview: vi.fn().mockResolvedValue({ preview: null }),
      getDocSemanticModelStatus: vi.fn().mockResolvedValue(null),
      getDocumentSemanticProgress: vi.fn().mockResolvedValue(null),
      searchDocumentsSemantic: vi.fn().mockResolvedValue({
        items: [],
        totalMatched: 0,
        hasMore: false,
        eligibleChunkCount: 0,
        corruptChunkCount: 0,
        queryTokenCount: 1,
        queryTruncated: false,
        queryLatencyMs: 2.0,
        clutterFilterActive: true,
        coverage: {
          totalDocuments: 4,
          indexedDocuments: 4,
          indexedTracks: 4,
          truncatedTracks: 0,
          emptyTextTracks: 0,
          failedTracks: 0,
          staleTracks: 0,
          unindexedTracks: 0
        }
      }),
      cancelDocumentSemanticSearch: vi.fn().mockResolvedValue({ cancelled: true }),
      getDocumentClassificationProgress: vi.fn().mockResolvedValue({
        jobId: null,
        status: 'idle',
        scopeKind: null,
        ruleVersion: 'doc_classify_rules_v1',
        totalItems: 0,
        processedItems: 0,
        classifiedItems: 0,
        otherItems: 0,
        unknownItems: 0,
        clutterItems: 0,
        reusedItems: 0,
        skippedStaleItems: 0,
        failedItems: 0,
        pendingItems: 0,
        activeFileLocationId: null,
        startedAtMs: null,
        updatedAtMs: null,
        completedAtMs: null,
        lastError: null,
        coverage: {
          totalDocuments: 4,
          classifiedDocuments: 2,
          otherDocuments: 1,
          unknownDocuments: 0,
          unclassifiedDocuments: 1,
          staleDocuments: 0,
          hiddenClutterCount: 1,
          overriddenDocuments: 0
        },
        coverageReady: true,
        coverageRefreshing: false
      }),
      onDocumentClassificationProgress: vi.fn().mockReturnValue(() => {}),
      startDocumentClassification: vi.fn().mockResolvedValue({}),
      classifySelectedDocuments: vi.fn().mockResolvedValue({}),
      setDocumentClassificationOverride: vi.fn().mockResolvedValue({
        ok: true,
        persistencePending: true,
        persistenceError: 'JOURNAL_COMMIT_PENDING',
        effectiveClassification: makeClsSummary({
          hasOverride: true,
          clutterOverride: 'force_keep',
          effectiveIsClutter: false,
          overrideVersion: 1
        })
      }),
      resetDocumentClassificationOverride: vi.fn().mockResolvedValue({
        ok: true,
        persistencePending: false,
        effectiveClassification: makeClsSummary()
      }),
      getDocumentClassificationFacets: vi.fn().mockResolvedValue({
        purposeCounts: {
          legal: 1,
          lists: 0,
          instructions: 0,
          receipts: 1,
          recipes: 0,
          other: 1,
          unknown: 1
        },
        originCounts: {
          personal: 1,
          software_project: 1,
          application_system: 0,
          unknown: 2
        },
        clutterCount: 1,
        totalDocuments: 4,
        overriddenCount: 0
      })
    } as unknown as Window['api']
  })

  afterEach(() => {
    window.api = originalApi
  })

  it('defaults clutter filter to show_all, distinguishes Other vs Unknown, and shows scoped hidden banner on opt-in hide_clutter', async () => {
    render(<DocumentsPanel />)

    await waitFor(() => {
      expect(screen.getByText('grocery_receipt.txt')).toBeTruthy()
      expect(screen.getByText('THIRD_PARTY_NOTICES.md')).toBeTruthy()
    })

    // Default clutter filter is show_all
    const clutterSelect = screen.getByTestId('documents-clutter-filter') as HTMLSelectElement
    expect(clutterSelect.value).toBe('show_all')

    // Distinct Other vs Unknown labels
    expect(screen.getByTestId('document-purpose-3').textContent).toBe('Other / No structured match')
    expect(screen.getByTestId('document-purpose-4').textContent).toBe(
      'Unclassified / Needs text extraction or OCR'
    )

    // Opt-in hide_clutter shows scoped hidden banner with Show all & Inspect hidden (1)
    fireEvent.change(clutterSelect, { target: { value: 'hide_clutter' } })
    await waitFor(() => {
      expect(screen.getByTestId('documents-hidden-clutter-banner')).toBeTruthy()
      expect(screen.getByTestId('documents-show-all-btn')).toBeTruthy()
      expect(screen.getByTestId('documents-inspect-hidden-btn').textContent).toContain(
        'Inspect hidden (1)'
      )
    })

    // Clicking Inspect hidden switches to only_clutter
    fireEvent.click(screen.getByTestId('documents-inspect-hidden-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('documents-inspect-hidden-banner')).toBeTruthy()
    })
  })

  it('displays provenance, uncertainty, and truthful persistencePending feedback on override', async () => {
    render(<DocumentsPanel />)

    await waitFor(() => {
      expect(screen.getByText('THIRD_PARTY_NOTICES.md')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('THIRD_PARTY_NOTICES.md').closest('button')!)

    await waitFor(() => {
      expect(screen.getByTestId('document-classification-section')).toBeTruthy()
      expect(screen.getByTestId('doc-classify-provenance-meta').textContent).toContain(
        'doc_classify_rules_v1'
      )
      expect(screen.getByTestId('doc-classify-uncertainty').textContent).toContain(
        'truncated_input'
      )
      expect(screen.getByTestId('doc-classify-evidence-list').textContent).toContain('spdx_header')
    })

    // Click "Not clutter — Always show" -> shows truthful persistencePending notice
    fireEvent.click(screen.getByTestId('doc-classify-not-clutter-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('doc-classify-override-notice').textContent).toContain(
        'portable journal commit is pending recovery'
      )
    })

    // Conflict handling: mock STALE_OVERRIDE_VERSION ack
    ;(
      window.api.setDocumentClassificationOverride as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      ok: false,
      conflict: 'STALE_OVERRIDE_VERSION',
      errorMessage: 'Expected 0, current 1',
      persistencePending: false,
      effectiveClassification: makeClsSummary({ overrideVersion: 1 })
    })
    fireEvent.click(screen.getByTestId('doc-classify-not-clutter-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('doc-classify-override-notice').textContent).toContain(
        'Refreshed to latest state'
      )
    })
  })
})
