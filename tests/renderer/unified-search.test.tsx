// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { useUnifiedSearch } from '../../src/renderer/src/hooks/useUnifiedSearch'
import type { VaultApi } from '../../src/preload/index.d'
import type {
  PhotoItem,
  UnifiedSearchDocumentsResponse,
  UnifiedSearchPhotosResponse
} from '../../src/shared/validation/ipc-schemas'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makePhoto(id: number, overrides: Partial<PhotoItem> = {}): PhotoItem {
  return {
    id,
    sourceId: 1,
    originalPath: `D:\\Fixtures\\photo_${id}.jpg`,
    fileName: `photo_${id}.jpg`,
    extension: '.jpg',
    category: 'photo',
    discoveryObservationId: id,
    byteSize: 4096,
    filesystemBirthtimeMs: 1700000000000,
    filesystemMtimeMs: 1700000000000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1700000000000,
    lastSeenAtMs: 1700000000000,
    activeHash: 'a'.repeat(64),
    activeHashVerifiedAtMs: 1700000000000,
    rating: null,
    flag: 'none',
    annotationVersion: 0,
    ...overrides
  }
}

function makePhotoResult(id: number, score = 0.27, rank = 1, overrides: Partial<PhotoItem> = {}) {
  return {
    photo: makePhoto(id, overrides),
    score,
    rank
  }
}

function makeDocResult(
  fileLocationId: number,
  overrides: Partial<{
    score: number
    textSourceKind: 'native' | 'ocr'
    fileName: string
    extension: string
    winningSnippet: string
    truncated: boolean
    normalizedCharCount: number
    indexedCharCount: number
    coverageRatio: number
  }> = {}
) {
  const fileName = overrides.fileName ?? `doc_${fileLocationId}.pdf`
  return {
    fileLocationId,
    score: overrides.score ?? 0.81,
    winningChunkId: fileLocationId * 10,
    winningChunkIndex: 0,
    textSourceKind: overrides.textSourceKind ?? 'native',
    charOffsetStart: 0,
    charOffsetEnd: 42,
    truncated: overrides.truncated ?? false,
    normalizedCharCount: overrides.normalizedCharCount ?? 100,
    indexedCharCount: overrides.indexedCharCount ?? 100,
    coverageRatio: overrides.coverageRatio ?? 1,
    originalPath: `D:\\Fixtures\\${fileName}`,
    fileName,
    extension: overrides.extension ?? '.pdf',
    winningSnippet: overrides.winningSnippet ?? `Snippet for ${fileName}`
  }
}

function makePhotosResponse(
  overrides: Partial<UnifiedSearchPhotosResponse> & {
    items?: ReturnType<typeof makePhotoResult>[]
    totalMatched?: number
    offset?: number
    limit?: number
    hasMore?: boolean
    eligibleCount?: number
    unindexedCount?: number
    staleCount?: number
    corruptCount?: number
    truncated?: boolean
    tokenCount?: number
  } = {}
): UnifiedSearchPhotosResponse {
  const items = overrides.items ?? []
  return {
    status: overrides.status ?? 'ready',
    modelId: 'Xenova/clip-vit-base-patch32',
    errorMessage: overrides.errorMessage ?? null,
    result:
      'result' in overrides
        ? (overrides.result ?? null)
        : {
            items,
            totalMatched: overrides.totalMatched ?? items.length,
            eligibleCount: overrides.eligibleCount ?? Math.max(items.length, 1),
            unindexedCount: overrides.unindexedCount ?? 0,
            staleCount: overrides.staleCount ?? 0,
            corruptCount: overrides.corruptCount ?? 0,
            offset: overrides.offset ?? 0,
            limit: overrides.limit ?? 20,
            hasMore: overrides.hasMore ?? false,
            queryLatencyMs: 14,
            truncated: overrides.truncated ?? false,
            tokenCount: overrides.tokenCount ?? 2,
            modelStatus: 'ready'
          }
  }
}

function makeDocsResponse(
  overrides: Partial<UnifiedSearchDocumentsResponse> & {
    items?: ReturnType<typeof makeDocResult>[]
    totalMatched?: number
    hasMore?: boolean
    eligibleChunkCount?: number
    corruptChunkCount?: number
    queryTokenCount?: number
    queryTruncated?: boolean
    clutterFilterActive?: boolean
    indexedDocuments?: number
    unindexedTracks?: number
    staleTracks?: number
  } = {}
): UnifiedSearchDocumentsResponse {
  const items = overrides.items ?? []
  return {
    status: overrides.status ?? 'ready',
    modelId: 'Xenova/bge-small-en-v1.5',
    errorMessage: overrides.errorMessage ?? null,
    result:
      'result' in overrides
        ? (overrides.result ?? null)
        : {
            items,
            totalMatched: overrides.totalMatched ?? items.length,
            hasMore: overrides.hasMore ?? false,
            eligibleChunkCount: overrides.eligibleChunkCount ?? Math.max(items.length, 1),
            corruptChunkCount: overrides.corruptChunkCount ?? 0,
            queryTokenCount: overrides.queryTokenCount ?? 3,
            queryTruncated: overrides.queryTruncated ?? false,
            queryLatencyMs: 19,
            clutterFilterActive: overrides.clutterFilterActive,
            coverage: {
              totalExtractableTracks: 2,
              totalDocumentsWithText: 2,
              indexedTracks: 2,
              truncatedTracks: 0,
              emptyTextTracks: 0,
              failedTracks: 0,
              unindexedTracks: overrides.unindexedTracks ?? 0,
              staleTracks: overrides.staleTracks ?? 0,
              corruptChunks: 0,
              indexedDocuments: overrides.indexedDocuments ?? Math.max(items.length, 1)
            }
          }
  }
}

