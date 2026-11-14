import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { DocumentsPanel } from '../../src/renderer/src/components/DocumentsPanel'
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
    previewStatus: 'not_implemented',
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
    expect(screen.getByText('Not extracted yet')).toBeInTheDocument()
    expect(screen.getByText(/no rescan required/i)).toBeInTheDocument()
    expect(screen.getByText(/previews, text extraction, OCR/i)).toBeInTheDocument()

    // Select document and verify detail drawer shows explicit Unknown and provenance
    fireEvent.click(screen.getByRole('button', { name: /tax_receipt_2025\.pdf/i }))
    await waitFor(() => {
      expect(screen.getByText('D:\\docs')).toBeInTheDocument()
    })
    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('#11')).toBeInTheDocument()
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
})
