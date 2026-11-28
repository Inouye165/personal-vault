import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import { PhotoSelectedOcrSection } from '../../src/renderer/src/components/PhotoSelectedOcrSection'
import type { VaultApi } from '../../src/preload/index.d'
import type {
  MetadataAwarePhotoSearchRequest,
  MetadataAwarePhotoSearchResponse,
  PhotoItem,
  SemanticSearchResponse
} from '../../src/shared/validation/ipc-schemas'

function makePhoto(id: number, fileName = `photo_${id}.jpg`): PhotoItem {
  return {
    id,
    sourceId: 1,
    originalPath: `D:\\Fixtures\\${fileName}`,
    fileName,
    extension: '.jpg',
    category: 'photo',
    discoveryObservationId: id,
    byteSize: 1024 * 1024,
    filesystemBirthtimeMs: 1700000000000,
    filesystemMtimeMs: 1700000000000,
    inferredCaptureTimeMs: 1700000000000,
    firstDiscoveredAtMs: 1700000000000,
    lastSeenAtMs: 1700000000000,
    activeHash: 'b'.repeat(64),
    activeHashVerifiedAtMs: 1700000000000,
    rating: null,
    flag: 'none',
    annotationVersion: 0
  }
}

function makeSearchResponse(
  ranked: Array<{ photo: PhotoItem; score: number }>
): SemanticSearchResponse {
  return {
    items: ranked.map((entry, idx) => ({
      photo: entry.photo,
      score: entry.score,
      rank: idx + 1
    })),
    totalMatched: ranked.length,
    eligibleCount: 26,
    unindexedCount: 0,
    staleCount: 0,
    corruptCount: 0,
    offset: 0,
    limit: 50,
    hasMore: false,
    queryLatencyMs: 42,
    truncated: false,
    tokenCount: 2,
    modelStatus: 'ready'
  }
}