function installMockApi(overrides: Partial<VaultApi> = {}): VaultApi {
  const api = {
    getAppInfo: vi.fn(async () => ({
      name: 'Personal Vault',
      version: '0.1.0',
      platform: 'win32',
      isPackaged: false
    })),
    getVaultStatus: vi.fn(async () => ({ sourceCount: 1, itemCount: 12, isReady: true })),
    setTab: vi.fn(async () => true),
    selectRoots: vi.fn(async () => ({ cancelled: true, rootPaths: [] })),
    getActiveScanJob: vi.fn(async () => ({ job: null })),
    getLatestScanJob: vi.fn(async () => ({ job: null })),
    onScanProgress: vi.fn(() => () => {}),
    getPhotosPage: vi.fn(async () => ({
      items: [],
      totalCount: 0,
      offset: 0,
      limit: 50,
      hasMore: false
    })),
    getThumbnail: vi.fn(async ({ locationId }: { locationId: number }) => ({
      status: 'ready' as const,
      locationId,
      dataUrl: 'data:image/webp;base64,TEST',
      mimeType: 'image/webp',
      width: 120,
      height: 90
    })),
    cancelThumbnail: vi.fn(async ({ locationId }: { locationId: number }) => ({
      success: true,
      locationId
    })),
    getPhotosDiagnostics: vi.fn(async () => ({
      activeWorkers: 0,
      queuedJobs: 0,
      totalDecodes: 0,
      cacheHits: 0,
      cacheMisses: 0
    })),
    listCollections: vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 50 })),
    getSemanticModelStatus: vi.fn(async () => ({
      state: 'ready' as const,
      error: null,
      activeDir: 'C:\\models\\clip',
      verifiedAtMs: 1700000000000
    })),
    getSemanticIndexProgress: vi.fn(async () => ({
      jobId: null,
      status: 'idle' as const,
      totalCatalogPhotos: 1,
      currentIndexedPhotos: 1,
      unindexedPhotos: 0,
      stalePhotos: 0,
      corruptPhotos: 0,
      processedPhotos: 0,
      reusedPhotos: 0,
      unsupportedPhotos: 0,
      failedPhotos: 0,
      pendingPhotos: 0,
      lastError: null
    })),
    onSemanticIndexProgress: vi.fn(() => () => {}),
    getPhotoMetadataProgress: vi.fn(async () => ({
      jobId: null,
      status: 'idle' as const,
      totalPhotos: 1,
      processedPhotos: 1,
      extractedPhotos: 1,
      absentMetadataPhotos: 0,
      reusedPhotos: 0,
      unsupportedPhotos: 0,
      failedPhotos: 0,
      pendingPhotos: 0,
      lastError: null,
      coverage: {
        parserRecipeVersion: 'exif_tech_v1',
        totalPhotos: 1,
        extractedCount: 1,
        noMetadataCount: 0,
        unsupportedCount: 0,
        failedCount: 0,
        staleCount: 0,
        unprocessedCount: 0
      }
    })),
    onPhotoMetadataProgress: vi.fn(() => () => {}),
    getPhotoMetadataFacets: vi.fn(async () => ({
      field: 'detected_format' as const,
      items: [{ normalizedValue: 'jpeg', displayLabel: 'JPEG', count: 5 }],
      unknownCount: 1,
      unprocessedCount: 0,
      offset: 0,
      limit: 50,
      hasMore: false
    })),
    searchPhotosSemantic: vi.fn(async () => ({
      items: [],
      totalMatched: 0,
      eligibleCount: 0,
      unindexedCount: 0,
      staleCount: 0,
      corruptCount: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      queryLatencyMs: 5,
      truncated: false,
      tokenCount: 1,
      modelStatus: 'ready' as const
    })),
    cancelPhotosSemanticSearch: vi.fn(async () => ({ cancelled: true })),
    getDocumentsPage: vi.fn(async () => ({
      items: [],
      totalCount: 0,
      offset: 0,
      limit: 50,
      hiddenClutterCount: 0
    })),
    getDocumentDetail: vi.fn(async () => ({ item: null })),
    getDocumentExtensionFacets: vi.fn(async () => ({
      items: [
        { extension: '.pdf', count: 3 },
        { extension: '.txt', count: 2 }
      ],
      totalCount: 2
    })),
    getDocumentPreview: vi.fn(async () => ({ preview: null })),
    getDocumentExtractionProgress: vi.fn(async () => null),
    onDocumentExtractionProgress: vi.fn(() => () => {}),
    getOcrModelStatus: vi.fn(async () => ({
      state: 'unprovisioned' as const,
      modelId: 'tesseract-fast-eng',
      modelManifestSha256: 'b'.repeat(64),
      language: 'eng',
      requiredBytes: 4113088,
      downloadedBytes: 0,
      currentArtifact: null,
      errorMessage: null
    })),
    onOcrModelStatus: vi.fn(() => () => {}),
    getDocumentOcrProgress: vi.fn(async () => null),
    onDocumentOcrProgress: vi.fn(() => () => {}),
    getDocSemanticModelStatus: vi.fn(async () => ({
      state: 'ready' as const,
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
    })),
    getDocumentSemanticProgress: vi.fn(async () => null),
    getDocumentClassificationProgress: vi.fn(async () => null),
    onDocumentClassificationProgress: vi.fn(() => () => {}),
    getDocumentClassificationFacets: vi.fn(async () => null),
    searchDocumentsSemantic: vi.fn(async () => makeDocsResponse().result!),
    cancelDocumentSemanticSearch: vi.fn(async () => ({ cancelled: true })),
    searchUnifiedPhotos: vi.fn(async () => makePhotosResponse()),
    searchUnifiedDocuments: vi.fn(async () => makeDocsResponse()),
    cancelUnifiedSearch: vi.fn(async () => ({ cancelled: true })),
    ...overrides
  } as unknown as VaultApi

  window.api = api
  return api
}

