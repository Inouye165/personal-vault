import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePhotos } from '../../src/renderer/src/hooks/usePhotos'
import { useDocuments } from '../../src/renderer/src/hooks/useDocuments'
import type { VaultApi } from '../../src/preload/index.d'

describe('Stage 7F Slice 1: Monotonic Search Owner Generations Across Unmount/Remount', () => {
  const originalApi = window.api

  beforeEach(() => {
    vi.restoreAllMocks()
    window.api = {
      ...originalApi,
      getPhotosPage: vi.fn().mockResolvedValue({
        items: [],
        totalCount: 0,
        offset: 0,
        limit: 50,
        hasMore: false
      }),
      getThumbnail: vi.fn().mockResolvedValue({ status: 'missing', locationId: 1 }),
      getSemanticModelStatus: vi.fn().mockResolvedValue({
        state: 'ready',
        error: null,
        activeDir: 'C:\\models\\clip',
        verifiedAtMs: 1700000000000
      }),
      searchPhotosSemantic: vi.fn().mockResolvedValue({
        items: [],
        totalMatched: 0,
        eligibleCount: 0,
        unindexedCount: 0,
        staleCount: 0,
        corruptCount: 0,
        offset: 0,
        limit: 50,
        hasMore: false,
        queryLatencyMs: 1,
        truncated: false,
        tokenCount: 1,
        modelStatus: 'ready'
      }),
      cancelPhotosSemanticSearch: vi.fn().mockResolvedValue({ cancelled: true }),
      getDocumentsPage: vi.fn().mockResolvedValue({
        items: [],
        totalCount: 0,
        offset: 0,
        limit: 50,
        hiddenClutterCount: 0
      }),
      getDocumentDetail: vi.fn().mockResolvedValue({ item: null }),
      getDocumentExtensionFacets: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
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
      getDocumentSemanticProgress: vi.fn().mockResolvedValue(null),
      getDocumentClassificationProgress: vi.fn().mockResolvedValue(null),
      onDocumentClassificationProgress: vi.fn().mockReturnValue(() => {}),
      getDocumentClassificationFacets: vi.fn().mockResolvedValue(null),
      searchDocumentsSemantic: vi.fn().mockResolvedValue({
        items: [],
        totalMatched: 0,
        hasMore: false,
        eligibleChunkCount: 0,
        corruptChunkCount: 0,
        queryTokenCount: 1,
        queryTruncated: false,
        queryLatencyMs: 1,
        coverage: {
          totalDocuments: 0,
          indexedDocuments: 0,
          truncatedDocuments: 0,
          staleDocuments: 0,
          failedDocuments: 0,
          unindexedDocuments: 0,
          eligibleNativeDocuments: 0,
          eligibleOcrDocuments: 0
        }
      }),
      cancelDocumentSemanticSearch: vi.fn().mockResolvedValue({ cancelled: true })
    } as unknown as VaultApi
  })

  afterEach(() => {
    window.api = originalApi
  })

  it('never reuses ownerGen across unmount/remount in usePhotos and cancels active ownerGen on unmount', async () => {
    const first = renderHook(() => usePhotos())
    await act(async () => {
      first.result.current.setSearchQuery('sunset')
    })
    const firstCallArgs = vi.mocked(window.api.searchPhotosSemantic).mock.calls[0]?.[0]
    expect(firstCallArgs?.ownerGen).toBeTypeOf('number')
    const gen1 = firstCallArgs!.ownerGen!

    first.unmount()
    expect(window.api.cancelPhotosSemanticSearch).toHaveBeenCalledWith({ ownerGen: gen1 })

    const second = renderHook(() => usePhotos())
    await act(async () => {
      second.result.current.setSearchQuery('sunset')
    })
    const secondCallArgs = vi.mocked(window.api.searchPhotosSemantic).mock.calls[1]?.[0]
    const gen2 = secondCallArgs!.ownerGen!
    expect(gen2).toBeGreaterThan(gen1)
    second.unmount()
  })

  it('never reuses ownerGen across unmount/remount in useDocuments and preserves ownerGen for same-query pagination', async () => {
    const first = renderHook(() => useDocuments())
    await act(async () => {
      await first.result.current.runDocSemanticSearch('receipt', 0)
    })
    const gen1 = vi.mocked(window.api.searchDocumentsSemantic).mock.calls[0]?.[0]?.ownerGen
    expect(gen1).toBeTypeOf('number')

    // Same-query pagination keeps the same ownerGen
    await act(async () => {
      await first.result.current.runDocSemanticSearch('receipt', 50)
    })
    const page2Gen = vi.mocked(window.api.searchDocumentsSemantic).mock.calls[1]?.[0]?.ownerGen
    expect(page2Gen).toBe(gen1)

    first.unmount()
    expect(window.api.cancelDocumentSemanticSearch).toHaveBeenCalledWith({ ownerGen: gen1 })

    const second = renderHook(() => useDocuments())
    await act(async () => {
      await second.result.current.runDocSemanticSearch('receipt', 0)
    })
    const gen2 = vi.mocked(window.api.searchDocumentsSemantic).mock.calls[2]?.[0]?.ownerGen
    expect(gen2).toBeGreaterThan(gen1!)
    second.unmount()
  })

  it('allocates exactly one ownerGen per non-empty usePhotos query, preserves it across pagination, and bumps on filter changes', async () => {
    const { result, unmount } = renderHook(() => usePhotos())

    await act(async () => {
      result.current.setSearchQuery('sunset')
    })
    const gen1 = vi.mocked(window.api.searchPhotosSemantic).mock.calls[0]?.[0]?.ownerGen
    expect(gen1).toBeTypeOf('number')

    // Pagination keeps the same ownerGen
    await act(async () => {
      result.current.ensureRangeLoaded(50, 100)
    })
    const page1Args = vi.mocked(window.api.searchPhotosSemantic).mock.calls[1]?.[0]
    expect(page1Args?.offset).toBe(50)
    expect(page1Args?.ownerGen).toBe(gen1)

    // Filter change while searching bumps ownerGen by 1
    await act(async () => {
      result.current.setRatingFilter('4')
    })
    const filterGen = vi.mocked(window.api.searchPhotosSemantic).mock.calls.at(-1)?.[0]?.ownerGen
    expect(filterGen).toBe(gen1! + 1)

    // Subsequent setSearchQuery allocates exactly once (filterGen + 1, no skipped ID)
    await act(async () => {
      result.current.setSearchQuery('beach')
    })
    const nextQueryGen = vi.mocked(window.api.searchPhotosSemantic).mock.calls.at(-1)?.[0]?.ownerGen
    expect(nextQueryGen).toBe(filterGen! + 1)

    unmount()
    expect(window.api.cancelPhotosSemanticSearch).toHaveBeenCalledWith({ ownerGen: nextQueryGen })
  })
})
