// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentsPanel } from '../../src/renderer/src/components/DocumentsPanel'

function makeBaseDocSemanticProgress(overrides: Record<string, unknown> = {}) {
  return {
    jobId: null,
    status: 'idle',
    scopeKind: null,
    docModelId: 'Xenova/bge-small-en-v1.5',
    docModelCommit: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
    docModelManifestSha256: 'a'.repeat(64),
    chunkingRecipeVersion: 'doc_tok_chunk_v1',
    totalItems: 0,
    processedItems: 0,
    indexedItems: 0,
    truncatedItems: 0,
    emptyTextItems: 0,
    failedItems: 0,
    reusedItems: 0,
    skippedStaleItems: 0,
    pendingItems: 0,
    activeFileLocationId: null,
    activeTextSourceKind: null,
    startedAtMs: null,
    updatedAtMs: null,
    completedAtMs: null,
    lastError: null,
    coverage: {
      totalExtractableTracks: 2,
      totalDocumentsWithText: 2,
      indexedTracks: 2,
      truncatedTracks: 1,
      emptyTextTracks: 0,
      failedTracks: 0,
      unindexedTracks: 0,
      staleTracks: 0,
      corruptChunks: 0,
      indexedDocuments: 2
    },
    coverageReady: true,
    coverageRefreshing: false,
    ...overrides
  }
}

