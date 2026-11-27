import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import type { VaultApi } from '../../src/preload/index.d'
import type {
  GetPhotoMetadataDetailResponse,
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

describe('Renderer Metadata-Aware Search, Clarifications & Provenance Separation UI', () => {
  const restaurantPhoto = makePhoto(1, 'yellowstone-restaurant.jpg')
  const mountainPhoto = makePhoto(2, 'yellowstone-mountain.heic')

  let searchMock: ReturnType<typeof vi.fn>
  let upsertSavedEventMock: ReturnType<typeof vi.fn>
  let setPhotoUserPlaceMock: ReturnType<typeof vi.fn>
  let detailData: GetPhotoMetadataDetailResponse

  beforeEach(() => {
    vi.restoreAllMocks()

    detailData = {
      detail: {
        fileLocationId: 1,
        currentRevision: 'rev:1',
        effectiveStatus: 'extracted',
        parserRecipeVersion: 'exif_tech_v2',
        recordedExtension: '.jpg',
        historicalMetadataCount: 0,
        currentMetadata: {
          id: 1,
          fileLocationId: 1,
          discoveryObservationId: 1,
          contentSha256: 'b'.repeat(64),
          contentRevision: 'rev:1',
          observedByteSize: 4096,
          observedMtimeMs: 1700000000000,
          parserRecipeVersion: 'exif_tech_v2',
          extractionStatus: 'extracted',
          detectedFormat: 'jpeg',
          recordedExtension: '.jpg',
          extensionFormatMismatch: false,
          encodedWidthPx: 4000,
          encodedHeightPx: 3000,
          exifOrientation: 1,
          displayWidthPx: 4000,
          displayHeightPx: 3000,
          captureDateSourceTag: 'DateTimeOriginal',
          rawCaptureDateText: '2025:06:06 19:45:00',
          captureSubseconds: null,
          captureOffsetMinutes: -360,
          captureOffsetText: '-06:00',
          captureTimezoneStatus: 'offset_present',
          captureCalendarDate: '2025-06-06',
          captureYear: 2025,
          captureMonth: 6,
          captureDay: 6,
          captureLocalIso: '2025-06-06T19:45:00',
          captureUtcEpochMs: Date.UTC(2025, 5, 7, 1, 45, 0),
          captureDateParseError: null,
          captureDateConflict: null,
          gpsStatus: 'present',
          gpsLatitude: 44.725,
          gpsLongitude: -110.491,
          gpsAltitudeM: 2380,
          gpsParseError: null,
          cameraMakeRaw: 'Canon',
          cameraModelRaw: 'Canon EOS R5',
          cameraDisplay: 'Canon EOS R5',
          cameraNormalized: 'canon eos r5',
          lensMakeRaw: null,
          lensModelRaw: null,
          lensDisplay: null,
          lensNormalized: null,
          unknownTagCount: 2,
          parserLimitsNote: '2 unknown/proprietary tags preserved in original file bytes.',
          rawMetadataJson: JSON.stringify({
            readableTags: { Software: 'Camera Firmware 1.8', ISOSpeedRatings: 800 }
          }),
          errorCode: null,
          errorMessage: null,
          createdAtMs: 1700000000000,
          isCurrent: true
        },
        userPlace: null,
        cameraLabel: null
      }
    }

    searchMock = vi.fn(
      async (req: MetadataAwarePhotoSearchRequest): Promise<MetadataAwarePhotoSearchResponse> => {
        if (req.queryText === 'Yellowstone in 2025') {
          return {
            mode: 'metadata_only',
            items: [
              { photo: restaurantPhoto, score: null, rank: 1, matchSource: 'metadata' },
              { photo: mountainPhoto, score: null, rank: 2, matchSource: 'metadata' }
            ],
            totalMatched: 2,
            filteredCandidateCount: 2,
            eligibleCount: 2,
            unindexedCount: 0,
            staleCount: 0,
            corruptCount: 0,
            offset: 0,
            limit: 50,
            hasMore: false,
            queryLatencyMs: 5,
            interpretedFilters: {
              place: {
                label: 'Yellowstone National Park',
                normalizedLabel: 'yellowstone national park',
                source: 'offline_gazetteer',
                savedPlaceId: null,
                gpsBounds: { minLat: 44.131, maxLat: 45.111, minLon: -111.156, maxLon: -109.825 }
              },
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
            modelStatus: 'unprovisioned'
          }
        }

        if (req.queryText === 'My wedding week' && !upsertSavedEventMock.mock.calls.length) {
          return {
            mode: 'needs_clarification',
            items: [],
            totalMatched: 0,
            filteredCandidateCount: 0,
            eligibleCount: 0,
            unindexedCount: 0,
            staleCount: 0,
            corruptCount: 0,
            offset: 0,
            limit: 50,
            hasMore: false,
            queryLatencyMs: 3,
            interpretedFilters: { place: null, date: null, camera: null, visualTerms: null },
            clarification: {
              kind: 'define_event',
              term: 'My wedding week',
              message: 'No saved date range exists yet for "My wedding week".',
              options: []
            },
            visualModelRequired: false,
            modelStatus: 'unprovisioned'
          }
        }

        if (req.queryText === 'Springfield' && !req.filterOverrides?.place) {
          return {
            mode: 'needs_clarification',
            items: [],
            totalMatched: 0,
            filteredCandidateCount: 0,
            eligibleCount: 0,
            unindexedCount: 0,
            staleCount: 0,
            corruptCount: 0,
            offset: 0,
            limit: 50,
            hasMore: false,
            queryLatencyMs: 3,
            interpretedFilters: { place: null, date: null, camera: null, visualTerms: null },
            clarification: {
              kind: 'disambiguate_place',
              term: 'Springfield',
              message: 'Multiple offline places match "Springfield".',
              options: [
                {
                  placeId: 'springfield-il',
                  label: 'Springfield, Illinois',
                  regionHint: 'Illinois, USA',
                  gpsBounds: { minLat: 39.71, maxLat: 39.88, minLon: -89.76, maxLon: -89.56 },
                  savedPlaceId: null
                }
              ]
            },
            visualModelRequired: false,
            modelStatus: 'unprovisioned'
          }
        }

        if (req.queryText === 'Mountains in Yellowstone' && !req.bypassVisualModel) {
          return {
            mode: 'hybrid',
            items: [],
            totalMatched: 0,
            filteredCandidateCount: 2,
            eligibleCount: 0,
            unindexedCount: 2,
            staleCount: 0,
            corruptCount: 0,
            offset: 0,
            limit: 50,
            hasMore: false,
            queryLatencyMs: 4,
            interpretedFilters: {
              place: {
                label: 'Yellowstone National Park',
                normalizedLabel: 'yellowstone national park',
                source: 'offline_gazetteer',
                savedPlaceId: null,
                gpsBounds: { minLat: 44.131, maxLat: 45.111, minLon: -111.156, maxLon: -109.825 }
              },
              date: null,
              camera: null,
              visualTerms: 'Mountains'
            },
            clarification: null,
            visualModelRequired: true,
            modelStatus: 'unprovisioned'
          }
        }

        return {
          mode: 'metadata_only',
          items: [{ photo: restaurantPhoto, score: null, rank: 1, matchSource: 'metadata' }],
          totalMatched: 1,
          filteredCandidateCount: 1,
          eligibleCount: 1,
          unindexedCount: 0,
          staleCount: 0,
          corruptCount: 0,
          offset: 0,
          limit: 50,
          hasMore: false,
          queryLatencyMs: 4,
          interpretedFilters: req.filterOverrides
            ? {
                place: req.filterOverrides.place ?? null,
                date: req.filterOverrides.date ?? null,
                camera: req.filterOverrides.camera ?? null,
                visualTerms: req.filterOverrides.visualTerms ?? null
              }
            : {
                place: null,
                date: {
                  mode: 'saved_event',
                  label: 'My wedding week (2024-09-10 to 2024-09-16)',
                  captureDateFrom: '2024-09-10',
                  captureDateTo: '2024-09-16'
                },
                camera: null,
                visualTerms: null
              },
          clarification: null,
          visualModelRequired: false,
          modelStatus: 'unprovisioned'
        }
      }
    )

    upsertSavedEventMock = vi.fn(async (input) => ({
      id: 1,
      name: input.name,
      normalizedName: input.name.toLowerCase(),
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      notes: null,
      createdAtMs: 1000,
      updatedAtMs: 1000
    }))

    setPhotoUserPlaceMock = vi.fn(async (input) => {
      detailData = {
        detail: {
          ...detailData.detail!,
          userPlace: {
            id: 7,
            fileLocationId: input.fileLocationId,
            placeId: null,
            placeLabel: input.placeLabel,
            normalizedLabel: input.placeLabel.toLowerCase(),
            createdAtMs: 2000,
            updatedAtMs: 2000
          }
        }
      }
      return detailData.detail!.userPlace!
    })

    window.api = {
      getPhotosPage: vi.fn().mockResolvedValue({
        items: [restaurantPhoto, mountainPhoto],
        totalCount: 2,
        offset: 0,
        limit: 50,
        hasMore: false
      }),
      getThumbnail: vi.fn().mockResolvedValue({ status: 'missing', locationId: 1, reason: 'none' }),
      cancelThumbnail: vi.fn().mockResolvedValue({ success: true, locationId: 1 }),
      listCollections: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50 }),
      getPhotoMemberships: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        offset: 0,
        limit: 50
      }),
      getPhotoAnnotation: vi.fn().mockResolvedValue({ annotation: null }),
      getSemanticModelStatus: vi.fn().mockResolvedValue({
        state: 'missing',
        modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
        modelCommit: '6b7c5237',
        modelManifestSha256: 'a'.repeat(64),
        preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
        dimensions: 512,
        requiredBytes: 155851918,
        downloadedBytes: 0,
        currentArtifact: null,
        verifiedAtMs: null,
        error: null,
        lastReplacementError: null
      }),
      getSemanticIndexProgress: vi.fn().mockResolvedValue({
        jobId: null,
        status: 'idle',
        modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
        modelCommit: '6b7c5237',
        preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
        totalPhotos: 2,
        processedPhotos: 0,
        reusedPhotos: 0,
        unsupportedPhotos: 0,
        failedPhotos: 0,
        pendingPhotos: 2,
        totalCatalogPhotos: 2,
        currentIndexedPhotos: 0,
        startedAtMs: null,
        updatedAtMs: 0,
        completedAtMs: null,
        lastError: null
      }),
      onSemanticModelStatus: vi.fn().mockReturnValue(() => {}),
      onSemanticIndexProgress: vi.fn().mockReturnValue(() => {}),
      getPhotoMetadataProgress: vi.fn().mockResolvedValue(DEFAULT_META_PROGRESS),
      onPhotoMetadataProgress: vi.fn().mockReturnValue(() => {}),
      getPhotoMetadataDetail: vi.fn(async () => detailData),
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
      upsertSavedEvent: upsertSavedEventMock,
      deleteSavedEvent: vi.fn().mockResolvedValue(true),
      listSavedPlaces: vi.fn().mockResolvedValue({ items: [] }),
      upsertSavedPlace: vi.fn(),
      deleteSavedPlace: vi.fn().mockResolvedValue(true),
      setPhotoUserPlace: setPhotoUserPlaceMock,
      clearPhotoUserPlace: vi.fn().mockResolvedValue(true),
      listCameraLabels: vi.fn().mockResolvedValue({ items: [] }),
      upsertCameraLabel: vi.fn(),
      deleteCameraLabel: vi.fn().mockResolvedValue(true),
      cancelPhotosSemanticSearch: vi.fn().mockResolvedValue({ cancelled: true })
    } as unknown as VaultApi
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs "Yellowstone in 2025" without the visual model and shows editable place/date chips', async () => {
    render(<PhotosPanel />)
    const input = await screen.findByPlaceholderText(/search photos by description, place, date/i)
    fireEvent.change(input, { target: { value: 'Yellowstone in 2025' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(screen.getByTestId('interpreted-filters-bar')).toBeInTheDocument()
      expect(screen.getByTestId('filter-chip-place')).toHaveTextContent('Yellowstone National Park')
      expect(screen.getByTestId('filter-chip-date')).toHaveTextContent('2025')
      expect(screen.getByTestId('search-match-badge')).toHaveTextContent('2 metadata matches')
    })

    // Edit date chip inline
    fireEvent.click(screen.getByTitle('Edit date filter'))
    fireEvent.change(screen.getByLabelText('Edit interpreted date from'), {
      target: { value: '2025-06-01' }
    })
    fireEvent.change(screen.getByLabelText('Edit interpreted date to'), {
      target: { value: '2025-06-30' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => {
      expect(searchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filterOverrides: expect.objectContaining({
            date: expect.objectContaining({
              captureDateFrom: '2025-06-01',
              captureDateTo: '2025-06-30'
            })
          })
        })
      )
    })
  })

  it('handles offline event definition, place disambiguation, visual-model-required fallback, and separated Photo Details sections', async () => {
    render(<PhotosPanel />)
    const input = await screen.findByPlaceholderText(/search photos by description, place, date/i)

    // 1. "My wedding week" -> prompt -> save -> re-search
    fireEvent.change(input, { target: { value: 'My wedding week' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(screen.getByTestId('search-clarification-card')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Event start date'), { target: { value: '2024-09-10' } })
    fireEvent.change(screen.getByLabelText('Event end date'), { target: { value: '2024-09-16' } })
    fireEvent.click(screen.getByTestId('save-clarified-event-btn'))
    await waitFor(() => expect(upsertSavedEventMock).toHaveBeenCalledTimes(1))

    // 2. "Springfield" -> offline disambiguation
    fireEvent.change(input, { target: { value: 'Springfield' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() =>
      expect(screen.getByTestId('disambiguate-place-springfield-il')).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId('disambiguate-place-springfield-il'))
    await waitFor(() =>
      expect(searchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filterOverrides: expect.objectContaining({
            place: expect.objectContaining({ label: 'Springfield, Illinois' })
          })
        })
      )
    )

    // 3. "Mountains in Yellowstone" when visual model is missing -> offers bypass
    fireEvent.change(input, { target: { value: 'Mountains in Yellowstone' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() =>
      expect(screen.getByTestId('visual-model-required-notice')).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId('bypass-visual-model-btn'))
    await waitFor(() =>
      expect(searchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ bypassVisualModel: true })
      )
    )

    // 4. Photo Details keeps File Facts, Embedded Technical Metadata (GPS + readable tags + parser limits), and User-Assigned Metadata separate
    await waitFor(() => expect(screen.getByText('yellowstone-restaurant.jpg')).toBeInTheDocument())
    fireEvent.click(screen.getByText('yellowstone-restaurant.jpg'))

    await waitFor(() => {
      expect(screen.getByTestId('photo-technical-metadata-section')).toHaveTextContent(
        '44.72500, -110.49100'
      )
      expect(screen.getByTestId('photo-technical-metadata-section')).toHaveTextContent(
        'Yellowstone National Park'
      )
      expect(screen.getByTestId('metadata-readable-tags')).toHaveTextContent('Camera Firmware 1.8')
      expect(screen.getByTestId('photo-user-metadata-section')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText('User-assigned place'), {
      target: { value: 'Yellowstone' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Place' }))
    await waitFor(() =>
      expect(setPhotoUserPlaceMock).toHaveBeenCalledWith({
        fileLocationId: 1,
        placeId: null,
        placeLabel: 'Yellowstone National Park'
      })
    )
  })

  it('preserves active download progress during metadata search and hides misleading semantic-empty banners on clarifications', async () => {
    vi.mocked(window.api.getSemanticModelStatus).mockResolvedValue({
      state: 'installing',
      modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
      modelCommit: '6b7c5237',
      modelManifestSha256: 'a'.repeat(64),
      preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
      dimensions: 512,
      requiredBytes: 155851918,
      downloadedBytes: 50000000,
      currentArtifact: 'onnx/model.onnx',
      verifiedAtMs: null,
      error: null,
      lastReplacementError: null
    })

    render(<PhotosPanel />)
    await waitFor(() =>
      expect(screen.getByTestId('photo-search-download-progress')).toBeInTheDocument()
    )

    const input = await screen.findByPlaceholderText(/search photos by description, place, date/i)
    fireEvent.change(input, { target: { value: 'Yellowstone in 2025' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() =>
      expect(screen.getByTestId('search-match-badge')).toHaveTextContent('2 metadata matches')
    )
    expect(screen.getByTestId('photo-search-download-progress')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'My wedding week' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(screen.getByTestId('search-clarification-card')).toBeInTheDocument())
    expect(screen.queryByText(/no semantic matches found/i)).not.toBeInTheDocument()
  })
})
