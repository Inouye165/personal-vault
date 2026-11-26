import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import type { VaultApi } from '../../src/preload/index.d'
import type {
  MetadataAwarePhotoSearchRequest,
  MetadataAwarePhotoSearchResponse,
  PhotoItem,
  PhotoMetadataProgressResponse
} from '../../src/shared/validation/ipc-schemas'

function makePhoto(id: number, fileName: string): PhotoItem {
  return {
    id,
    sourceId: 1,
    originalPath: `D:\\SamplePhotos\\${fileName}`,
    fileName,
    extension: '.jpg',
    category: 'photo',
    discoveryObservationId: id,
    byteSize: 4096,
    filesystemBirthtimeMs: 1700000000000,
    filesystemMtimeMs: 1700000000000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1700000000000,
    lastSeenAtMs: 1700000000000,
    activeHash: 'b'.repeat(64),
    activeHashVerifiedAtMs: 1700000000000,
    rating: null,
    flag: 'none',
    annotationVersion: 0
  }
}

const DEFAULT_META_PROGRESS: PhotoMetadataProgressResponse = {
  jobId: null,
  status: 'idle',
  parserRecipeVersion: 'exif_tech_v2',
  totalPhotos: 2,
  processedPhotos: 2,
  reusedPhotos: 0,
  extractedPhotos: 2,
  absentMetadataPhotos: 0,
  unsupportedPhotos: 0,
  failedPhotos: 0,
  unavailablePhotos: 0,
  pendingPhotos: 0,
  startedAtMs: null,
  updatedAtMs: null,
  completedAtMs: null,
  lastError: null,
  coverage: {
    parserRecipeVersion: 'exif_tech_v2',
    totalPhotos: 2,
    extractedCount: 2,
    noMetadataCount: 0,
    unsupportedCount: 0,
    failedCount: 0,
    unavailableCount: 0,
    staleCount: 0,
    unprocessedCount: 0
  }
}