describe('Photos search results hierarchy and Copy text UX', () => {
  let photos: PhotoItem[]

  beforeEach(() => {
    vi.restoreAllMocks()
    photos = [
      makePhoto(1, 'employee_schedule.jpg'),
      makePhoto(2, 'schedule_screenshot.jpg'),
      makePhoto(3, 'weekend_dog.jpg'),
      makePhoto(4, 'living_room.jpg'),
      makePhoto(5, 'family_dinner.jpg')
    ]

    window.api = {
      getPhotosPage: vi.fn(async () => ({
        items: photos,
        totalCount: photos.length,
        offset: 0,
        limit: 50,
        hasMore: false
      })),
      getThumbnail: vi.fn(async ({ locationId }: { locationId: number }) => ({
        status: 'ready' as const,
        locationId,
        dataUrl: 'data:image/webp;base64,TEST',
        mimeType: 'image/webp',
        width: 320,
        height: 240
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
      listCollections: vi.fn(async () => ({
        items: [],
        total: 0,
        offset: 0,
        limit: 50
      })),
      listPhotoMemberships: vi.fn(async () => ({
        items: [],
        total: 0,
        offset: 0,
        limit: 50
      })),
      getPhotoMetadata: vi.fn(async () => null),
      getPhotoMetadataFacets: vi.fn(async () => ({ years: [], cameras: [] })),
      getSemanticModelStatus: vi.fn(async () => ({
        state: 'ready' as const,
        modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
        modelCommit: '6b7c523703ae26e39be4b03774966f8571c7f523',
        modelManifestSha256: 'a'.repeat(64),
        preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
        dimensions: 512,
        requiredBytes: 155851918,
        downloadedBytes: 155851918,
        currentArtifact: null,
        verifiedAtMs: 1700000000000,
        error: null,
        lastReplacementError: null
      })),
      getSemanticIndexProgress: vi.fn(async () => ({
        jobId: null,
        status: 'idle' as const,
        modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
        modelCommit: '6b7c523703ae26e39be4b03774966f8571c7f523',
        preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
        totalPhotos: 5,
        processedPhotos: 5,
        reusedPhotos: 0,
        unsupportedPhotos: 0,
        failedPhotos: 0,
        pendingPhotos: 0,
        totalCatalogPhotos: 5,
        currentIndexedPhotos: 5,
        startedAtMs: null,
        updatedAtMs: 1700000000000,
        completedAtMs: null,
        lastError: null
      })),
      onSemanticModelStatus: vi.fn(() => () => {}),
      onSemanticIndexProgress: vi.fn(() => () => {}),
      searchPhotosSemantic: vi.fn(async ({ queryText }: { queryText: string }) => {
        if (queryText === 'two only') {
          return makeSearchResponse([
            { photo: photos[0]!, score: 0.312 },
            { photo: photos[1]!, score: 0.264 }
          ])
        }
        return makeSearchResponse([
          { photo: photos[0]!, score: 0.312 },
          { photo: photos[1]!, score: 0.264 },
          { photo: photos[2]!, score: 0.221 },
          { photo: photos[3]!, score: 0.215 },
          { photo: photos[4]!, score: 0.205 }
        ])
      }),
      cancelPhotosSemanticSearch: vi.fn(async () => ({ cancelled: true }))
    } as unknown as VaultApi
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'api')
  })

  it('renders all search results immediately in the normal grid from #1 without Top results or expand toggles', async () => {
    vi.mocked(window.api.searchPhotosSemantic).mockImplementation(async ({ offset = 0 }) => ({
      ...makeSearchResponse(
        offset === 0
          ? [
              { photo: photos[0]!, score: 0.312 },
              { photo: photos[1]!, score: 0.264 },
              { photo: photos[2]!, score: 0.221 },
              { photo: photos[3]!, score: 0.215 },
              { photo: photos[4]!, score: 0.205 }
            ]
          : []
      ),
      totalMatched: 5,
      unindexedCount: 12,
      eligibleCount: 14,
      offset
    }))

    await act(async () => {
      render(<PhotosPanel />)
    })

    const searchInput = await screen.findByPlaceholderText(/search photos by description/i)
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'employee schedule' } })
      fireEvent.submit(searchInput.closest('form')!)
    })

    const grid = document.querySelector('.photos-grid-container') as HTMLDivElement
    expect(grid).not.toBeNull()

    await waitFor(() => {
      expect(within(grid).getByText('employee_schedule.jpg')).toBeInTheDocument()
    })

    // No separate Top results cards, Other results section, or expand button
    expect(screen.queryByTestId('photos-top-results')).toBeNull()
    expect(screen.queryByTestId('photos-other-results-section')).toBeNull()
    expect(screen.queryByTestId('photos-toggle-other-results-btn')).toBeNull()
    expect(document.querySelector('.photo-featured-card')).toBeNull()

    // Result count and partial-results notice remain visible
    expect(screen.getByTestId('search-match-badge')).toHaveTextContent('5 semantic matches')
    expect(screen.getByTestId('search-partial-results-notice')).toHaveTextContent(
      /Partial results — 12 unindexed \(14 searched\)/i
    )

    // Results #1..#5 appear immediately in order as ordinary photo-cell tiles without clicking anything
    const tiles = Array.from(grid.querySelectorAll('.photo-card.photo-cell')) as HTMLDivElement[]
    expect(tiles.map((t) => t.id)).toEqual([
      'photo-cell-1',
      'photo-cell-2',
      'photo-cell-3',
      'photo-cell-4',
      'photo-cell-5'
    ])
    expect(within(grid).getByText('weekend_dog.jpg')).toBeInTheDocument()
    expect(within(grid).getByText('living_room.jpg')).toBeInTheDocument()
    expect(within(grid).getByText('family_dinner.jpg')).toBeInTheDocument()

    // Results #1, #2, and #3 share uniform grid tile dimensions, starting at (0, 0)
    expect(tiles[0]!.style.top).toBe('0px')
    expect(tiles[0]!.style.left).toBe('0px')
    expect(tiles[0]!.style.width).toBe(tiles[2]!.style.width)
    expect(tiles[1]!.style.width).toBe(tiles[2]!.style.width)
    expect(tiles[0]!.style.height).toBe(tiles[2]!.style.height)
    expect(tiles[1]!.style.height).toBe(tiles[2]!.style.height)

    // Raw "% match" overlay must not clutter thumbnail cards in the grid
    expect(document.querySelector('.badge-similarity-score')).toBeNull()
    expect(screen.queryByText(/31% match/i)).not.toBeInTheDocument()

    // Selecting Details on result #1 opens Photograph Details with similarity score and Open original
    await act(async () => {
      fireEvent.click(within(tiles[0]!).getByRole('button', { name: /Details for/i }))
    })

    const scoreDetail = await screen.findByTestId('photo-search-similarity-detail')
    expect(scoreDetail).toHaveTextContent('0.312')
    expect(scoreDetail).toHaveTextContent(/not a probability/i)
    expect(screen.getByTestId('photos-open-original-btn')).toBeInTheDocument()
  })

  it('paginates 179 visual/hybrid results smoothly across page boundaries without duplicates or gaps and preserves metadata-only ordering', async () => {
    const hawaiiPhotos = Array.from({ length: 179 }, (_, i) =>
      makePhoto(1001 + i, `hawaii_${i + 1}.jpg`)
    )
    const metadataOnlyPhotos = [
      makePhoto(2001, 'meta_c_third.jpg'),
      makePhoto(2002, 'meta_a_first.jpg'),
      makePhoto(2003, 'meta_b_second.jpg'),
      makePhoto(2004, 'meta_d_fourth.jpg')
    ]

    const searchMetadataAwareMock = vi.fn(
      async (req: MetadataAwarePhotoSearchRequest): Promise<MetadataAwarePhotoSearchResponse> => {
        const offset = req.offset ?? 0
        const limit = req.limit ?? 50
        if (req.queryText === 'meta only') {
          const slice = metadataOnlyPhotos.slice(offset, offset + limit)
          return {
            mode: 'metadata_only',
            items: slice.map((photo, idx) => ({
              photo,
              score: null,
              rank: offset + idx + 1,
              matchSource: 'metadata' as const
            })),
            totalMatched: metadataOnlyPhotos.length,
            filteredCandidateCount: metadataOnlyPhotos.length,
            eligibleCount: metadataOnlyPhotos.length,
            unindexedCount: 0,
            staleCount: 0,
            corruptCount: 0,
            offset,
            limit,
            hasMore: offset + slice.length < metadataOnlyPhotos.length,
            queryLatencyMs: 6,
            interpretedFilters: {
              place: null,
              date: {
                mode: 'year',
                label: '2025',
                captureDateFrom: '2025-01-01',
                captureDateTo: '2025-12-31'
              },
              camera: null,
              visualTerms: null
            },
            clarification: null,
            visualModelRequired: false,
            modelStatus: 'ready'
          }
        }

        const slice = hawaiiPhotos.slice(offset, offset + limit)
        return {
          mode: 'hybrid',
          items: slice.map((photo, idx) => ({
            photo,
            score: Number((0.9 - (offset + idx) * 0.002).toFixed(4)),
            rank: offset + idx + 1,
            matchSource: 'hybrid' as const
          })),
          totalMatched: hawaiiPhotos.length,
          filteredCandidateCount: 300,
          eligibleCount: 250,
          unindexedCount: 50,
          staleCount: 0,
          corruptCount: 0,
          offset,
          limit,
          hasMore: offset + slice.length < hawaiiPhotos.length,
          queryLatencyMs: 18,
          interpretedFilters: {
            place: null,
            date: null,
            camera: null,
            visualTerms: 'Hawaii'
          },
          clarification: null,
          visualModelRequired: false,
          modelStatus: 'ready'
        }
      }
    )

    window.api = {
      ...window.api,
      searchPhotosMetadataAware: searchMetadataAwareMock
    } as unknown as VaultApi

    await act(async () => {
      render(<PhotosPanel />)
    })

    const searchInput = await screen.findByPlaceholderText(/search photos by description/i)
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'Hawaii' } })
      fireEvent.submit(searchInput.closest('form')!)
    })

    const grid = document.querySelector('.photos-grid-container') as HTMLDivElement
    expect(grid).not.toBeNull()

    await waitFor(() => {
      expect(within(grid).getByText('hawaii_1.jpg')).toBeInTheDocument()
      expect(within(grid).getByText('hawaii_2.jpg')).toBeInTheDocument()
      expect(within(grid).getByText('hawaii_3.jpg')).toBeInTheDocument()
    })

    expect(screen.queryByTestId('photos-top-results')).toBeNull()
    expect(screen.queryByTestId('photos-toggle-other-results-btn')).toBeNull()
    expect(screen.getByTestId('search-match-badge')).toHaveTextContent('179 semantic matches')
    expect(screen.getByTestId('search-partial-results-notice')).toHaveTextContent(
      /Partial results — 50 unindexed \(250 searched\)/i
    )

    const virtualHeight = Number.parseInt(
      (document.querySelector('.photos-virtual-container') as HTMLDivElement).style.height || '0',
      10
    )
    expect(virtualHeight).toBeGreaterThan(0)

    // Scroll across page 0->1, 1->2, and 2->3 boundaries and collect rendered tiles in visual order
    const seenIds = new Set<string>()
    const orderedIds: string[] = []
    const recordVisibleTiles = () => {
      const tiles = Array.from(grid.querySelectorAll('.photo-card.photo-cell'))
        .map((el) => ({
          id: el.id,
          top: Number.parseInt((el as HTMLElement).style.top || '0', 10),
          left: Number.parseInt((el as HTMLElement).style.left || '0', 10)
        }))
        .sort((a, b) => a.top - b.top || a.left - b.left)

      // No duplicate IDs rendered simultaneously in the DOM
      expect(new Set(tiles.map((t) => t.id)).size).toBe(tiles.length)
      for (const tile of tiles) {
        if (!seenIds.has(tile.id)) {
          seenIds.add(tile.id)
          orderedIds.push(tile.id)
        }
      }
    }

    recordVisibleTiles()
    const scrollStops = [
      Math.floor(virtualHeight * 0.26),
      Math.floor(virtualHeight * 0.54),
      Math.floor(virtualHeight * 0.85),
      virtualHeight
    ]
    for (const stop of scrollStops) {
      await act(async () => {
        fireEvent.scroll(grid, { target: { scrollTop: stop } })
      })
      await waitFor(() => {
        expect(grid.querySelectorAll('.photo-skeleton').length).toBe(0)
      })
      recordVisibleTiles()
    }

    // Verify all 4 pages (offsets 0, 50, 100, 150) loaded in order and boundary items appeared cleanly
    const requestedOffsets = searchMetadataAwareMock.mock.calls.map((c) => c[0]?.offset ?? 0)
    expect(requestedOffsets.filter((o) => o < 179)).toEqual([0, 50, 100, 150])
    expect(within(grid).getByText('hawaii_179.jpg')).toBeInTheDocument()
    expect(orderedIds.slice(0, 3)).toEqual([
      'photo-cell-1001',
      'photo-cell-1002',
      'photo-cell-1003'
    ])
    // Boundary pairs 50/51 and 100/101 must remain contiguous without drops or duplicates
    for (const boundaryId of [
      'photo-cell-1050',
      'photo-cell-1051',
      'photo-cell-1100',
      'photo-cell-1101'
    ]) {
      expect(seenIds.has(boundaryId)).toBe(true)
    }
    const idx50 = orderedIds.indexOf('photo-cell-1050')
    expect(orderedIds[idx50 + 1]).toBe('photo-cell-1051')
    const idx100 = orderedIds.indexOf('photo-cell-1100')
    expect(orderedIds[idx100 + 1]).toBe('photo-cell-1101')

    // Metadata-only search preserves returned order in the same normal grid
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'meta only' } })
      fireEvent.submit(searchInput.closest('form')!)
    })
    let metaGrid!: HTMLDivElement
    await waitFor(() => {
      metaGrid = document.querySelector('.photos-grid-container') as HTMLDivElement
      expect(metaGrid).not.toBeNull()
      expect(within(metaGrid).getByText('meta_c_third.jpg')).toBeInTheDocument()
    })
    const metaTiles = Array.from(
      metaGrid.querySelectorAll('.photo-card.photo-cell')
    ) as HTMLDivElement[]
    expect(metaTiles.map((t) => t.id)).toEqual([
      'photo-cell-2001',
      'photo-cell-2002',
      'photo-cell-2003',
      'photo-cell-2004'
    ])
    expect(screen.queryByTestId('photos-top-results')).toBeNull()
    expect(screen.queryByTestId('photos-toggle-other-results-btn')).toBeNull()
  })

  it('evicts Page 0 during deep search scroll and reloads Page 0 only when returning to top', async () => {
    const totalMatched = 2500
    const offsetZeroRequests: number[] = []
    vi.mocked(window.api.searchPhotosSemantic).mockImplementation(async (req) => {
      const offset = req.offset ?? 0
      const limit = req.limit ?? 50
      if (offset === 0) {
        offsetZeroRequests.push(offset)
      }
      const items = Array.from({ length: Math.min(limit, totalMatched - offset) }, (_, i) => {
        const id = offset + i + 1
        return {
          photo: makePhoto(id, `search_photo_${id}.jpg`),
          score: 0.9 - id * 0.0001,
          rank: id
        }
      })
      return {
        items,
        totalMatched,
        eligibleCount: totalMatched,
        unindexedCount: 0,
        staleCount: 0,
        corruptCount: 0,
        offset,
        limit,
        hasMore: offset + items.length < totalMatched,
        queryLatencyMs: 12,
        truncated: false,
        tokenCount: 2,
        modelStatus: 'ready'
      }
    })

    await act(async () => {
      render(<PhotosPanel />)
    })

    const searchInput = await screen.findByPlaceholderText(/search photos by description/i)
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'ocean landscape' } })
      fireEvent.submit(searchInput.closest('form')!)
    })

    const grid = document.querySelector('.photos-grid-container') as HTMLDivElement
    expect(grid).not.toBeNull()
    await waitFor(() => {
      expect(within(grid).getByText('search_photo_1.jpg')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('photos-toggle-other-results-btn')).toBeNull()
    const scrollHeight = Number.parseInt(
      (document.querySelector('.photos-virtual-container') as HTMLDivElement).style.height ||
        '120000',
      10
    )

    // Traverse through 42+ pages across the unified virtualized grid
    const observedPages = new Set<number>([0])
    for (let p = 1; p <= 44; p += 1) {
      const targetScroll = Math.max(
        2000,
        Math.floor(((p * 50) / totalMatched) * Math.max(1, scrollHeight))
      )
      await act(async () => {
        fireEvent.scroll(grid, { target: { scrollTop: targetScroll } })
      })
      await waitFor(() => {
        const pagesAttr = grid.getAttribute('data-cached-pages') ?? ''
        const cached = pagesAttr.split(',').filter(Boolean).map(Number)
        for (const cp of cached) observedPages.add(cp)
        expect(cached).toContain(p)
      })
    }

    expect(observedPages.size).toBeGreaterThan(40)
    // Page 0 must have been evicted rather than pinned MRU
    const pagesAfterDeepScroll = (grid.getAttribute('data-cached-pages') ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number)
    expect(pagesAfterDeepScroll).not.toContain(0)
    expect(Number(grid.getAttribute('data-search-score-count'))).toBe(2000)
    expect(offsetZeroRequests).toHaveLength(1)

    // Scroll back to top (scrollTop = 0) and confirm Page 0 reloads cleanly in the grid
    await act(async () => {
      fireEvent.scroll(grid, { target: { scrollTop: 0 } })
    })
    await waitFor(() => {
      const cached = (grid.getAttribute('data-cached-pages') ?? '')
        .split(',')
        .filter(Boolean)
        .map(Number)
      expect(cached).toContain(0)
    })
    expect(offsetZeroRequests).toHaveLength(2)
    expect(within(grid).getByText('search_photo_1.jpg')).toBeInTheDocument()
    expect(document.getElementById('photo-cell-1')).toBeInTheDocument()
  })

  it('shows Copy text in PhotoSelectedOcrSection only when extracted text and clipboard writeText exist', async () => {
    const writeTextMock = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock }
    })

    window.api = {
      ...window.api,
      getOcrModelStatus: vi.fn(async () => ({
        state: 'ready' as const,
        modelId: 'tesseract-eng',
        language: 'eng',
        requiredBytes: 1000,
        downloadedBytes: 1000,
        verifiedAtMs: 1700000000000,
        error: null,
        activeDir: 'C:\\ocr',
        lastReplacementError: null
      })),
      getDocumentOcrProgress: vi.fn(async () => ({
        jobId: null,
        status: 'idle' as const,
        totalDocuments: 0,
        processedDocuments: 0,
        succeededDocuments: 0,
        failedDocuments: 0,
        skippedDocuments: 0,
        startedAtMs: null,
        updatedAtMs: Date.now(),
        completedAtMs: null,
        lastError: null
      })),
      getDocumentOcrState: vi.fn(async () => ({
        state: {
          fileLocationId: 1,
          ocrStatus: 'extracted' as const,
          ocrModelId: 'tesseract-eng',
          ocrLanguage: 'eng',
          updatedAtMs: 1700000000000,
          statusDetail: null
        }
      })),
      getDocumentOcrPreview: vi.fn(async () => ({
        preview: {
          fileLocationId: 1,
          ocrStatus: 'extracted' as const,
          extractedText: 'Mon 9:00 AM - 5:00 PM',
          statusDetail: null
        }
      })),
      onOcrModelStatus: vi.fn(() => () => {}),
      onDocumentOcrProgress: vi.fn(() => () => {}),
      ocrSelectedDocuments: vi.fn()
    } as unknown as VaultApi

    await act(async () => {
      render(<PhotoSelectedOcrSection fileLocationId={1} extension=".jpg" />)
    })

    const copyBtn = await screen.findByTestId('copy-extracted-text-btn')
    expect(copyBtn).toHaveTextContent(/copy text/i)

    await act(async () => {
      fireEvent.click(copyBtn)
    })

    expect(writeTextMock).toHaveBeenCalledWith('Mon 9:00 AM - 5:00 PM')
  })
})
