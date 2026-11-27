import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePhotos, PHOTO_BOUNDS } from '../../src/renderer/src/hooks/usePhotos'
import type { VaultApi } from '../../src/preload/index.d'
import type { PhotoItem, SemanticSearchResponse } from '../../src/shared/validation/ipc-schemas'

function makeMockPhoto(id: number): PhotoItem {
  return {
    id,
    sourceId: 1,
    originalPath: `C:\\Photos\\photo_${id}.jpg`,
    fileName: `photo_${id}.jpg`,
    extension: '.jpg',
    category: 'photo',
    discoveryObservationId: id,
    byteSize: 2048,
    filesystemBirthtimeMs: 1700000000000,
    filesystemMtimeMs: 1700000000000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1700000000000,
    lastSeenAtMs: 1700000000000,
    activeHash: 'f'.repeat(64),
    activeHashVerifiedAtMs: 1700000000000,
    rating: null,
    flag: 'none',
    annotationVersion: 0
  }
}

describe('Stage 6D: usePhotos Semantic Search & Retained Memory Integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.api = {
      ...window.api,
      getPhotosPage: vi.fn().mockResolvedValue({
        items: [],
        totalCount: 0,
        offset: 0,
        limit: 50,
        hasMore: false
      }),
      getThumbnail: vi.fn().mockResolvedValue({
        status: 'missing',
        locationId: 1
      }),
      getSemanticModelStatus: vi.fn().mockResolvedValue({
        state: 'ready',
        error: null,
        activeDir: 'C:\\models\\clip',
        verifiedAtMs: 1700000000000
      }),
      searchPhotosSemantic: vi.fn(),
      cancelPhotosSemanticSearch: vi.fn().mockResolvedValue({ cancelled: true })
    } as unknown as VaultApi
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('populates searchScores and searchResultMeta on successful search', async () => {
    const mockPhotos = [makeMockPhoto(1), makeMockPhoto(2)]
    const mockSearchResponse: SemanticSearchResponse = {
      items: [
        { photo: mockPhotos[0]!, score: 0.88, rank: 1 },
        { photo: mockPhotos[1]!, score: 0.75, rank: 2 }
      ],
      totalMatched: 2,
      eligibleCount: 10,
      unindexedCount: 0,
      staleCount: 0,
      corruptCount: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      queryLatencyMs: 15,
      truncated: false,
      tokenCount: 4,
      modelStatus: 'ready'
    }

    vi.mocked(window.api.searchPhotosSemantic).mockResolvedValue(mockSearchResponse)

    const { result } = renderHook(() => usePhotos())

    await act(async () => {
      result.current.setSearchQuery('forest waterfall')
    })

    expect(window.api.searchPhotosSemantic).toHaveBeenCalledWith(
      expect.objectContaining({
        queryText: 'forest waterfall',
        offset: 0
      })
    )

    expect(result.current.searchScores.get(1)).toBeCloseTo(0.88, 2)
    expect(result.current.searchScores.get(2)).toBeCloseTo(0.75, 2)
    expect(result.current.searchResultMeta?.totalMatched).toBe(2)
  })

  it('discards delayed/out-of-order page responses from older query generations without showing error', async () => {
    let resolveFirstQuery!: (res: SemanticSearchResponse) => void
    const firstPromise = new Promise<SemanticSearchResponse>((res) => {
      resolveFirstQuery = res
    })

    const secondResponse: SemanticSearchResponse = {
      items: [{ photo: makeMockPhoto(100), score: 0.95, rank: 1 }],
      totalMatched: 1,
      eligibleCount: 1,
      unindexedCount: 0,
      staleCount: 0,
      corruptCount: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      queryLatencyMs: 8,
      truncated: false,
      tokenCount: 2,
      modelStatus: 'ready'
    }

    vi.mocked(window.api.searchPhotosSemantic)
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce(secondResponse)

    const { result } = renderHook(() => usePhotos())

    // 1. Start query 'cat' (slow / delayed)
    act(() => {
      result.current.setSearchQuery('cat')
    })

    // 2. Rapidly replace with query 'dog'
    await act(async () => {
      result.current.setSearchQuery('dog')
    })

    // Now resolve the delayed 'cat' response
    await act(async () => {
      resolveFirstQuery({
        items: [{ photo: makeMockPhoto(999), score: 0.5, rank: 1 }],
        totalMatched: 1,
        eligibleCount: 1,
        unindexedCount: 0,
        staleCount: 0,
        corruptCount: 0,
        offset: 0,
        limit: 50,
        hasMore: false,
        queryLatencyMs: 100,
        truncated: false,
        tokenCount: 1,
        modelStatus: 'ready'
      })
    })

    // The delayed 'cat' photo (999) must NOT be present; only 'dog' photo (100) must be present
    expect(result.current.searchScores.has(999)).toBe(false)
    expect(result.current.searchScores.has(100)).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('clearing search resets searchScores, cancels active search, and restores normal browsing', async () => {
    const mockPhotos = [makeMockPhoto(5)]
    vi.mocked(window.api.searchPhotosSemantic).mockResolvedValue({
      items: [{ photo: mockPhotos[0]!, score: 0.9, rank: 1 }],
      totalMatched: 1,
      eligibleCount: 1,
      unindexedCount: 0,
      staleCount: 0,
      corruptCount: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      queryLatencyMs: 10,
      truncated: false,
      tokenCount: 2,
      modelStatus: 'ready'
    })

    const { result } = renderHook(() => usePhotos())

    await act(async () => {
      result.current.setSearchQuery('sunset')
    })

    expect(result.current.searchScores.size).toBe(1)

    // Clear search
    await act(async () => {
      result.current.clearSearch()
    })

    expect(window.api.cancelPhotosSemanticSearch).toHaveBeenCalled()
    expect(result.current.searchScores.size).toBe(0)
    expect(result.current.searchResultMeta).toBeNull()
    expect(result.current.searchQuery).toBe('')
    expect(window.api.getPhotosPage).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0, limit: 50 })
    )
  })

  it('evicts searchScores alongside pages when exceeding MAX_PAGES (40 pages) and reloads on return', async () => {
    vi.mocked(window.api.searchPhotosSemantic).mockImplementation(async (opts) => {
      const pageIndex = Math.floor((opts.offset ?? 0) / PHOTO_BOUNDS.PAGE_SIZE)
      const pagePhoto = makeMockPhoto(10_000 + pageIndex)
      return {
        items: [{ photo: pagePhoto, score: 0.8, rank: opts.offset! + 1 }],
        totalMatched: 50 * PHOTO_BOUNDS.PAGE_SIZE,
        eligibleCount: 50 * PHOTO_BOUNDS.PAGE_SIZE,
        unindexedCount: 0,
        staleCount: 0,
        corruptCount: 0,
        offset: opts.offset ?? 0,
        limit: PHOTO_BOUNDS.PAGE_SIZE,
        hasMore: true,
        queryLatencyMs: 5,
        truncated: false,
        tokenCount: 2,
        modelStatus: 'ready'
      }
    })

    const { result } = renderHook(() => usePhotos())

    await act(async () => {
      result.current.setSearchQuery('ocean')
    })

    // Load pages 0 through 40 (41 pages total, exceeding MAX_PAGES = 40)
    for (let p = 1; p <= 40; p++) {
      await act(async () => {
        result.current.ensureRangeLoaded(
          p * PHOTO_BOUNDS.PAGE_SIZE,
          p * PHOTO_BOUNDS.PAGE_SIZE + 10
        )
      })
    }

    // Page 0 should have been evicted from LRU
    // Photo 10000 (from Page 0) should be evicted from searchScores!
    expect(result.current.searchScores.has(10_000)).toBe(false)
    // Most recent Page 40 photo should be present
    expect(result.current.searchScores.has(10_040)).toBe(true)

    // Total retained searchScores should not exceed MAX_PAGES * itemsPerPage
    expect(result.current.searchScores.size).toBeLessThanOrEqual(
      PHOTO_BOUNDS.MAX_PAGES * PHOTO_BOUNDS.PAGE_SIZE
    )

    // Now return to Page 0 (which will evict Page 1 since LRU had 1..40)
    await act(async () => {
      result.current.ensureRangeLoaded(0, 10)
    })

    // Page 0 should be reloaded and Photo 10000 restored!
    expect(result.current.searchScores.has(10_000)).toBe(true)
    // Still-cached pages (e.g. Page 40 -> Photo 10040, Page 20 -> Photo 10020) MUST retain their scores!
    expect(result.current.searchScores.has(10_040)).toBe(true)
    expect(result.current.searchScores.has(10_020)).toBe(true)
    // Total retained searchScores remains bounded
    expect(result.current.searchScores.size).toBeLessThanOrEqual(
      PHOTO_BOUNDS.MAX_PAGES * PHOTO_BOUNDS.PAGE_SIZE
    )
  })

  it('supports deep jumps beyond offset 10,000 and propagates corruptCount honestly', async () => {
    vi.mocked(window.api.searchPhotosSemantic).mockImplementation(async (opts) => {
      const offset = opts.offset ?? 0
      const pagePhoto = makeMockPhoto(offset + 1)
      return {
        items: [{ photo: pagePhoto, score: 0.72, rank: offset + 1 }],
        totalMatched: 15_000,
        eligibleCount: 14_995,
        unindexedCount: 0,
        staleCount: 0,
        corruptCount: 5,
        offset,
        limit: PHOTO_BOUNDS.PAGE_SIZE,
        hasMore: offset + PHOTO_BOUNDS.PAGE_SIZE < 15_000,
        queryLatencyMs: 9,
        truncated: false,
        tokenCount: 3,
        modelStatus: 'ready'
      }
    })

    const { result } = renderHook(() => usePhotos())

    await act(async () => {
      result.current.setSearchQuery('forest')
    })

    expect(result.current.searchResultMeta?.corruptCount).toBe(5)
    expect(result.current.totalCount).toBe(15_000)

    // Jump directly beyond offset 10,000 (page 210 => offset 10,500)
    await act(async () => {
      result.current.ensureRangeLoaded(10_500, 10_510)
    })

    expect(window.api.searchPhotosSemantic).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 10_500, limit: PHOTO_BOUNDS.PAGE_SIZE })
    )
    expect(result.current.getPhoto(10_500)?.id).toBe(10_501)
    expect(result.current.searchScores.get(10_501)).toBeCloseTo(0.72, 5)
  })
})
