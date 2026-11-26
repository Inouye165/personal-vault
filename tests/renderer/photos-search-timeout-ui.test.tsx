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
})