describe('Renderer Photo Search Timeout Recovery, Retry & Partial-Index Clarity', () => {
  const browsingPhotos = Array.from({ length: 4 }, (_, i) =>
    makePhoto(i + 1, `browse_${i + 1}.jpg`)
  )

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    delete (window as { api?: VaultApi }).api
  })

  it('shows plain-language timeout error with Retry, keeps search term and usable last grid without Loading placeholders, and clears stuck loading', async () => {
    let attempt = 0
    const searchMock = vi.fn(
      async (req: MetadataAwarePhotoSearchRequest): Promise<MetadataAwarePhotoSearchResponse> => {
        attempt += 1
        if (attempt === 1) {
          throw new Error(
            "Error invoking remote method 'photos:search-metadata-aware': SearchTimeoutError: Search request 5 timed out"
          )
        }
        return {
          mode: 'visual_only',
          items: [
            {
              photo: browsingPhotos[0]!,
              score: 0.31,
              rank: 1,
              matchSource: 'semantic'
            }
          ],
          totalMatched: 1,
          filteredCandidateCount: 133,
          eligibleCount: 133,
          unindexedCount: 6850,
          staleCount: 0,
          corruptCount: 0,
          offset: req.offset ?? 0,
          limit: req.limit ?? 100,
          hasMore: false,
          queryLatencyMs: 220,
          interpretedFilters: {
            place: null,
            date: null,
            camera: null,
            visualTerms: 'hawaii'
          },
          clarification: null,
          visualModelRequired: false,
          modelStatus: 'ready'
        }
      }
    )

    window.api = {
      getPhotosPage: vi.fn().mockResolvedValue({
        items: browsingPhotos,
        totalCount: browsingPhotos.length,
        offset: 0,
        limit: 100,
        hasMore: false
      }),
      getThumbnail: vi.fn(async (params: { locationId?: number }) => ({
        status: 'ready',
        locationId: params?.locationId ?? 1,
        dataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        width: 1,
        height: 1,
        mimeType: 'image/gif'
      })),
      cancelThumbnail: vi.fn().mockResolvedValue({ success: true, locationId: 1 }),
      listCollections: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50 }),
      getPhotoMemberships: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50 }),
      getPhotoAnnotation: vi.fn().mockResolvedValue({ annotation: null }),
      getSemanticModelStatus: vi.fn().mockResolvedValue({
        state: 'ready',
        modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
        modelCommit: '6b7c5237',
        modelManifestSha256: 'a'.repeat(64),
        preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
        dimensions: 512,
        requiredBytes: 155851918,
        downloadedBytes: 155851918,
        currentArtifact: null,
        verifiedAtMs: 1000,
        error: null,
        lastReplacementError: null
      }),
      getSemanticIndexProgress: vi.fn().mockResolvedValue({
        jobId: 'job-1',
        status: 'running',
        modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
        modelCommit: '6b7c5237',
        preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
        totalPhotos: 6983,
        processedPhotos: 133,
        reusedPhotos: 0,
        unsupportedPhotos: 0,
        failedPhotos: 0,
        pendingPhotos: 6850,
        totalCatalogPhotos: 7974,
        currentIndexedPhotos: 133,
        startedAtMs: 1000,
        updatedAtMs: 2000,
        completedAtMs: null,
        lastError: null
      }),
      onSemanticModelStatus: vi.fn().mockReturnValue(() => {}),
      onSemanticIndexProgress: vi.fn().mockReturnValue(() => {}),
      getPhotoMetadataProgress: vi.fn().mockResolvedValue(DEFAULT_META_PROGRESS),
      onPhotoMetadataProgress: vi.fn().mockReturnValue(() => {}),
      getPhotoMetadataDetail: vi.fn().mockResolvedValue({ detail: null }),
      getPhotoMetadataFacets: vi.fn().mockResolvedValue({
        field: 'camera',
        items: [],
        unknownCount: 0,
        unprocessedCount: 0,
        offset: 0,
        limit: 25,
        hasMore: false
      }),
      searchPhotosMetadataAware: searchMock,
      listSavedEvents: vi.fn().mockResolvedValue({ items: [] }),
      upsertSavedEvent: vi.fn(),
      deleteSavedEvent: vi.fn().mockResolvedValue(true),
      listSavedPlaces: vi.fn().mockResolvedValue({ items: [] }),
      upsertSavedPlace: vi.fn(),
      deleteSavedPlace: vi.fn().mockResolvedValue(true),
      setPhotoUserPlace: vi.fn(),
      clearPhotoUserPlace: vi.fn().mockResolvedValue(true),
      listCameraLabels: vi.fn().mockResolvedValue({ items: [] }),
      upsertCameraLabel: vi.fn(),
      deleteCameraLabel: vi.fn().mockResolvedValue(true),
      cancelPhotosSemanticSearch: vi.fn().mockResolvedValue({ cancelled: true })
    } as unknown as VaultApi

    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('browse_1.jpg')).toBeInTheDocument()
    })

    const searchInput = screen.getByRole('textbox', {
      name: /search photos by description, place, date, or camera/i
    }) as HTMLInputElement
    fireEvent.change(searchInput, { target: { value: 'hawaii' } })
    fireEvent.submit(searchInput.form!)

    // Plain-language error + Retry + raw IPC error in Diagnostics + search term preserved + no Loading placeholders
    await waitFor(() => {
      expect(screen.getByTestId('photos-load-error')).toBeInTheDocument()
    })
    expect(screen.getByText("Couldn't complete photo search")).toBeInTheDocument()
    expect(
      screen.getByText(/Visual search timed out while your photo library is busy/i)
    ).toBeInTheDocument()
    expect(screen.getByText('Diagnostics')).toBeInTheDocument()
    expect(screen.getByText(/Search request 5 timed out/i)).toBeInTheDocument()
    expect(searchInput.value).toBe('hawaii')
    expect(searchInput.disabled).toBe(false)
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByText('browse_1.jpg')).toBeInTheDocument()
    expect(searchMock).toHaveBeenCalledTimes(1)

    // Clicking Retry re-runs "hawaii" and displays partial indexed results clearly
    fireEvent.click(screen.getByTestId('photos-retry-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('search-partial-results-notice')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('photos-load-error')).toBeNull()
    expect(
      screen.getByText(/Partial results — 6,850 unindexed \(133 searched\)/i)
    ).toBeInTheDocument()
    expect(screen.getByTestId('search-match-badge')).toHaveTextContent('1 semantic match')
  })

  it('paginates restored browsing grid with ordinary getPhotosPage calls when scrolled after timeout, ignores late superseded browsing responses, and retries cleanly on Retry', async () => {
    const allBrowsing = Array.from({ length: 300 }, (_, i) =>
      makePhoto(i + 1, `browse_${i + 1}.jpg`)
    )
    const allHawaii = Array.from({ length: 120 }, (_, i) =>
      makePhoto(1000 + i + 1, `hawaii_${i + 1}.jpg`)
    )

    let releaseDelayedBrowsePage!: () => void
    const delayedBrowseGate = new Promise<void>((resolve) => {
      releaseDelayedBrowsePage = resolve
    })
    let heldFirstScrolledBrowse = false

    const getPhotosPageMock = vi.fn(
      async (req: { offset?: number; limit?: number; ratingFilter?: string }) => {
        const offset = req.offset ?? 0
        const limit = req.limit ?? 50
        if (offset >= 100 && !heldFirstScrolledBrowse) {
          heldFirstScrolledBrowse = true
          await delayedBrowseGate
        }
        return {
          items: allBrowsing.slice(offset, offset + limit),
          totalCount: allBrowsing.length,
          offset,
          limit,
          hasMore: offset + limit < allBrowsing.length
        }
      }
    )

    let hawaiiCalls = 0
    const searchMock = vi.fn(
      async (req: MetadataAwarePhotoSearchRequest): Promise<MetadataAwarePhotoSearchResponse> => {
        if (req.queryText === 'hawaii') {
          hawaiiCalls += 1
          if (hawaiiCalls === 1) {
            throw new Error(
              "Error invoking remote method 'photos:search-metadata-aware': SearchTimeoutError: Search request 5 timed out"
            )
          }
          const offset = req.offset ?? 0
          const limit = req.limit ?? 50
          return {
            mode: 'visual_only',
            items: allHawaii.slice(offset, offset + limit).map((photo, idx) => ({
              photo,
              score: 0.4 - idx * 0.001,
              rank: offset + idx + 1,
              matchSource: 'semantic' as const
            })),
            totalMatched: allHawaii.length,
            filteredCandidateCount: 133,
            eligibleCount: 133,
            unindexedCount: 6850,
            staleCount: 0,
            corruptCount: 0,
            offset,
            limit,
            hasMore: offset + limit < allHawaii.length,
            queryLatencyMs: 180,
            interpretedFilters: {
              place: null,
              date: null,
              camera: null,
              visualTerms: 'hawaii'
            },
            clarification: null,
            visualModelRequired: false,
            modelStatus: 'ready'
          }
        }
        throw new Error(`Unexpected queryText: ${req.queryText}`)
      }
    )

    window.api = {
      getPhotosPage: getPhotosPageMock,
      getThumbnail: vi.fn(async (params: { locationId?: number }) => ({
        status: 'ready',
        locationId: params?.locationId ?? 1,
        dataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        width: 1,
        height: 1,
        mimeType: 'image/gif'
      })),
      cancelThumbnail: vi.fn().mockResolvedValue({ success: true, locationId: 1 }),
      listCollections: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50 }),
      getPhotoMemberships: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50 }),
      getPhotoAnnotation: vi.fn().mockResolvedValue({ annotation: null }),
      getSemanticModelStatus: vi.fn().mockResolvedValue({
        state: 'ready',
        modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
        modelCommit: '6b7c5237',
        modelManifestSha256: 'a'.repeat(64),
        preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
        dimensions: 512,
        requiredBytes: 155851918,
        downloadedBytes: 155851918,
        currentArtifact: null,
        verifiedAtMs: 1000,
        error: null,
        lastReplacementError: null
      }),
      getSemanticIndexProgress: vi.fn().mockResolvedValue({
        jobId: 'job-1',
        status: 'running',
        modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
        modelCommit: '6b7c5237',
        preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
        totalPhotos: 6983,
        processedPhotos: 133,
        reusedPhotos: 0,
        unsupportedPhotos: 0,
        failedPhotos: 0,
        pendingPhotos: 6850,
        totalCatalogPhotos: 7974,
        currentIndexedPhotos: 133,
        startedAtMs: 1000,
        updatedAtMs: 2000,
        completedAtMs: null,
        lastError: null
      }),
      onSemanticModelStatus: vi.fn().mockReturnValue(() => {}),
      onSemanticIndexProgress: vi.fn().mockReturnValue(() => {}),
      getPhotoMetadataProgress: vi.fn().mockResolvedValue(DEFAULT_META_PROGRESS),
      onPhotoMetadataProgress: vi.fn().mockReturnValue(() => {}),
      getPhotoMetadataDetail: vi.fn().mockResolvedValue({ detail: null }),
      getPhotoMetadataFacets: vi.fn().mockResolvedValue({
        field: 'camera',
        items: [],
        unknownCount: 0,
        unprocessedCount: 0,
        offset: 0,
        limit: 25,
        hasMore: false
      }),
      searchPhotosMetadataAware: searchMock,
      listSavedEvents: vi.fn().mockResolvedValue({ items: [] }),
      upsertSavedEvent: vi.fn(),
      deleteSavedEvent: vi.fn().mockResolvedValue(true),
      listSavedPlaces: vi.fn().mockResolvedValue({ items: [] }),
      upsertSavedPlace: vi.fn(),
      deleteSavedPlace: vi.fn().mockResolvedValue(true),
      setPhotoUserPlace: vi.fn(),
      clearPhotoUserPlace: vi.fn().mockResolvedValue(true),
      listCameraLabels: vi.fn().mockResolvedValue({ items: [] }),
      upsertCameraLabel: vi.fn(),
      deleteCameraLabel: vi.fn().mockResolvedValue(true),
      cancelPhotosSemanticSearch: vi.fn().mockResolvedValue({ cancelled: true })
    } as unknown as VaultApi

    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('browse_1.jpg')).toBeInTheDocument()
    })

    // 1. Search "hawaii" and let page 0 time out
    const searchInput = screen.getByRole('textbox', {
      name: /search photos by description, place, date, or camera/i
    }) as HTMLInputElement
    fireEvent.change(searchInput, { target: { value: 'hawaii' } })
    fireEvent.submit(searchInput.form!)

    await waitFor(() => {
      expect(screen.getByTestId('photos-load-error')).toBeInTheDocument()
    })
    expect(searchInput.value).toBe('hawaii')
    expect(screen.getByText('browse_1.jpg')).toBeInTheDocument()
    expect(searchMock).toHaveBeenCalledTimes(1)

    // 2. Scroll restored browsing grid far past cached page 0 -> must use getPhotosPage, ZERO "hawaii" calls
    const grid = screen.getByRole('region', { name: /photographs grid/i })
    fireEvent.scroll(grid, { target: { scrollTop: 12000 } })

    await waitFor(() => {
      const offsets = getPhotosPageMock.mock.calls.map((c) => c[0]?.offset ?? 0)
      expect(offsets.some((o) => o >= 100)).toBe(true)
    })
    expect(searchMock).toHaveBeenCalledTimes(1)
    expect(searchInput.value).toBe('hawaii')
    expect(screen.getByTestId('photos-load-error')).toBeInTheDocument()
    expect(screen.getByTestId('photos-retry-btn')).toBeInTheDocument()

    // 3. Click Retry while a superseded getPhotosPage is still in flight -> fresh page 0 "hawaii" succeeds and late browse response is ignored
    fireEvent.click(screen.getByTestId('photos-retry-btn'))
    releaseDelayedBrowsePage()

    await waitFor(() => {
      expect(screen.getByText('hawaii_1.jpg')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('photos-load-error')).toBeNull()
    expect(screen.queryByText('browse_1.jpg')).toBeNull()
    expect(screen.queryByText('browse_101.jpg')).toBeNull()

    const retryHawaiiCalls = searchMock.mock.calls.slice(1)
    expect(retryHawaiiCalls.length).toBeGreaterThanOrEqual(1)
    expect(retryHawaiiCalls[0]?.[0]?.queryText).toBe('hawaii')
    expect(retryHawaiiCalls[0]?.[0]?.offset).toBe(0)
  })

  it('paginates a restored prior successful search grid using that prior search query rather than the failed query', async () => {
    const allBrowse = Array.from({ length: 10 }, (_, i) => makePhoto(i + 1, `browse_${i + 1}.jpg`))
    const allSunset = Array.from({ length: 200 }, (_, i) =>
      makePhoto(500 + i + 1, `sunset_${i + 1}.jpg`)
    )

    const searchMock = vi.fn(
      async (req: MetadataAwarePhotoSearchRequest): Promise<MetadataAwarePhotoSearchResponse> => {
        if (req.queryText === 'hawaii') {
          throw new Error(
            "Error invoking remote method 'photos:search-metadata-aware': SearchTimeoutError: Search request 5 timed out"
          )
        }
        const offset = req.offset ?? 0
        const limit = req.limit ?? 50
        return {
          mode: 'visual_only',
          items: allSunset.slice(offset, offset + limit).map((photo, idx) => ({
            photo,
            score: 0.5 - idx * 0.001,
            rank: offset + idx + 1,
            matchSource: 'semantic' as const
          })),
          totalMatched: allSunset.length,
          filteredCandidateCount: 200,
          eligibleCount: 200,
          unindexedCount: 0,
          staleCount: 0,
          corruptCount: 0,
          offset,
          limit,
          hasMore: offset + limit < allSunset.length,
          queryLatencyMs: 50,
          interpretedFilters: {
            place: null,
            date: null,
            camera: null,
            visualTerms: req.queryText ?? null
          },
          clarification: null,
          visualModelRequired: false,
          modelStatus: 'ready'
        }
      }
    )

    window.api = {
      getPhotosPage: vi.fn().mockResolvedValue({
        items: allBrowse,
        totalCount: allBrowse.length,
        offset: 0,
        limit: 50,
        hasMore: false
      }),
      getThumbnail: vi.fn(async (params: { locationId?: number }) => ({
        status: 'ready',
        locationId: params?.locationId ?? 1,
        dataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        width: 1,
        height: 1,
        mimeType: 'image/gif'
      })),
      cancelThumbnail: vi.fn().mockResolvedValue({ success: true, locationId: 1 }),
      listCollections: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50 }),
      getPhotoMemberships: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50 }),
      getPhotoAnnotation: vi.fn().mockResolvedValue({ annotation: null }),
      getSemanticModelStatus: vi.fn().mockResolvedValue({
        state: 'ready',
        modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
        modelCommit: '6b7c5237',
        modelManifestSha256: 'a'.repeat(64),
        preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
        dimensions: 512,
        requiredBytes: 155851918,
        downloadedBytes: 155851918,
        currentArtifact: null,
        verifiedAtMs: 1000,
        error: null,
        lastReplacementError: null
      }),
      getSemanticIndexProgress: vi.fn().mockResolvedValue({
        jobId: null,
        status: 'idle',
        modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
        modelCommit: '6b7c5237',
        preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
        totalPhotos: 200,
        processedPhotos: 200,
        reusedPhotos: 0,
        unsupportedPhotos: 0,
        failedPhotos: 0,
        pendingPhotos: 0,
        totalCatalogPhotos: 200,
        currentIndexedPhotos: 200,
        startedAtMs: null,
        updatedAtMs: 0,
        completedAtMs: null,
        lastError: null
      }),
      onSemanticModelStatus: vi.fn().mockReturnValue(() => {}),
      onSemanticIndexProgress: vi.fn().mockReturnValue(() => {}),
      getPhotoMetadataProgress: vi.fn().mockResolvedValue(DEFAULT_META_PROGRESS),
      onPhotoMetadataProgress: vi.fn().mockReturnValue(() => {}),
      getPhotoMetadataDetail: vi.fn().mockResolvedValue({ detail: null }),
      getPhotoMetadataFacets: vi.fn().mockResolvedValue({
        field: 'camera',
        items: [],
        unknownCount: 0,
        unprocessedCount: 0,
        offset: 0,
        limit: 25,
        hasMore: false
      }),
      searchPhotosMetadataAware: searchMock,
      listSavedEvents: vi.fn().mockResolvedValue({ items: [] }),
      upsertSavedEvent: vi.fn(),
      deleteSavedEvent: vi.fn().mockResolvedValue(true),
      listSavedPlaces: vi.fn().mockResolvedValue({ items: [] }),
      upsertSavedPlace: vi.fn(),
      deleteSavedPlace: vi.fn().mockResolvedValue(true),
      setPhotoUserPlace: vi.fn(),
      clearPhotoUserPlace: vi.fn().mockResolvedValue(true),
      listCameraLabels: vi.fn().mockResolvedValue({ items: [] }),
      upsertCameraLabel: vi.fn(),
      deleteCameraLabel: vi.fn().mockResolvedValue(true),
      cancelPhotosSemanticSearch: vi.fn().mockResolvedValue({ cancelled: true })
    } as unknown as VaultApi

    render(<PhotosPanel />)
    await waitFor(() => {
      expect(screen.getByText('browse_1.jpg')).toBeInTheDocument()
    })

    const searchInput = screen.getByRole('textbox', {
      name: /search photos by description, place, date, or camera/i
    }) as HTMLInputElement

    // 1. Run successful "sunset" search
    fireEvent.change(searchInput, { target: { value: 'sunset' } })
    fireEvent.submit(searchInput.form!)
    await waitFor(() => {
      expect(screen.getByText('sunset_1.jpg')).toBeInTheDocument()
    })

    // 2. Search "hawaii" and force timeout -> restores "sunset" grid, keeps "hawaii" in box + Retry visible
    const callsBeforeHawaii = searchMock.mock.calls.length
    fireEvent.change(searchInput, { target: { value: 'hawaii' } })
    fireEvent.submit(searchInput.form!)
    await waitFor(() => {
      expect(screen.getByTestId('photos-load-error')).toBeInTheDocument()
    })
    expect(searchInput.value).toBe('hawaii')
    expect(screen.getByText('sunset_1.jpg')).toBeInTheDocument()
    expect(screen.queryByTestId('photos-top-results')).toBeNull()

    // 3. Scroll restored "sunset" grid beyond cached page 0 -> must query "sunset", NEVER "hawaii" again
    const callsBeforeScroll = searchMock.mock.calls.length
    expect(callsBeforeScroll).toBe(callsBeforeHawaii + 1)
    const grid = screen.getByRole('region', { name: /photographs grid/i })
    fireEvent.scroll(grid, { target: { scrollTop: 9000 } })

    await waitFor(() => {
      expect(searchMock.mock.calls.length).toBeGreaterThan(callsBeforeScroll)
    })
    const callsAfterScroll = searchMock.mock.calls.slice(callsBeforeScroll)
    expect(callsAfterScroll.every((c) => c[0]?.queryText === 'sunset')).toBe(true)
    expect(callsAfterScroll.some((c) => c[0]?.queryText === 'hawaii')).toBe(false)
  })
})
