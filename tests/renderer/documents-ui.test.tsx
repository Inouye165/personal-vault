import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { DocumentsPanel } from '../../src/renderer/src/components/DocumentsPanel'
import { PhotoSelectedOcrSection } from '../../src/renderer/src/components/PhotoSelectedOcrSection'
import type {
  DocumentDetailItem,
  DocumentSummaryItem
} from '../../src/shared/validation/document-schemas'

function makeDoc(overrides: Partial<DocumentSummaryItem> = {}): DocumentSummaryItem {
  return {
    fileLocationId: 1,
    sourceId: 1,
    fileName: 'tax_receipt_2025.pdf',
    extension: '.pdf',
    originalPath: 'D:\\docs\\tax_receipt_2025.pdf',
    byteSize: 2048,
    filesystemBirthtimeMs: null,
    filesystemMtimeMs: 1_700_000_000_000,
    firstDiscoveredAtMs: 1_700_000_001_000,
    lastSeenAtMs: 1_700_000_002_000,
    discoveryObservationId: 11,
    activeHash: null,
    activeHashVerifiedAtMs: null,
    extractionStatus: 'not_extracted',
    previewStatus: 'not_extracted',
    ...overrides
  }
}

describe('Stage 7A — DocumentsPanel UI', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders already-cataloged documents with honest Not extracted yet status and upcoming Stage 7 notice', async () => {
    const doc1 = makeDoc()
    const detail1: DocumentDetailItem = {
      ...doc1,
      sourceRootPath: 'D:\\docs',
      normalizedPath: 'd:\\docs\\tax_receipt_2025.pdf'
    }

    const getDocumentsPage = vi.fn().mockResolvedValue({
      items: [doc1],
      totalCount: 1,
      offset: 0,
      limit: 50
    })
    const getDocumentDetail = vi.fn().mockResolvedValue({ item: detail1 })
    const getDocumentExtensionFacets = vi.fn().mockResolvedValue({
      items: [{ extension: '.pdf', count: 1 }],
      totalCount: 1,
      offset: 0,
      limit: 50
    })

    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getDocumentsPage,
      getDocumentDetail,
      getDocumentExtensionFacets
    }

    render(<DocumentsPanel />)

    await waitFor(() => {
      expect(screen.getByText('tax_receipt_2025.pdf')).toBeInTheDocument()
    })
    expect(screen.getByText('Not extracted')).toBeInTheDocument()
    expect(screen.getByText(/no rescan required/i)).toBeInTheDocument()
    expect(screen.getByText(/local read-only text extraction supports/i)).toBeInTheDocument()

    // Select document and verify detail drawer shows explicit Unknown and provenance
    fireEvent.click(screen.getByRole('button', { name: /tax_receipt_2025\.pdf/i }))
    await waitFor(() => {
      expect(screen.getByText('D:\\docs')).toBeInTheDocument()
    })
    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('#11')).toBeInTheDocument()
  })

  it('renders inert Extracted text preview, truncation banner, and explicit Extract Text controls', async () => {
    const doc1 = makeDoc({
      fileLocationId: 10,
      fileName: 'notes.md',
      extension: '.md',
      extractionStatus: 'truncated',
      previewStatus: 'truncated',
      extractedCharCount: 500_000,
      extractionTruncated: true
    })
    const detail1: DocumentDetailItem = {
      ...doc1,
      sourceRootPath: 'D:\\docs',
      normalizedPath: 'd:\\docs\\notes.md',
      recipeVersion: 'doc_extract_v1',
      extractedAtMs: 1_700_000_005_000,
      truncationReason: 'Extracted text exceeded 500000 character limit',
      detectedEncoding: 'utf-8'
    }

    const extractSelectedDocuments = vi.fn().mockResolvedValue({
      jobId: 'j1',
      status: 'completed',
      scopeKind: 'selected',
      recipeVersion: 'doc_extract_v1',
      totalDocuments: 1,
      processedDocuments: 1,
      extractedDocuments: 1,
      noTextDocuments: 0,
      passwordProtectedDocuments: 0,
      unsupportedDocuments: 0,
      failedDocuments: 0,
      truncatedDocuments: 0,
      reusedDocuments: 0,
      pendingDocuments: 0,
      activeFileLocationId: null,
      startedAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_001_000,
      completedAtMs: 1_700_000_001_000,
      lastError: null,
      coverage: {
        totalDocuments: 1,
        notExtractedDocuments: 0,
        extractedDocuments: 0,
        noTextDocuments: 0,
        passwordProtectedDocuments: 0,
        unsupportedDocuments: 0,
        failedDocuments: 0,
        truncatedDocuments: 1,
        staleDocuments: 0
      }
    })

    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getDocumentsPage: vi.fn().mockResolvedValue({
        items: [doc1],
        totalCount: 1,
        offset: 0,
        limit: 50
      }),
      getDocumentDetail: vi.fn().mockResolvedValue({ item: detail1 }),
      getDocumentPreview: vi.fn().mockResolvedValue({
        preview: {
          fileLocationId: 10,
          extractionStatus: 'truncated',
          previewStatus: 'truncated',
          extractedText: '<script>alert(1)</script>\n\n# Heading\nRow1\tRow2',
          extractedCharCount: 500_000,
          previewCharCount: 44,
          previewTruncated: false,
          extractionTruncated: true,
          truncationReason: 'Extracted text exceeded 500000 character limit',
          pageCount: null,
          statusDetail: null,
          recipeVersion: 'doc_extract_v1',
          detectedEncoding: 'utf-8',
          extractedAtMs: 1_700_000_005_000,
          contentRevision: 'rev:11:2048:1700000000000:unhashed'
        }
      }),
      getDocumentExtensionFacets: vi.fn().mockResolvedValue({
        items: [{ extension: '.md', count: 1 }],
        totalCount: 1,
        offset: 0,
        limit: 50
      }),
      extractSelectedDocuments
    }

    render(<DocumentsPanel />)
    await waitFor(() => expect(screen.getByText('notes.md')).toBeInTheDocument())
    expect(screen.getByTestId('document-status-10')).toHaveTextContent('Truncated')

    fireEvent.click(screen.getByRole('button', { name: /notes\.md/i }))
    await waitFor(() => {
      expect(screen.getByTestId('document-extracted-text-preview')).toBeInTheDocument()
    })

    // Rendered as inert text inside <pre>, never executed or parsed as HTML
    const pre = screen.getByTestId('document-extracted-text-preview')
    expect(pre.tagName).toBe('PRE')
    expect(pre.textContent).toContain('<script>alert(1)</script>')
    expect(screen.getByTestId('document-preview-truncated-notice')).toHaveTextContent(
      'Extracted text exceeded 500000 character limit'
    )

    fireEvent.click(screen.getByTestId('document-extract-selected-btn'))
    await waitFor(() => {
      expect(extractSelectedDocuments).toHaveBeenCalledWith({
        fileLocationIds: [10],
        forceReextract: true
      })
    })
  })

  it('guards against stale detail responses when switching selection rapidly', async () => {
    const doc1 = makeDoc({ fileLocationId: 1, fileName: 'first.txt', extension: '.txt' })
    const doc2 = makeDoc({ fileLocationId: 2, fileName: 'second.md', extension: '.md' })

    let resolveFirst!: (val: { item: DocumentDetailItem }) => void
    const firstPromise = new Promise<{ item: DocumentDetailItem }>((r) => {
      resolveFirst = r
    })

    const getDocumentDetail = vi
      .fn()
      .mockImplementationOnce(() => firstPromise)
      .mockResolvedValueOnce({
        item: {
          ...doc2,
          sourceRootPath: 'D:\\docs',
          normalizedPath: 'd:\\docs\\second.md'
        }
      })

    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getDocumentsPage: vi.fn().mockResolvedValue({
        items: [doc1, doc2],
        totalCount: 2,
        offset: 0,
        limit: 50
      }),
      getDocumentDetail,
      getDocumentExtensionFacets: vi.fn().mockResolvedValue({
        items: [
          { extension: '.txt', count: 1 },
          { extension: '.md', count: 1 }
        ],
        totalCount: 2,
        offset: 0,
        limit: 50
      })
    }

    render(<DocumentsPanel />)
    await waitFor(() => expect(screen.getByText('first.txt')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /first\.txt/i }))
    fireEvent.click(screen.getByRole('button', { name: /second\.md/i }))

    await waitFor(() => {
      expect(screen.getByTestId('document-detail-filename')).toHaveTextContent('second.md')
    })

    // Resolve stale first request after second already won
    resolveFirst({
      item: {
        ...doc1,
        sourceRootPath: 'D:\\docs',
        normalizedPath: 'd:\\docs\\first.txt'
      }
    })
    await Promise.resolve()

    expect(screen.getByTestId('document-detail-filename')).toHaveTextContent('second.md')
  })

  it('shows confirmed empty state and error state honestly', async () => {
    const getDocumentsPage = vi
      .fn()
      .mockRejectedValueOnce(new Error('Catalog read failed'))
      .mockResolvedValueOnce({
        items: [],
        totalCount: 0,
        offset: 0,
        limit: 50
      })

    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getDocumentsPage,
      getDocumentDetail: vi.fn(),
      getDocumentExtensionFacets: vi.fn().mockResolvedValue({
        items: [],
        totalCount: 0,
        offset: 0,
        limit: 50
      })
    }

    render(<DocumentsPanel />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Catalog read failed')
    })

    fireEvent.click(screen.getByRole('button', { name: /Retry/i }))

    await waitFor(() => {
      expect(screen.getByText(/No documents have been cataloged yet/i)).toBeInTheDocument()
    })
  })

  it('supports extension facet pagination and narrow-viewport modal Escape close', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('max-width: 900px'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))

    const doc1 = makeDoc({ fileLocationId: 1, fileName: 'readme.md', extension: '.md' })
    const getDocumentExtensionFacets = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ extension: '.md', count: 1 }],
        totalCount: 2,
        offset: 0,
        limit: 50
      })
      .mockResolvedValueOnce({
        items: [{ extension: '.pdf', count: 3 }],
        totalCount: 2,
        offset: 1,
        limit: 50
      })

    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getDocumentsPage: vi.fn().mockResolvedValue({
        items: [doc1],
        totalCount: 1,
        offset: 0,
        limit: 50
      }),
      getDocumentDetail: vi.fn().mockResolvedValue({
        item: {
          ...doc1,
          sourceRootPath: 'D:\\docs',
          normalizedPath: 'd:\\docs\\readme.md'
        }
      }),
      getDocumentExtensionFacets
    }

    render(<DocumentsPanel />)
    await waitFor(() => expect(screen.getByText('readme.md')).toBeInTheDocument())

    const moreBtn = screen.getByRole('button', { name: /More extensions \(1\/2\)/i })
    fireEvent.click(moreBtn)
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /\.pdf \(3\)/i })).toBeInTheDocument()
    })

    // Open modal detail drawer and press Escape to close
    fireEvent.click(screen.getByRole('button', { name: /readme\.md/i }))
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Document Details/i })).toBeInTheDocument()
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Document Details/i })).not.toBeInTheDocument()
    })
  })

  it('hides the unused global Header search input on Documents and wires the visible filename filter to getDocumentsPage', async () => {
    const doc1 = makeDoc({ fileLocationId: 1, fileName: 'tax_receipt_2025.pdf', extension: '.pdf' })
    const getDocumentsPage = vi.fn().mockResolvedValue({
      items: [doc1],
      totalCount: 1,
      offset: 0,
      limit: 50
    })
    const getDocumentDetail = vi.fn().mockResolvedValue({
      item: {
        ...doc1,
        sourceRootPath: 'D:\\docs',
        normalizedPath: 'd:\\docs\\tax_receipt_2025.pdf'
      }
    })
    const getDocumentExtensionFacets = vi.fn().mockResolvedValue({
      items: [{ extension: '.pdf', count: 1 }],
      totalCount: 1,
      offset: 0,
      limit: 50
    })

    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getAppInfo: vi.fn(async () => ({
        name: 'Personal Vault',
        version: '0.1.0',
        platform: 'win32',
        isPackaged: false
      })),
      getVaultStatus: vi.fn(async () => ({ sourceCount: 1, itemCount: 1, isReady: true })),
      setTab: vi.fn(async () => true),
      getActiveScanJob: vi.fn(async () => ({ job: null })),
      getLatestScanJob: vi.fn(async () => ({ job: null })),
      onScanProgress: vi.fn(() => () => {}),
      getActiveVault: vi.fn(async () => ({ vault: null })),
      getActiveImportJob: vi.fn(async () => ({ job: null })),
      getLatestImportJob: vi.fn(async () => ({ job: null })),
      onImportProgress: vi.fn(() => () => {}),
      getDocumentsPage,
      getDocumentDetail,
      getDocumentExtensionFacets
    }

    render(<App />)

    // Global header search is visible on Overview
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Search/i)).toBeInTheDocument()
    })

    // Navigate to Documents tab
    fireEvent.click(screen.getByRole('button', { name: /^Documents$/i }))

    await waitFor(() => {
      expect(screen.getByText('tax_receipt_2025.pdf')).toBeInTheDocument()
    })

    // Unused global Header search input must be hidden on Documents
    expect(screen.queryByPlaceholderText('Search')).not.toBeInTheDocument()

    // Visible Documents filename filter must have maxLength=200 and drive getDocumentsPage
    const filenameInput = screen.getByLabelText('Filter documents by filename')
    expect(filenameInput).toHaveAttribute('maxLength', '200')
    fireEvent.change(filenameInput, { target: { value: 'notes' } })

    await waitFor(() => {
      expect(getDocumentsPage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filenameQuery: 'notes',
          offset: 0,
          limit: 50
        })
      )
    })
  })

  it('renders OCR model setup, async coverage states, OCR progress controls, and separate native vs OCR text previews', async () => {
    const doc1 = makeDoc({
      fileLocationId: 10,
      fileName: 'mixed_invoice.pdf',
      extension: '.pdf',
      extractionStatus: 'extracted',
      previewStatus: 'ready'
    })

    const readyModel = {
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
    }

    const baseCoverage = {
      totalDocuments: 1,
      ocrNeededDocuments: 1,
      notProcessedDocuments: 1,
      extractedDocuments: 0,
      noTextDocuments: 0,
      passwordProtectedDocuments: 0,
      unsupportedDocuments: 0,
      failedDocuments: 0,
      truncatedDocuments: 0,
      staleDocuments: 0,
      selectedImageOcrCount: 0
    }

    let ocrProgressListener: ((p: unknown) => void) | null = null
    const startDocumentOcr = vi.fn().mockResolvedValue({
      jobId: 'doc-ocr-1',
      status: 'running',
      scopeKind: 'ocr_needed',
      recipeVersion: 'doc_ocr_v1',
      ocrModelId: readyModel.modelId,
      ocrModelManifestSha256: readyModel.modelManifestSha256,
      ocrLanguage: 'eng',
      totalItems: 1,
      processedItems: 0,
      extractedItems: 0,
      noTextItems: 0,
      passwordProtectedItems: 0,
      unsupportedItems: 0,
      failedItems: 0,
      truncatedItems: 0,
      reusedItems: 0,
      skippedStaleItems: 0,
      pendingItems: 1,
      activeFileLocationId: 10,
      startedAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      completedAtMs: null,
      lastError: null,
      coverage: baseCoverage,
      coverageReady: true,
      coverageRefreshing: false
    })
    const pauseDocumentOcr = vi.fn().mockResolvedValue({
      ...(await startDocumentOcr.mock.results[0]?.value),
      jobId: 'doc-ocr-1',
      status: 'paused',
      scopeKind: 'ocr_needed',
      recipeVersion: 'doc_ocr_v1',
      ocrModelId: readyModel.modelId,
      ocrModelManifestSha256: readyModel.modelManifestSha256,
      ocrLanguage: 'eng',
      totalItems: 1,
      processedItems: 0,
      extractedItems: 0,
      noTextItems: 0,
      passwordProtectedItems: 0,
      unsupportedItems: 0,
      failedItems: 0,
      truncatedItems: 0,
      reusedItems: 0,
      skippedStaleItems: 0,
      pendingItems: 1,
      activeFileLocationId: null,
      startedAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_001_000,
      completedAtMs: null,
      lastError: null,
      coverage: baseCoverage,
      coverageReady: true,
      coverageRefreshing: false
    })

    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getDocumentsPage: vi.fn().mockResolvedValue({
        items: [doc1],
        totalCount: 1,
        offset: 0,
        limit: 50
      }),
      getDocumentDetail: vi.fn().mockResolvedValue({
        item: {
          ...doc1,
          sourceRootPath: 'D:\\docs',
          normalizedPath: 'd:\\docs\\mixed_invoice.pdf',
          recipeVersion: 'doc_extract_v1'
        }
      }),
      getDocumentPreview: vi.fn().mockResolvedValue({
        preview: {
          fileLocationId: 10,
          extractionStatus: 'extracted',
          previewStatus: 'ready',
          extractedText: 'Native header text',
          extractedCharCount: 18,
          previewCharCount: 18,
          previewTruncated: false,
          extractionTruncated: false,
          truncationReason: null,
          pageCount: 1,
          statusDetail: null,
          recipeVersion: 'doc_extract_v1',
          detectedEncoding: 'utf-8',
          extractedAtMs: 1_700_000_000_000,
          contentRevision: 'rev-1'
        }
      }),
      getDocumentExtensionFacets: vi.fn().mockResolvedValue({
        items: [{ extension: '.pdf', count: 1 }],
        totalCount: 1,
        offset: 0,
        limit: 50
      }),
      getOcrModelStatus: vi.fn().mockResolvedValue(readyModel),
      onOcrModelStatus: vi.fn(() => () => {}),
      getDocumentOcrProgress: vi.fn().mockResolvedValue({
        jobId: null,
        status: 'idle',
        scopeKind: null,
        recipeVersion: 'doc_ocr_v1',
        ocrModelId: readyModel.modelId,
        ocrModelManifestSha256: readyModel.modelManifestSha256,
        ocrLanguage: 'eng',
        totalItems: 0,
        processedItems: 0,
        extractedItems: 0,
        noTextItems: 0,
        passwordProtectedItems: 0,
        unsupportedItems: 0,
        failedItems: 0,
        truncatedItems: 0,
        reusedItems: 0,
        skippedStaleItems: 0,
        pendingItems: 0,
        activeFileLocationId: null,
        startedAtMs: null,
        updatedAtMs: null,
        completedAtMs: null,
        lastError: null,
        coverage: baseCoverage,
        coverageReady: false,
        coverageRefreshing: true
      }),
      onDocumentOcrProgress: vi.fn((cb: (p: unknown) => void) => {
        ocrProgressListener = cb
        return () => {
          ocrProgressListener = null
        }
      }),
      getDocumentOcrState: vi.fn().mockResolvedValue({
        state: {
          fileLocationId: 10,
          category: 'document',
          fileName: 'mixed_invoice.pdf',
          extension: '.pdf',
          originalPath: 'D:\\docs\\mixed_invoice.pdf',
          byteSize: 2048,
          filesystemMtimeMs: 1_700_000_000_000,
          discoveryObservationId: 1,
          activeHash: 'a'.repeat(64),
          ocrStatus: 'extracted',
          previewStatus: 'ready',
          recipeVersion: 'doc_ocr_v1',
          ocrModelId: readyModel.modelId,
          ocrModelManifestSha256: readyModel.modelManifestSha256,
          ocrLanguage: 'eng',
          extractionMethod: 'ocr_hybrid_pdf',
          extractedCharCount: 24,
          pageCount: 1,
          ocrPageCount: 1,
          nativeOnlyPageCount: 0,
          skippedBlankPageCount: 0,
          meanConfidence: 91,
          truncated: false,
          truncationReason: null,
          statusDetail: null,
          extractedAtMs: 1_700_000_005_000,
          contentRevision: 'rev-1',
          contentSha256: 'a'.repeat(64)
        }
      }),
      getDocumentOcrPreview: vi.fn().mockResolvedValue({
        preview: {
          fileLocationId: 10,
          category: 'document',
          fileName: 'mixed_invoice.pdf',
          extension: '.pdf',
          originalPath: 'D:\\docs\\mixed_invoice.pdf',
          byteSize: 2048,
          filesystemMtimeMs: 1_700_000_000_000,
          discoveryObservationId: 1,
          activeHash: 'a'.repeat(64),
          ocrStatus: 'extracted',
          previewStatus: 'ready',
          recipeVersion: 'doc_ocr_v1',
          ocrModelId: readyModel.modelId,
          ocrModelManifestSha256: readyModel.modelManifestSha256,
          ocrLanguage: 'eng',
          extractionMethod: 'ocr_hybrid_pdf',
          extractedCharCount: 24,
          pageCount: 1,
          ocrPageCount: 1,
          nativeOnlyPageCount: 0,
          skippedBlankPageCount: 0,
          meanConfidence: 91,
          truncated: false,
          truncationReason: null,
          statusDetail: null,
          extractedAtMs: 1_700_000_005_000,
          contentRevision: 'rev-1',
          contentSha256: 'a'.repeat(64),
          extractedText: 'OCR recognized body text',
          previewCharCount: 24,
          previewTruncated: false
        }
      }),
      startDocumentOcr,
      pauseDocumentOcr,
      resumeDocumentOcr: vi.fn(),
      cancelDocumentOcr: vi.fn(),
      ocrSelectedDocuments: vi.fn()
    }

    render(<DocumentsPanel />)

    // Async coverage loading state is shown before coverage warms
    await waitFor(() => {
      expect(screen.getByTestId('documents-ocr-coverage-status')).toHaveTextContent(
        /Calculating OCR coverage/i
      )
    })

    // Start OCR and pause
    fireEvent.click(screen.getByTestId('documents-ocr-scope-btn'))
    await waitFor(() => {
      expect(startDocumentOcr).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'ocr_needed' })
      )
      expect(screen.getByTestId('documents-ocr-progress')).toHaveTextContent('running')
    })

    fireEvent.click(screen.getByTestId('ocr-pause-btn'))
    await waitFor(() => {
      expect(pauseDocumentOcr).toHaveBeenCalled()
    })

    // Open document details and verify native "Extracted text" is separate from inert OCR <pre>
    fireEvent.click(screen.getByRole('button', { name: /mixed_invoice\.pdf/i }))
    await waitFor(() => {
      expect(screen.getByTestId('document-extracted-text-preview')).toHaveTextContent(
        'Native header text'
      )
      expect(screen.getByTestId('document-ocr-text-preview')).toHaveTextContent(
        'OCR recognized body text'
      )
      expect(screen.getByTestId('document-ocr-provenance')).toHaveTextContent(
        'tesseract-ocr/tessdata_fast:eng@65727574 (eng)'
      )
    })
    expect(ocrProgressListener).not.toBeNull()
  })

  it('offers explicit single-image OCR only for supported document images in Photos', async () => {
    const ocrSelectedDocuments = vi.fn().mockResolvedValue({ status: 'completed' })
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getOcrModelStatus: vi.fn().mockResolvedValue({
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
      }),
      onOcrModelStatus: vi.fn(() => () => {}),
      onDocumentOcrProgress: vi.fn(() => () => {}),
      getDocumentOcrState: vi.fn().mockResolvedValue({ state: null }),
      getDocumentOcrPreview: vi.fn().mockResolvedValue({ preview: null }),
      ocrSelectedDocuments
    }

    const { rerender } = render(<PhotoSelectedOcrSection fileLocationId={77} extension=".png" />)
    await waitFor(() => {
      expect(screen.getByTestId('photo-ocr-selected-btn')).not.toBeDisabled()
    })

    fireEvent.click(screen.getByTestId('photo-ocr-selected-btn'))
    await waitFor(() => {
      expect(ocrSelectedDocuments).toHaveBeenCalledWith({
        fileLocationIds: [77],
        forceReocr: true
      })
    })

    // Unsupported RAW photo extension hides the explicit OCR action
    rerender(<PhotoSelectedOcrSection fileLocationId={78} extension=".cr2" />)
    expect(screen.queryByTestId('photo-ocr-section')).not.toBeInTheDocument()
  })

  it('clears stale state on photo switch, ignores delayed photo A responses, and ties running state to backend job progress', async () => {
    let resolvePhotoAState: ((val: unknown) => void) | null = null
    let resolvePhotoAPreview: ((val: unknown) => void) | null = null
    let progressListener: ((p: { status: string }) => void) | null = null
    let currentBackendStatus = 'idle'

    const readyModel = {
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
    }

    const getDocumentOcrState = vi.fn(({ fileLocationId }: { fileLocationId: number }) => {
      if (fileLocationId === 101) {
        return new Promise((resolve) => {
          resolvePhotoAState = resolve
        })
      }
      if (fileLocationId === 102) {
        return Promise.resolve({
          state: {
            fileLocationId: 102,
            ocrStatus: 'extracted',
            ocrModelId: 'tesseract-ocr/tessdata_fast:eng@65727574',
            ocrLanguage: 'eng',
            ocrPageCount: 1,
            ocrTotalPages: 1,
            ocrRecognizedPages: 1,
            ocrCharCount: 12,
            ocrTruncated: false,
            ocrExtractedAtMs: 1_700_000_000_000,
            ocrErrorMessage: null,
            ocrStale: false
          }
        })
      }
      return Promise.resolve({ state: null })
    })

    const getDocumentOcrPreview = vi.fn(({ fileLocationId }: { fileLocationId: number }) => {
      if (fileLocationId === 101) {
        return new Promise((resolve) => {
          resolvePhotoAPreview = resolve
        })
      }
      if (fileLocationId === 102) {
        return Promise.resolve({
          preview: {
            fileLocationId: 102,
            ocrStatus: 'extracted',
            extractedText: 'PHOTO B TEXT',
            ocrModelId: 'tesseract-ocr/tessdata_fast:eng@65727574',
            ocrLanguage: 'eng',
            ocrPageCount: 1,
            ocrTotalPages: 1,
            ocrRecognizedPages: 1,
            ocrCharCount: 12,
            ocrTruncated: false,
            ocrExtractedAtMs: 1_700_000_000_000,
            statusDetail: null
          }
        })
      }
      return Promise.resolve({ preview: null })
    })

    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getOcrModelStatus: vi.fn().mockResolvedValue(readyModel),
      onOcrModelStatus: vi.fn(() => () => {}),
      getDocumentOcrProgress: vi.fn(async () => ({ status: currentBackendStatus })),
      onDocumentOcrProgress: vi.fn((cb: (p: { status: string }) => void) => {
        progressListener = cb
        return () => {}
      }),
      getDocumentOcrState,
      getDocumentOcrPreview,
      ocrSelectedDocuments: vi.fn().mockResolvedValue({ status: 'completed' })
    }

    const { rerender } = render(<PhotoSelectedOcrSection fileLocationId={101} extension=".png" />)
    await waitFor(() => {
      expect(getDocumentOcrState).toHaveBeenCalledWith({ fileLocationId: 101 })
    })

    // Switch to photo B before photo A resolves
    rerender(<PhotoSelectedOcrSection fileLocationId={102} extension=".png" />)
    await waitFor(() => {
      expect(screen.getByTestId('photo-ocr-text-preview')).toHaveTextContent('PHOTO B TEXT')
    })

    // Now resolve delayed photo A responses; photo B's UI must remain intact
    resolvePhotoAState!({
      state: {
        fileLocationId: 101,
        ocrStatus: 'extracted',
        ocrModelId: 'tesseract-ocr/tessdata_fast:eng@65727574',
        ocrLanguage: 'eng',
        ocrPageCount: 1,
        ocrTotalPages: 1,
        ocrRecognizedPages: 1,
        ocrCharCount: 12,
        ocrTruncated: false,
        ocrExtractedAtMs: 1_700_000_000_000,
        ocrErrorMessage: null,
        ocrStale: false
      }
    })
    resolvePhotoAPreview!({
      preview: {
        fileLocationId: 101,
        ocrStatus: 'extracted',
        extractedText: 'STALE PHOTO A TEXT',
        ocrModelId: 'tesseract-ocr/tessdata_fast:eng@65727574',
        ocrLanguage: 'eng',
        ocrPageCount: 1,
        ocrTotalPages: 1,
        ocrRecognizedPages: 1,
        ocrCharCount: 12,
        ocrTruncated: false,
        ocrExtractedAtMs: 1_700_000_000_000,
        statusDetail: null
      }
    })

    await waitFor(() => {
      expect(screen.getByTestId('photo-ocr-text-preview')).toHaveTextContent('PHOTO B TEXT')
      expect(screen.queryByText('STALE PHOTO A TEXT')).not.toBeInTheDocument()
    })

    // Switching to photo C clears photo B's old state immediately
    rerender(<PhotoSelectedOcrSection fileLocationId={103} extension=".png" />)
    expect(screen.queryByTestId('photo-ocr-text-preview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('photo-ocr-status')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(getDocumentOcrState).toHaveBeenCalledWith({ fileLocationId: 103 })
    })

    // Backend job progress keeps running state disabled across selection changes
    currentBackendStatus = 'running'
    act(() => {
      progressListener?.({ status: 'running' })
    })
    await waitFor(() => {
      expect(screen.getByTestId('photo-ocr-selected-btn')).toBeDisabled()
      expect(screen.getByTestId('photo-ocr-selected-btn')).toHaveTextContent('Running OCR…')
    })

    currentBackendStatus = 'idle'
    act(() => {
      progressListener?.({ status: 'completed' })
    })
    await waitFor(() => {
      expect(screen.getByTestId('photo-ocr-selected-btn')).not.toBeDisabled()
    })
  })

  it('prevents A -> B -> A stale overwrite and same-photo out-of-order overwrite', async () => {
    const aStateResolvers: Array<(val: unknown) => void> = []
    const aPreviewResolvers: Array<(val: unknown) => void> = []
    const aPreviewRejectors: Array<(err: Error) => void> = []
    let progressListener: ((p: { status: string }) => void) | null = null

    const readyModel = {
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
    }

    const makeState = (id: number) => ({
      state: {
        fileLocationId: id,
        ocrStatus: 'extracted',
        ocrModelId: 'tesseract-ocr/tessdata_fast:eng@65727574',
        ocrLanguage: 'eng',
        ocrPageCount: 1,
        ocrTotalPages: 1,
        ocrRecognizedPages: 1,
        ocrCharCount: 14,
        ocrTruncated: false,
        ocrExtractedAtMs: 1_700_000_000_000,
        ocrErrorMessage: null,
        ocrStale: false
      }
    })

    const makePreview = (id: number, text: string) => ({
      preview: {
        fileLocationId: id,
        ocrStatus: 'extracted',
        extractedText: text,
        ocrModelId: 'tesseract-ocr/tessdata_fast:eng@65727574',
        ocrLanguage: 'eng',
        ocrPageCount: 1,
        ocrTotalPages: 1,
        ocrRecognizedPages: 1,
        ocrCharCount: text.length,
        ocrTruncated: false,
        ocrExtractedAtMs: 1_700_000_000_000,
        statusDetail: null
      }
    })

    const getDocumentOcrState = vi.fn(({ fileLocationId }: { fileLocationId: number }) => {
      if (fileLocationId === 201) {
        return new Promise((resolve) => {
          aStateResolvers.push(resolve)
        })
      }
      return Promise.resolve(makeState(fileLocationId))
    })

    const getDocumentOcrPreview = vi.fn(({ fileLocationId }: { fileLocationId: number }) => {
      if (fileLocationId === 201) {
        return new Promise((resolve, reject) => {
          aPreviewResolvers.push(resolve)
          aPreviewRejectors.push(reject)
        })
      }
      return Promise.resolve(makePreview(fileLocationId, 'PHOTO B TEXT'))
    })

    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getOcrModelStatus: vi.fn().mockResolvedValue(readyModel),
      onOcrModelStatus: vi.fn(() => () => {}),
      getDocumentOcrProgress: vi.fn(async () => ({ status: 'idle' })),
      onDocumentOcrProgress: vi.fn((cb: (p: { status: string }) => void) => {
        progressListener = cb
        return () => {}
      }),
      getDocumentOcrState,
      getDocumentOcrPreview,
      ocrSelectedDocuments: vi.fn().mockResolvedValue({ status: 'completed' })
    }

    // 1. Start loading A (call #0) and leave it pending
    const { rerender } = render(<PhotoSelectedOcrSection fileLocationId={201} extension=".png" />)
    await waitFor(() => {
      expect(aStateResolvers).toHaveLength(1)
    })

    // 2. Switch to B (202), then return to A (201, call #1)
    rerender(<PhotoSelectedOcrSection fileLocationId={202} extension=".png" />)
    await waitFor(() => {
      expect(screen.getByTestId('photo-ocr-text-preview')).toHaveTextContent('PHOTO B TEXT')
    })

    rerender(<PhotoSelectedOcrSection fileLocationId={201} extension=".png" />)
    await waitFor(() => {
      expect(aStateResolvers).toHaveLength(2)
    })

    // 3. Resolve newer A response (call #1) -> displays CURRENT A TEXT
    await act(async () => {
      aStateResolvers[1]?.(makeState(201))
      aPreviewResolvers[1]?.(makePreview(201, 'CURRENT A TEXT'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('photo-ocr-text-preview')).toHaveTextContent('CURRENT A TEXT')
    })

    // 4. Resolve older A response (call #0) -> must NOT overwrite with OUTDATED A TEXT
    await act(async () => {
      aStateResolvers[0]?.(makeState(201))
      aPreviewResolvers[0]?.(makePreview(201, 'OUTDATED A TEXT'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('photo-ocr-text-preview')).toHaveTextContent('CURRENT A TEXT')
      expect(screen.queryByText('OUTDATED A TEXT')).not.toBeInTheDocument()
    })

    // 5. Same-photo out-of-order: trigger two refreshes on A without changing selection
    await act(async () => {
      progressListener?.({ status: 'completed' })
    })
    await waitFor(() => {
      expect(aStateResolvers).toHaveLength(3)
    })

    await act(async () => {
      progressListener?.({ status: 'completed' })
    })
    await waitFor(() => {
      expect(aStateResolvers).toHaveLength(4)
    })

    // Resolve newer same-photo request (#3) first
    await act(async () => {
      aStateResolvers[3]?.(makeState(201))
      aPreviewResolvers[3]?.(makePreview(201, 'NEWER SAME-PHOTO TEXT'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('photo-ocr-text-preview')).toHaveTextContent(
        'NEWER SAME-PHOTO TEXT'
      )
    })

    // Reject older same-photo request (#2) -> must NOT overwrite or surface stale error
    await act(async () => {
      aStateResolvers[2]?.(makeState(201))
      aPreviewRejectors[2]?.(new Error('Stale same-photo error'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('photo-ocr-text-preview')).toHaveTextContent(
        'NEWER SAME-PHOTO TEXT'
      )
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })
})