async function mountApp() {
  let utils!: ReturnType<typeof render>
  await act(async () => {
    utils = render(<App />)
  })
  await waitFor(() => {
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeInTheDocument()
  })
  return utils
}

function submitHeaderSearch(query: string) {
  const input = screen.getByRole('searchbox', { name: /search/i })
  fireEvent.change(input, { target: { value: query } })
  fireEvent.submit(input.closest('form')!)
  return input
}

describe('Stage 7F Slice 2 — Unified Search UI & Hook Integration', () => {
  const originalApi = window.api
  const originalMatchMedia = window.matchMedia

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    window.api = originalApi
    window.matchMedia = originalMatchMedia
  })

  it('preserves sourceCount === 0 disabled search and submits on Enter only when sourceCount > 0', async () => {
    const emptyApi = installMockApi({
      getVaultStatus: vi.fn(async () => ({ sourceCount: 0, itemCount: 0, isReady: true }))
    })
    const first = await mountApp()
    const disabledSearch = screen.getByRole('searchbox', { name: /search/i })
    expect(disabledSearch).toBeDisabled()
    expect(emptyApi.searchUnifiedPhotos).not.toHaveBeenCalled()
    first.unmount()

    const populatedApi = installMockApi()
    await mountApp()
    expect(screen.getByRole('heading', { name: 'Catalog Inventory' })).toBeInTheDocument()

    const searchInput = screen.getByRole('searchbox', { name: /search/i })
    expect(searchInput).toBeEnabled()

    // Typing alone does not submit
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'sunset' } })
    })
    expect(populatedApi.searchUnifiedPhotos).not.toHaveBeenCalled()
    expect(populatedApi.searchUnifiedDocuments).not.toHaveBeenCalled()

    // Submit on Enter dispatches both modalities with default limit=20
    await act(async () => {
      fireEvent.submit(searchInput.closest('form')!)
    })

    expect(populatedApi.searchUnifiedPhotos).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'sunset',
        ownerSurface: 'unified',
        offset: 0,
        limit: 20
      })
    )
    expect(populatedApi.searchUnifiedDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'sunset',
        ownerSurface: 'unified',
        offset: 0,
        limit: 20
      })
    )
    expect(screen.getByTestId('unified-search-panel')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Catalog Inventory' })).not.toBeInTheDocument()
  })

  it('renders each modality immediately when its own response arrives, with provenance, inert excerpts, and honest uncalibrated scores', async () => {
    const photosDeferred = deferred<UnifiedSearchPhotosResponse>()
    const docsDeferred = deferred<UnifiedSearchDocumentsResponse>()

    installMockApi({
      searchUnifiedPhotos: vi.fn(() => photosDeferred.promise),
      searchUnifiedDocuments: vi.fn(() => docsDeferred.promise)
    })

    await mountApp()
    await act(async () => {
      submitHeaderSearch('receipt')
    })

    const photosSection = screen.getByTestId('unified-photos-section')
    const docsSection = screen.getByTestId('unified-documents-section')
    expect(within(photosSection).getByText(/searching photos/i)).toBeInTheDocument()
    expect(within(docsSection).getByText(/searching documents/i)).toBeInTheDocument()

    // Photos resolves first while Documents is still pending
    await act(async () => {
      photosDeferred.resolve(
        makePhotosResponse({
          items: [makePhotoResult(11, 0.27, 1, { fileName: 'sunset_beach.jpg' })],
          totalMatched: 1
        })
      )
    })

    expect(within(photosSection).getByText('sunset_beach.jpg')).toBeInTheDocument()
    expect(within(photosSection).getByText(/27% CLIP similarity/i)).toBeInTheDocument()
    expect(within(photosSection).getByText(/1 photo match/i)).toBeInTheDocument()
    expect(within(docsSection).getByText(/searching documents/i)).toBeInTheDocument()

    // Documents resolves second with OCR + Native provenance, partial badge, and inert <pre>
    await act(async () => {
      docsDeferred.resolve(
        makeDocsResponse({
          items: [
            makeDocResult(21, {
              fileName: 'scanned_receipt.pdf',
              score: 0.84,
              textSourceKind: 'ocr',
              truncated: true,
              indexedCharCount: 50000,
              normalizedCharCount: 100000,
              coverageRatio: 0.5,
              winningSnippet: '<script>alert("xss")</script> Total $42.00'
            }),
            makeDocResult(22, {
              fileName: 'notes.txt',
              extension: '.txt',
              score: 0.72,
              textSourceKind: 'native',
              winningSnippet: 'Grocery receipt summary'
            })
          ],
          totalMatched: 2
        })
      )
    })

    expect(within(docsSection).getByText(/2 document matches/i)).toBeInTheDocument()
    expect(within(docsSection).getByText('scanned_receipt.pdf')).toBeInTheDocument()
    expect(within(docsSection).getByText('OCR text (machine-recognized)')).toBeInTheDocument()
    expect(within(docsSection).getByText('Native text')).toBeInTheDocument()
    expect(within(docsSection).getByText(/84% BGE similarity/i)).toBeInTheDocument()
    expect(within(docsSection).getByText(/Partially indexed/i)).toBeInTheDocument()

    const snippetEl = docsSection.querySelector('pre.unified-doc-snippet')
    expect(snippetEl?.textContent).toContain('<script>alert("xss")</script>')
    expect(docsSection.querySelector('script')).toBeNull()

    // Never combines counts across modalities
    expect(screen.queryByText(/3 total matches/i)).not.toBeInTheDocument()
    expect(screen.getByText(/not comparable/i)).toBeInTheDocument()
  })

  it('discards stale responses on rapid query and filter replacement', async () => {
    const firstPhoto = deferred<UnifiedSearchPhotosResponse>()
    const firstDoc = deferred<UnifiedSearchDocumentsResponse>()
    const secondPhoto = deferred<UnifiedSearchPhotosResponse>()
    const secondDoc = deferred<UnifiedSearchDocumentsResponse>()

    const searchUnifiedPhotos = vi
      .fn()
      .mockImplementationOnce(() => firstPhoto.promise)
      .mockImplementationOnce(() => secondPhoto.promise)
      .mockResolvedValue(
        makePhotosResponse({
          items: [makePhotoResult(300, 0.4, 1, { fileName: 'filtered_photo.jpg' })]
        })
      )

    const searchUnifiedDocuments = vi
      .fn()
      .mockImplementationOnce(() => firstDoc.promise)
      .mockImplementationOnce(() => secondDoc.promise)
      .mockResolvedValue(
        makeDocsResponse({
          items: [makeDocResult(400, { fileName: 'filtered_doc.pdf' })],
          clutterFilterActive: true
        })
      )

    installMockApi({ searchUnifiedPhotos, searchUnifiedDocuments })
    await mountApp()

    await act(async () => {
      submitHeaderSearch('first query')
    })
    await act(async () => {
      submitHeaderSearch('second query')
    })

    await act(async () => {
      secondPhoto.resolve(
        makePhotosResponse({
          items: [makePhotoResult(201, 0.35, 1, { fileName: 'fresh_photo.jpg' })]
        })
      )
      secondDoc.resolve(
        makeDocsResponse({
          items: [makeDocResult(202, { fileName: 'fresh_doc.pdf' })]
        })
      )
    })

    expect(screen.getByText('fresh_photo.jpg')).toBeInTheDocument()
    expect(screen.getByText('fresh_doc.pdf')).toBeInTheDocument()

    // Late resolution from first query must be discarded
    await act(async () => {
      firstPhoto.resolve(
        makePhotosResponse({
          items: [makePhotoResult(101, 0.99, 1, { fileName: 'stale_photo.jpg' })]
        })
      )
      firstDoc.resolve(
        makeDocsResponse({
          items: [makeDocResult(102, { fileName: 'stale_doc.pdf' })]
        })
      )
    })

    expect(screen.queryByText('stale_photo.jpg')).not.toBeInTheDocument()
    expect(screen.queryByText('stale_doc.pdf')).not.toBeInTheDocument()
    expect(screen.getByText('fresh_photo.jpg')).toBeInTheDocument()
    expect(screen.getByText('fresh_doc.pdf')).toBeInTheDocument()

    // Quick filter replacement bumps queryGen & ownerGen and shows active clutter + scope disclosure
    const hideClutterCheckbox = screen.getByTestId('unified-doc-hide-clutter')
    await act(async () => {
      fireEvent.click(hideClutterCheckbox)
    })

    expect(searchUnifiedDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: 'second query',
        offset: 0,
        limit: 20,
        documentFilters: expect.objectContaining({ clutterFilter: 'hide_clutter' })
      })
    )
    expect(screen.getByTestId('unified-doc-clutter-disclosure')).toBeInTheDocument()
    expect(screen.getByTestId('unified-filter-scope-disclosure')).toHaveTextContent(
      /documents only/i
    )
  })

  it('supports independent pagination keeping only active page and guards concurrent paging per modality', async () => {
    const page20Photos = deferred<UnifiedSearchPhotosResponse>()
    const page20Docs = deferred<UnifiedSearchDocumentsResponse>()

    const searchUnifiedPhotos = vi
      .fn()
      .mockResolvedValueOnce(
        makePhotosResponse({
          items: [makePhotoResult(1, 0.5, 1, { fileName: 'photo_page_0.jpg' })],
          totalMatched: 50,
          offset: 0,
          hasMore: true
        })
      )
      .mockImplementationOnce(() => page20Photos.promise)

    const searchUnifiedDocuments = vi
      .fn()
      .mockResolvedValueOnce(
        makeDocsResponse({
          items: [makeDocResult(10, { fileName: 'doc_page_0.pdf' })],
          totalMatched: 30,
          hasMore: true
        })
      )
      .mockImplementationOnce(() => page20Docs.promise)

    installMockApi({ searchUnifiedPhotos, searchUnifiedDocuments })
    await mountApp()

    await act(async () => {
      submitHeaderSearch('nature')
    })

    const initialOwnerGen = searchUnifiedPhotos.mock.calls[0]![0].ownerGen
    expect(screen.getByText('photo_page_0.jpg')).toBeInTheDocument()
    expect(screen.getByText('doc_page_0.pdf')).toBeInTheDocument()

    // Concurrently page Photos and Documents from UI
    await act(async () => {
      fireEvent.click(screen.getByTestId('unified-photos-next-btn'))
      fireEvent.click(screen.getByTestId('unified-documents-next-btn'))
    })

    expect(searchUnifiedPhotos).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ offset: 20, limit: 20, ownerGen: initialOwnerGen })
    )
    expect(searchUnifiedDocuments).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ offset: 20, limit: 20, ownerGen: initialOwnerGen })
    )

    // Documents resolves first while Photos is still pending
    await act(async () => {
      page20Docs.resolve(
        makeDocsResponse({
          items: [makeDocResult(25, { fileName: 'doc_page_20.pdf' })],
          totalMatched: 30,
          hasMore: false
        })
      )
    })
    expect(screen.getByText('doc_page_20.pdf')).toBeInTheDocument()
    expect(screen.queryByText('doc_page_0.pdf')).not.toBeInTheDocument()

    await act(async () => {
      page20Photos.resolve(
        makePhotosResponse({
          items: [makePhotoResult(21, 0.4, 21, { fileName: 'photo_page_20.jpg' })],
          totalMatched: 50,
          offset: 20,
          hasMore: true
        })
      )
    })

    // Only active page is retained per modality
    expect(screen.getByText('photo_page_20.jpg')).toBeInTheDocument()
    expect(screen.queryByText('photo_page_0.jpg')).not.toBeInTheDocument()
  })

  it('discards stale overlapping page response within the same modality without disturbing the other modality', async () => {
    const page20Photos = deferred<UnifiedSearchPhotosResponse>()
    const page40Photos = deferred<UnifiedSearchPhotosResponse>()

    const searchUnifiedPhotos = vi
      .fn()
      .mockResolvedValueOnce(
        makePhotosResponse({
          items: [makePhotoResult(1, 0.5, 1, { fileName: 'p0.jpg' })],
          totalMatched: 60,
          offset: 0,
          hasMore: true
        })
      )
      .mockImplementationOnce(() => page20Photos.promise)
      .mockImplementationOnce(() => page40Photos.promise)

    const searchUnifiedDocuments = vi.fn().mockResolvedValueOnce(
      makeDocsResponse({
        items: [makeDocResult(9, { fileName: 'stable_doc.pdf' })],
        totalMatched: 1
      })
    )

    installMockApi({ searchUnifiedPhotos, searchUnifiedDocuments })
    const { result, unmount } = renderHook(() => useUnifiedSearch({ isSurfaceActive: true }))

    await act(async () => {
      result.current.submitSearch('valley')
    })
    const ownerGen = searchUnifiedPhotos.mock.calls[0]![0].ownerGen
    expect(result.current.documents.response?.result?.items[0]?.fileName).toBe('stable_doc.pdf')

    // Overlapping page requests on Photos: offset 20 then offset 40 before 20 resolves
    await act(async () => {
      result.current.pagePhotos(20)
      result.current.pagePhotos(40)
    })

    expect(searchUnifiedPhotos).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ offset: 20, ownerGen })
    )
    expect(searchUnifiedPhotos).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ offset: 40, ownerGen })
    )
    expect(searchUnifiedDocuments).toHaveBeenCalledTimes(1)

    await act(async () => {
      page40Photos.resolve(
        makePhotosResponse({
          items: [makePhotoResult(41, 0.3, 41, { fileName: 'p40.jpg' })],
          totalMatched: 60,
          offset: 40,
          hasMore: false
        })
      )
    })
    await act(async () => {
      page20Photos.resolve(
        makePhotosResponse({
          items: [makePhotoResult(21, 0.4, 21, { fileName: 'stale_p20.jpg' })],
          totalMatched: 60,
          offset: 20,
          hasMore: true
        })
      )
    })

    expect(result.current.photos.offset).toBe(40)
    expect(result.current.photos.response?.result?.items.map((i) => i.photo.fileName)).toEqual([
      'p40.jpg'
    ])
    expect(result.current.documents.response?.result?.items[0]?.fileName).toBe('stable_doc.pdf')
    unmount()
  })

  it('handles unavailable-model, timeout, error, and empty states independently and isolates modality retry', async () => {
    const searchUnifiedPhotos = vi
      .fn()
      .mockResolvedValueOnce(
        makePhotosResponse({
          status: 'timed_out',
          result: null,
          errorMessage: 'Photo worker timed out after 15000ms'
        })
      )
      .mockResolvedValueOnce(
        makePhotosResponse({
          items: [makePhotoResult(5, 0.31, 1, { fileName: 'retried_photo.jpg' })],
          totalMatched: 1
        })
      )

    const searchUnifiedDocuments = vi.fn().mockResolvedValueOnce(
      makeDocsResponse({
        status: 'unprovisioned',
        result: null,
        errorMessage: 'Document model not installed'
      })
    )

    installMockApi({ searchUnifiedPhotos, searchUnifiedDocuments })
    await mountApp()

    await act(async () => {
      submitHeaderSearch('contract')
    })

    const photosSection = screen.getByTestId('unified-photos-section')
    const docsSection = screen.getByTestId('unified-documents-section')

    expect(within(photosSection).getByText('Photo search timed out')).toBeInTheDocument()
    expect(
      within(docsSection).getByText('Document search model is not installed.')
    ).toBeInTheDocument()

    // Retrying Photos touches ONLY Photos and does not re-call Documents
    await act(async () => {
      fireEvent.click(screen.getByTestId('unified-photos-retry-btn'))
    })

    expect(searchUnifiedPhotos).toHaveBeenCalledTimes(2)
    expect(searchUnifiedDocuments).toHaveBeenCalledTimes(1)
    expect(within(photosSection).getByText('retried_photo.jpg')).toBeInTheDocument()
    expect(
      within(docsSection).getByText('Document search model is not installed.')
    ).toBeInTheDocument()
  })

  it('isolates Documents retry when Documents errors while Photos stays ready', async () => {
    const searchUnifiedPhotos = vi.fn().mockResolvedValueOnce(
      makePhotosResponse({
        items: [makePhotoResult(3, 0.4, 1, { fileName: 'ready_photo.jpg' })],
        totalMatched: 1
      })
    )
    const searchUnifiedDocuments = vi
      .fn()
      .mockRejectedValueOnce(new Error('Document worker overloaded'))
      .mockResolvedValueOnce(
        makeDocsResponse({
          items: [makeDocResult(8, { fileName: 'retried_doc.pdf' })],
          totalMatched: 1
        })
      )

    installMockApi({ searchUnifiedPhotos, searchUnifiedDocuments })
    await mountApp()

    await act(async () => {
      submitHeaderSearch('invoice')
    })

    expect(screen.getByText('ready_photo.jpg')).toBeInTheDocument()
    expect(screen.getByText('Document search failed')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByTestId('unified-documents-retry-btn'))
    })

    expect(searchUnifiedPhotos).toHaveBeenCalledTimes(1)
    expect(searchUnifiedDocuments).toHaveBeenCalledTimes(2)
    expect(screen.getByText('ready_photo.jpg')).toBeInTheDocument()
    expect(screen.getByText('retried_doc.pdf')).toBeInTheDocument()
  })

  it('restores ScanJobsPanel + Catalog Inventory on Clear, returns focus to search, and enforces monotonic ownerGen across tabs and remounts', async () => {
    const api = installMockApi({
      searchUnifiedPhotos: vi.fn(async () =>
        makePhotosResponse({
          items: [makePhotoResult(7, 0.44, 1, { fileName: 'clear_test.jpg' })]
        })
      )
    })

    const firstMount = await mountApp()
    const input = submitHeaderSearch('clear test')
    await waitFor(() => {
      expect(screen.getByTestId('unified-search-panel')).toBeInTheDocument()
    })

    const gen1 = vi.mocked(api.searchUnifiedPhotos).mock.calls[0]![0].ownerGen

    // Clear restores ScanJobsPanel + Catalog Inventory and returns focus to search
    const clearBtn = screen.getByRole('button', { name: 'Clear search' })
    await act(async () => {
      fireEvent.click(clearBtn)
    })

    expect(api.cancelUnifiedSearch).toHaveBeenCalledWith({
      ownerSurface: 'unified',
      ownerGen: gen1,
      modality: 'all'
    })
    expect(screen.queryByTestId('unified-search-panel')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select Source Folders' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Catalog Inventory' })).toBeInTheDocument()
    expect(input).toHaveValue('')
    expect(document.activeElement).toBe(input)

    // Submit again -> navigating to Photos tab cancels unified ownerGen and Photos tab uses strictly higher ownerGen
    await act(async () => {
      submitHeaderSearch('tab switch')
    })
    const gen2 = vi.mocked(api.searchUnifiedPhotos).mock.calls[1]![0].ownerGen
    expect(gen2).toBeGreaterThan(gen1)

    const nav = screen.getByRole('navigation', { name: /views/i })
    await act(async () => {
      fireEvent.click(within(nav).getByRole('button', { name: 'Photos' }))
    })
    expect(api.cancelUnifiedSearch).toHaveBeenCalledWith({
      ownerSurface: 'unified',
      ownerGen: gen2,
      modality: 'all'
    })

    // Existing Photos tab search works normally with strictly higher monotonic ownerGen
    const photosTabInput = screen.getByRole('textbox', { name: /search photos by description/i })
    await act(async () => {
      fireEvent.change(photosTabInput, { target: { value: 'lake' } })
      fireEvent.submit(photosTabInput.closest('form')!)
    })
    const photosTabGen = vi.mocked(api.searchPhotosSemantic).mock.calls[0]![0].ownerGen!
    expect(photosTabGen).toBeGreaterThan(gen2)

    // Existing Documents tab search also remains intact with strictly higher ownerGen
    await act(async () => {
      fireEvent.click(within(nav).getByRole('button', { name: 'Documents' }))
    })
    const docsTabInput = screen.getByTestId('doc-semantic-search-input')
    await act(async () => {
      fireEvent.change(docsTabInput, { target: { value: 'tax' } })
      fireEvent.submit(docsTabInput.closest('form')!)
    })
    const docsTabGen = vi.mocked(api.searchDocumentsSemantic).mock.calls[0]![0].ownerGen!
    expect(docsTabGen).toBeGreaterThan(photosTabGen)

    // Unmount and remount App -> next unified ownerGen never resets
    firstMount.unmount()
    await mountApp()
    await act(async () => {
      submitHeaderSearch('remounted')
    })
    const genAfterRemount = vi.mocked(api.searchUnifiedPhotos).mock.calls[2]![0].ownerGen
    expect(genAfterRemount).toBeGreaterThan(docsTabGen)
  })

  it('supports modality scoping, keyboard access, polite announcements, and narrow-viewport jump links (480x820 / 360x480)', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('767px'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))

    const api = installMockApi({
      searchUnifiedPhotos: vi.fn(async () =>
        makePhotosResponse({
          items: [makePhotoResult(1, 0.3, 1, { fileName: 'narrow_photo.jpg' })],
          totalMatched: 1
        })
      ),
      searchUnifiedDocuments: vi.fn(async () =>
        makeDocsResponse({
          items: [makeDocResult(2, { fileName: 'narrow_doc.pdf' })],
          totalMatched: 1
        })
      )
    })

    await mountApp()
    await act(async () => {
      submitHeaderSearch('narrow')
    })

    // Narrow viewport renders section jump links when modality === 'all'
    expect(screen.getByTestId('unified-jump-links')).toBeInTheDocument()

    // Polite live status announcement summarizes arrivals
    const liveStatus = screen.getByTestId('unified-live-status')
    expect(liveStatus).toHaveAttribute('aria-live', 'polite')
    expect(liveStatus.textContent).toMatch(/photos.*1|1.*photo/i)

    // Switching modality to Documents cancels Photos and disables Photo-only quick filters
    const docsModalityBtn = screen.getByTestId('unified-modality-documents')
    await act(async () => {
      fireEvent.click(docsModalityBtn)
    })

    expect(docsModalityBtn).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTestId('unified-photos-section')).not.toBeInTheDocument()
    expect(screen.getByTestId('unified-photo-format-basis')).toBeDisabled()
    expect(screen.getByTestId('unified-doc-hide-clutter')).toBeEnabled()
    expect(api.cancelUnifiedSearch).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSurface: 'unified', modality: 'photos' })
    )

    // Inline details button on result item is keyboard-accessible
    const docBtn = screen.getByTestId('unified-doc-item-2')
    expect(docBtn.tagName).toBe('BUTTON')
    await act(async () => {
      fireEvent.click(docBtn)
    })
    expect(screen.getByText('D:\\Fixtures\\narrow_doc.pdf')).toBeInTheDocument()
  })

  it('submits on Enter keyDown, clears on Escape with focus return, and applies photo quick filters + empty index disclosures', async () => {
    const searchUnifiedPhotos = vi.fn(async () =>
      makePhotosResponse({
        items: [],
        totalMatched: 0,
        eligibleCount: 0,
        unindexedCount: 4
      })
    )
    const searchUnifiedDocuments = vi.fn(async () =>
      makeDocsResponse({
        items: [],
        totalMatched: 0,
        eligibleChunkCount: 0,
        unindexedTracks: 3
      })
    )
    installMockApi({ searchUnifiedPhotos, searchUnifiedDocuments })
    await mountApp()

    const searchInput = screen.getByRole('searchbox', { name: /search/i })
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'bicycle' } })
      fireEvent.keyDown(searchInput, { key: 'Enter' })
    })

    expect(searchUnifiedPhotos).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('unified-photos-empty')).toHaveTextContent(
      /no matching photos found/i
    )
    expect(screen.getByTestId('unified-documents-empty')).toHaveTextContent(
      /no matching documents found/i
    )

    // Photo-only quick filter sends explicit fileTypeBasis & fileTypeValue and discloses scope
    await act(async () => {
      fireEvent.change(screen.getByTestId('unified-photo-format-value'), {
        target: { value: 'jpeg' }
      })
    })

    expect(searchUnifiedPhotos).toHaveBeenLastCalledWith(
      expect.objectContaining({
        photoFilters: expect.objectContaining({
          fileTypeBasis: 'detected_format',
          fileTypeValue: 'jpeg'
        })
      })
    )
    expect(screen.getByTestId('unified-filter-scope-disclosure')).toHaveTextContent(/photos only/i)

    // Escape in Header search input clears search, restores Catalog Inventory, and keeps focus on input
    searchInput.focus()
    await act(async () => {
      fireEvent.keyDown(searchInput, { key: 'Escape' })
    })

    expect(screen.queryByTestId('unified-search-panel')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select Source Folders' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Catalog Inventory' })).toBeInTheDocument()
    expect(searchInput).toHaveValue('')
    expect(document.activeElement).toBe(searchInput)
  })

  it('keeps photo format dropdown enabled when Unknown detected format is selected and switches directly back to All photo formats while preserving active document filters', async () => {
    const searchUnifiedPhotos = vi.fn(async () =>
      makePhotosResponse({
        items: [makePhotoResult(1, 0.42, 1, { fileName: 'unknown_format.jpg' })],
        totalMatched: 1
      })
    )
    const searchUnifiedDocuments = vi.fn(async () =>
      makeDocsResponse({
        items: [makeDocResult(2, { fileName: 'kept_doc.pdf' })],
        totalMatched: 1,
        clutterFilterActive: true
      })
    )

    installMockApi({ searchUnifiedPhotos, searchUnifiedDocuments })
    await mountApp()

    await act(async () => {
      submitHeaderSearch('receipt')
    })

    // Activate a document quick filter first
    await act(async () => {
      fireEvent.click(screen.getByTestId('unified-doc-hide-clutter'))
    })

    const photoFormatSelect = screen.getByTestId('unified-photo-format-value') as HTMLSelectElement
    await act(async () => {
      fireEvent.change(photoFormatSelect, { target: { value: '__unknown__' } })
    })

    expect(photoFormatSelect.value).toBe('__unknown__')
    expect(photoFormatSelect).toBeEnabled()
    expect(searchUnifiedPhotos).toHaveBeenLastCalledWith(
      expect.objectContaining({
        photoFilters: {
          fileTypeBasis: 'detected_format',
          onlyUnknownDetectedFormat: true
        }
      })
    )
    expect(searchUnifiedDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({
        documentFilters: { clutterFilter: 'hide_clutter' }
      })
    )

    // Switch directly back to All photo formats while preserving active document filter
    await act(async () => {
      fireEvent.change(photoFormatSelect, { target: { value: '' } })
    })

    expect(photoFormatSelect.value).toBe('')
    expect(photoFormatSelect).toBeEnabled()
    expect(searchUnifiedPhotos).toHaveBeenLastCalledWith(
      expect.objectContaining({
        photoFilters: undefined
      })
    )
    expect(searchUnifiedDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({
        documentFilters: { clutterFilter: 'hide_clutter' }
      })
    )
    expect(screen.getByTestId('unified-doc-hide-clutter')).toBeChecked()
  })

  it('cancels both active retry owners on Clear after leaving and returning to All Items, and discards late replies', async () => {
    const initialPhoto = deferred<UnifiedSearchPhotosResponse>()
    const initialDoc = deferred<UnifiedSearchDocumentsResponse>()
    const retryPhoto = deferred<UnifiedSearchPhotosResponse>()
    const retryDoc = deferred<UnifiedSearchDocumentsResponse>()

    const searchUnifiedPhotos = vi
      .fn()
      .mockImplementationOnce(() => initialPhoto.promise)
      .mockImplementationOnce(() => retryPhoto.promise)
    const searchUnifiedDocuments = vi
      .fn()
      .mockImplementationOnce(() => initialDoc.promise)
      .mockImplementationOnce(() => retryDoc.promise)

    const api = installMockApi({ searchUnifiedPhotos, searchUnifiedDocuments })
    await mountApp()

    submitHeaderSearch('sunset')
    const initialGen = searchUnifiedPhotos.mock.calls[0]![0].ownerGen
    expect(searchUnifiedDocuments.mock.calls[0]![0].ownerGen).toBe(initialGen)

    // Leave All Items while both searches are pending, then return
    const nav = screen.getByRole('navigation', { name: /views/i })
    await act(async () => {
      fireEvent.click(within(nav).getByRole('button', { name: 'Photos' }))
    })
    expect(api.cancelUnifiedSearch).toHaveBeenCalledWith({
      ownerSurface: 'unified',
      ownerGen: initialGen,
      modality: 'all'
    })

    await act(async () => {
      fireEvent.click(within(nav).getByRole('button', { name: 'All Items' }))
    })

    // Retry both modalities concurrently
    await act(async () => {
      fireEvent.click(screen.getByTestId('unified-photos-retry-btn'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('unified-documents-retry-btn'))
    })

    const retryPhotoGen = searchUnifiedPhotos.mock.calls[1]![0].ownerGen
    const retryDocGen = searchUnifiedDocuments.mock.calls[1]![0].ownerGen
    expect(retryPhotoGen).toBeGreaterThan(initialGen)
    expect(retryDocGen).toBeGreaterThan(retryPhotoGen)

    // Clear must cancel BOTH active retry request owners and restore default view + focus
    await act(async () => {
      fireEvent.click(screen.getByTestId('unified-search-clear-btn'))
    })

    expect(api.cancelUnifiedSearch).toHaveBeenCalledWith({
      ownerSurface: 'unified',
      ownerGen: retryPhotoGen,
      modality: 'photos'
    })
    expect(api.cancelUnifiedSearch).toHaveBeenCalledWith({
      ownerSurface: 'unified',
      ownerGen: retryDocGen,
      modality: 'documents'
    })
    expect(screen.queryByTestId('unified-search-panel')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select Source Folders' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Catalog Inventory' })).toBeInTheDocument()
    const currentSearchInput = screen.getByRole('searchbox', { name: /search/i })
    expect(currentSearchInput).toHaveValue('')
    expect(document.activeElement).toBe(currentSearchInput)

    // Late replies from both initial and retry requests cannot restore cleared results
    await act(async () => {
      initialPhoto.resolve(
        makePhotosResponse({
          items: [makePhotoResult(1, 0.8, 1, { fileName: 'late_initial_photo.jpg' })]
        })
      )
      initialDoc.resolve(
        makeDocsResponse({
          items: [makeDocResult(2, { fileName: 'late_initial_doc.pdf' })]
        })
      )
      retryPhoto.resolve(
        makePhotosResponse({
          items: [makePhotoResult(3, 0.9, 1, { fileName: 'late_retry_photo.jpg' })]
        })
      )
      retryDoc.resolve(
        makeDocsResponse({
          items: [makeDocResult(4, { fileName: 'late_retry_doc.pdf' })]
        })
      )
    })

    expect(screen.queryByTestId('unified-search-panel')).not.toBeInTheDocument()
    expect(screen.queryByText('late_retry_photo.jpg')).not.toBeInTheDocument()
    expect(screen.queryByText('late_retry_doc.pdf')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Catalog Inventory' })).toBeInTheDocument()
  })

  it('surfaces coverage.staleTracks > 0 when stale tracks are the only document partial-coverage signal', async () => {
    installMockApi({
      searchUnifiedDocuments: vi.fn(async () =>
        makeDocsResponse({
          items: [makeDocResult(15, { fileName: 'stale_context_doc.pdf' })],
          totalMatched: 1,
          queryTruncated: false,
          corruptChunkCount: 0,
          unindexedTracks: 0,
          staleTracks: 2
        })
      )
    })

    await mountApp()
    await act(async () => {
      submitHeaderSearch('contract')
    })

    const docsSection = screen.getByTestId('unified-documents-section')
    expect(within(docsSection).getByText(/2 stale document tracks/i)).toBeInTheDocument()
  })
})