describe('Stage 7D Slice 3 — DocumentsPanel Semantic Search & Indexing UI', () => {
  const originalApi = window.api

  beforeEach(() => {
    window.api = {
      getDocumentsPage: vi.fn().mockResolvedValue({
        items: [],
        totalCount: 0,
        offset: 0,
        limit: 50
      }),
      getDocumentDetail: vi.fn().mockResolvedValue({ item: null }),
      getDocumentExtensionFacets: vi.fn().mockResolvedValue({
        items: [],
        totalCount: 0
      }),
      getDocumentPreview: vi.fn().mockResolvedValue({ preview: null }),
      getDocumentExtractionProgress: vi.fn().mockResolvedValue(null),
      onDocumentExtractionProgress: vi.fn().mockReturnValue(() => {}),
      getOcrModelStatus: vi.fn().mockResolvedValue({
        state: 'unprovisioned',
        modelId: 'tesseract-fast-eng',
        modelManifestSha256: 'b'.repeat(64),
        language: 'eng',
        requiredBytes: 4113088,
        downloadedBytes: 0,
        currentArtifact: null,
        errorMessage: null
      }),
      onOcrModelStatus: vi.fn().mockReturnValue(() => {}),
      getDocumentOcrProgress: vi.fn().mockResolvedValue(null),
      onDocumentOcrProgress: vi.fn().mockReturnValue(() => {}),
      getDocSemanticModelStatus: vi.fn().mockResolvedValue({
        state: 'ready',
        modelId: 'Xenova/bge-small-en-v1.5',
        modelCommit: 'ea104dac',
        manifestSha256: 'a'.repeat(64),
        totalBytes: 34726996,
        downloadedBytes: 34726996,
        currentFile: null,
        installDir: 'C:\\temp\\models',
        errorCode: null,
        errorMessage: null,
        updatedAtMs: 1000
      }),
      downloadDocSemanticModel: vi.fn(),
      importDocSemanticModel: vi.fn(),
      cancelDocSemanticModel: vi.fn(),
      indexSelectedDocuments: vi.fn(),
      startDocumentSemanticIndexing: vi
        .fn()
        .mockResolvedValue(
          makeBaseDocSemanticProgress({ status: 'completed', totalItems: 2, processedItems: 2 })
        ),
      pauseDocumentSemanticIndexing: vi.fn(),
      resumeDocumentSemanticIndexing: vi.fn(),
      cancelDocumentSemanticIndexing: vi.fn(),
      getDocumentSemanticProgress: vi.fn().mockResolvedValue(makeBaseDocSemanticProgress()),
      searchDocumentsSemantic: vi.fn(),
      cancelDocumentSemanticSearch: vi.fn().mockResolvedValue({ cancelled: true })
    } as unknown as typeof window.api
  })

  afterEach(() => {
    window.api = originalApi
  })

  it('renders inert winning-chunk snippet, native vs OCR provenance, partial-index notice, and discards stale responses on rapid query replacement', async () => {
    const slowFirst: { resolve: ((val: unknown) => void) | null } = { resolve: null }
    const searchMock = window.api.searchDocumentsSemantic as ReturnType<typeof vi.fn>
    searchMock
      .mockImplementationOnce(
        () =>
          new Promise((resolvePromise) => {
            slowFirst.resolve = resolvePromise
          })
      )
      .mockResolvedValueOnce({
        items: [
          {
            fileLocationId: 10,
            score: 0.91,
            winningChunkId: 1,
            winningChunkIndex: 0,
            textSourceKind: 'ocr',
            charOffsetStart: 0,
            charOffsetEnd: 48,
            truncated: true,
            normalizedCharCount: 200000,
            indexedCharCount: 100000,
            coverageRatio: 0.5,
            originalPath: 'D:\\docs\\scanned-receipt.pdf',
            fileName: 'scanned-receipt.pdf',
            extension: '.pdf',
            winningSnippet: '<script>alert("xss")</script> Total due $1,250'
          },
          {
            fileLocationId: 20,
            score: 0.72,
            winningChunkId: 2,
            winningChunkIndex: 0,
            textSourceKind: 'native',
            charOffsetStart: 0,
            charOffsetEnd: 24,
            truncated: false,
            normalizedCharCount: 24,
            indexedCharCount: 24,
            coverageRatio: 1,
            originalPath: 'D:\\docs\\lease.txt',
            fileName: 'lease.txt',
            extension: '.txt',
            winningSnippet: 'Monthly rent is $2,400.'
          }
        ],
        totalMatched: 2,
        hasMore: false,
        eligibleChunkCount: 2,
        corruptChunkCount: 0,
        queryTokenCount: 5,
        queryTruncated: false,
        queryLatencyMs: 12.4,
        coverage: makeBaseDocSemanticProgress().coverage
      })

    render(<DocumentsPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('doc-semantic-model-state-badge').textContent).toBe('ready')
    })
    expect(screen.getByTestId('doc-semantic-coverage').textContent).toContain('1 partial')

    const input = screen.getByTestId('doc-semantic-search-input')
    const form = screen.getByTestId('doc-semantic-search-form')

    // First slow query
    fireEvent.change(input, { target: { value: 'stale query' } })
    fireEvent.submit(form)

    // Rapid second query before first resolves
    fireEvent.change(input, { target: { value: 'invoice' } })
    fireEvent.submit(form)

    await waitFor(() => {
      expect(screen.getByTestId('doc-semantic-result-10')).toBeTruthy()
    })

    // Resolve stale first query late — must NOT overwrite newer results!
    slowFirst.resolve?.({
      items: [
        {
          fileLocationId: 999,
          score: 0.5,
          winningChunkId: 999,
          winningChunkIndex: 0,
          textSourceKind: 'native',
          charOffsetStart: 0,
          charOffsetEnd: 10,
          truncated: false,
          normalizedCharCount: 10,
          indexedCharCount: 10,
          coverageRatio: 1,
          originalPath: 'D:\\docs\\stale.txt',
          fileName: 'stale.txt',
          extension: '.txt',
          winningSnippet: 'STALE RESULT'
        }
      ],
      totalMatched: 1,
      hasMore: false,
      eligibleChunkCount: 1,
      corruptChunkCount: 0,
      queryTokenCount: 2,
      queryTruncated: false,
      queryLatencyMs: 100,
      coverage: makeBaseDocSemanticProgress().coverage
    })

    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('doc-semantic-result-999')).toBeNull()

    // Check provenance, partial-index disclosure, and inert <pre> snippet
    const ocrCard = screen.getByTestId('doc-semantic-result-10')
    expect(ocrCard.textContent).toContain('OCR text (machine-recognized)')
    expect(ocrCard.textContent).toContain('Partially indexed: first 100,000 of 200,000 chars (50%)')
    const preEl = ocrCard.querySelector('pre.doc-semantic-snippet')
    expect(preEl?.textContent).toContain('<script>alert("xss")</script>')
    expect(ocrCard.querySelector('script')).toBeNull()

    const nativeCard = screen.getByTestId('doc-semantic-result-20')
    expect(nativeCard.textContent).toContain('Native text')
  })

  it('shows empty and error states cleanly and supports clear', async () => {
    const searchMock = window.api.searchDocumentsSemantic as ReturnType<typeof vi.fn>
    searchMock.mockRejectedValueOnce(new Error('Search worker timed out')).mockResolvedValueOnce({
      items: [],
      totalMatched: 0,
      hasMore: false,
      eligibleChunkCount: 0,
      corruptChunkCount: 0,
      queryTokenCount: 3,
      queryTruncated: false,
      queryLatencyMs: 2.1,
      coverage: makeBaseDocSemanticProgress().coverage
    })

    render(<DocumentsPanel />)
    await waitFor(() => {
      expect(screen.getByTestId('doc-semantic-model-state-badge').textContent).toBe('ready')
    })

    const input = screen.getByTestId('doc-semantic-search-input')
    const form = screen.getByTestId('doc-semantic-search-form')

    fireEvent.change(input, { target: { value: 'boom' } })
    fireEvent.submit(form)
    await waitFor(() => {
      expect(screen.getByTestId('doc-semantic-search-error').textContent).toContain(
        'Search worker timed out'
      )
    })

    fireEvent.change(input, { target: { value: 'nonexistent' } })
    fireEvent.submit(form)
    await waitFor(() => {
      expect(screen.getByTestId('doc-semantic-search-empty')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('doc-semantic-search-clear-btn'))
    expect(screen.queryByTestId('doc-semantic-search-results')).toBeNull()
  })
})
