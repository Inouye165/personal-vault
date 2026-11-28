import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import type { VaultApi } from '../../src/preload/index.d'
import type {
  GetPhotoMetadataDetailResponse,
  GetPhotoMetadataFacetsRequest,
  GetPhotoMetadataFacetsResponse,
  GetPhotosPageRequest,
  GetPhotosPageResponse,
  PhotoItem,
  PhotoMetadataProgressResponse
} from '../../src/shared/validation/ipc-schemas'

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function makePhoto(overrides: Partial<PhotoItem> & { id: number; fileName: string }): PhotoItem {
  const { id, fileName, ...rest } = overrides
  return {
    id,
    sourceId: 1,
    originalPath: `D:\\Photos\\${fileName}`,
    fileName,
    extension: fileName.slice(fileName.lastIndexOf('.')).toLowerCase(),
    category: 'photo',
    discoveryObservationId: id * 10,
    byteSize: 512_000,
    filesystemBirthtimeMs: 1700000000000,
    filesystemMtimeMs: 1700000005000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1700000010000,
    lastSeenAtMs: 1700000010000,
    activeHash: String(id).padStart(64, 'a'),
    activeHashVerifiedAtMs: 1700000020000,
    rating: null,
    flag: 'none',
    annotationVersion: 0,
    ...rest
  }
}

function makeIdleProgress(
  overrides?: Partial<PhotoMetadataProgressResponse>
): PhotoMetadataProgressResponse {
  return {
    jobId: null,
    status: 'idle',
    parserRecipeVersion: 'exif_tech_v1',
    totalPhotos: 0,
    processedPhotos: 0,
    extractedPhotos: 0,
    absentMetadataPhotos: 0,
    reusedPhotos: 0,
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
      totalPhotos: 3,
      extractedCount: 1,
      noMetadataCount: 1,
      unsupportedCount: 0,
      failedCount: 0,
      unavailableCount: 0,
      staleCount: 0,
      unprocessedCount: 1
    },
    ...overrides
  }
}

describe('Stage 6C — PhotosPanel Metadata Provenance, Extraction Controls & SQL Filters UI', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('displays honest incomplete coverage, drives extraction start/pause/resume/cancel, and renders selected-photo provenance separating file facts, embedded tags, orientation dimensions, and capture date unknowns', async () => {
    const canonPhoto = makePhoto({ id: 1, fileName: 'IMG_2024.jpg', rating: 5, flag: 'pick' })
    const unprocessedPhoto = makePhoto({ id: 2, fileName: 'RAW_PENDING.jpg' })

    let progressListener: ((p: PhotoMetadataProgressResponse) => void) | null = null

    const mockGetPhotosPage = vi.fn().mockResolvedValue({
      items: [canonPhoto, unprocessedPhoto],
      totalCount: 2,
      offset: 0,
      limit: 50,
      hasMore: false
    } satisfies GetPhotosPageResponse)

    const mockGetMetadataProgress = vi.fn().mockResolvedValue(
      makeIdleProgress({
        coverage: {
          parserRecipeVersion: 'exif_tech_v1',
          totalPhotos: 2,
          extractedCount: 1,
          noMetadataCount: 0,
          unsupportedCount: 0,
          failedCount: 0,
          unavailableCount: 0,
          staleCount: 0,
          unprocessedCount: 1
        }
      })
    )

    const mockStartExtraction = vi.fn().mockImplementation(async () => {
      const running = makeIdleProgress({
        jobId: 'job-meta-1',
        status: 'running',
        totalPhotos: 1,
        pendingPhotos: 1,
        coverage: {
          parserRecipeVersion: 'exif_tech_v2',
          totalPhotos: 2,
          extractedCount: 1,
          noMetadataCount: 0,
          unsupportedCount: 0,
          failedCount: 0,
          unavailableCount: 0,
          staleCount: 0,
          unprocessedCount: 1
        }
      })
      progressListener?.(running)
      return running
    })

    const mockCancelExtraction = vi.fn().mockResolvedValue(
      makeIdleProgress({
        jobId: 'job-meta-1',
        status: 'cancelled',
        totalPhotos: 1,
        pendingPhotos: 1
      })
    )

    const mockGetMetadataDetail = vi
      .fn()
      .mockImplementation(async ({ fileLocationId }: { fileLocationId: number }) => {
        if (fileLocationId === 1) {
          return {
            detail: {
              fileLocationId: 1,
              currentRevision: 'rev:10:512000:1700000005000:aaaa',
              effectiveStatus: 'extracted',
              parserRecipeVersion: 'exif_tech_v1',
              recordedExtension: '.jpg',
              historicalMetadataCount: 0,
              currentMetadata: {
                id: 500,
                fileLocationId: 1,
                discoveryObservationId: 10,
                parserRecipeVersion: 'exif_tech_v1',
                extractionStatus: 'extracted',
                contentSha256: 'a'.repeat(64),
                contentRevision: 'metarev:10:512000:1700000005000:aaaa',
                observedByteSize: 512000,
                observedMtimeMs: 1700000005000,
                recordedExtension: '.jpg',
                detectedFormat: 'png',
                extensionFormatMismatch: true,
                encodedWidthPx: 4000,
                encodedHeightPx: 3000,
                exifOrientation: 6,
                displayWidthPx: 3000,
                displayHeightPx: 4000,
                captureDateSourceTag: 'DateTimeDigitized',
                rawCaptureDateText: '2024:02:29 08:15:30',
                captureSubseconds: '250',
                captureOffsetMinutes: null,
                captureOffsetText: null,
                captureTimezoneStatus: 'local_wall_clock_unknown_tz',
                captureCalendarDate: '2024-02-29',
                captureYear: 2024,
                captureMonth: 2,
                captureDay: 29,
                captureLocalIso: '2024-02-29T08:15:30.250',
                captureUtcEpochMs: null,
                captureDateParseError: null,
                captureDateConflict:
                  'DateTimeOriginal ("2024:02:30 08:15:30") was invalid; fell back to DateTimeDigitized',
                gpsStatus: 'absent',
                gpsLatitude: null,
                gpsLongitude: null,
                gpsAltitudeM: null,
                gpsParseError: null,
                cameraMakeRaw: 'Canon',
                cameraModelRaw: 'Canon EOS R5',
                cameraDisplay: 'Canon EOS R5',
                cameraNormalized: 'canon eos r5',
                lensMakeRaw: 'Canon',
                lensModelRaw: 'RF24-70mm F2.8 L IS USM',
                lensDisplay: 'Canon RF24-70mm F2.8 L IS USM',
                lensNormalized: 'canon rf24-70mm f2.8 l is usm',
                unknownTagCount: 0,
                parserLimitsNote: null,
                rawMetadataJson: '{"Make":"Canon","Model":"Canon EOS R5"}',
                errorCode: null,
                errorMessage: null,
                createdAtMs: 1700000030000,
                isCurrent: true
              }
            }
          } satisfies GetPhotoMetadataDetailResponse
        }
        return {
          detail: {
            fileLocationId: 2,
            currentRevision: 'rev:20:512000:1700000005000:bbbb',
            effectiveStatus: 'unprocessed',
            parserRecipeVersion: 'exif_tech_v1',
            recordedExtension: '.jpg',
            historicalMetadataCount: 0,
            currentMetadata: null
          }
        } satisfies GetPhotoMetadataDetailResponse
      })

    const mockGetMetadataFacets = vi.fn().mockResolvedValue({
      field: 'camera',
      items: [{ normalizedValue: 'canon eos r5', displayLabel: 'Canon EOS R5', count: 1 }],
      unknownCount: 0,
      unprocessedCount: 1,
      offset: 0,
      limit: 15,
      hasMore: false
    } satisfies GetPhotoMetadataFacetsResponse)

    window.api = {
      ...window.api,
      getPhotosPage: mockGetPhotosPage,
      getThumbnail: vi.fn().mockResolvedValue({
        status: 'missing',
        locationId: 1,
        reason: 'test'
      }),
      cancelThumbnail: vi.fn(),
      listCollections: vi.fn().mockResolvedValue({
        items: [],
        totalCount: 0,
        offset: 0,
        limit: 50,
        hasMore: false
      }),
      getPhotoMemberships: vi.fn().mockResolvedValue({
        items: [],
        totalCount: 0,
        hasMore: false
      }),
      getPhotoMetadataProgress: mockGetMetadataProgress,
      startPhotoMetadataExtraction: mockStartExtraction,
      pausePhotoMetadataExtraction: vi.fn(),
      resumePhotoMetadataExtraction: vi.fn(),
      cancelPhotoMetadataExtraction: mockCancelExtraction,
      onPhotoMetadataProgress: vi.fn().mockImplementation((cb) => {
        progressListener = cb
        return () => {
          progressListener = null
        }
      }),
      getPhotoMetadataDetail: mockGetMetadataDetail,
      getPhotoMetadataFacets: mockGetMetadataFacets
    } as unknown as VaultApi

    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('IMG_2024.jpg')).toBeInTheDocument()
    })

    // Open Metadata & Filters compact expandable panel
    const toggleBtn = screen.getByTestId('photos-toggle-metadata-filters')
    fireEvent.click(toggleBtn)

    const panel = await screen.findByTestId('photo-metadata-filter-panel')
    expect(within(panel).getByTestId('metadata-incomplete-coverage-banner')).toHaveTextContent(
      /1 photo.*not extracted yet/i
    )

    // Start extraction and cancel it
    fireEvent.click(within(panel).getByTestId('metadata-start-btn'))
    await waitFor(() => {
      expect(mockStartExtraction).toHaveBeenCalledTimes(1)
    })
    const cancelBtn = await within(panel).findByTestId('metadata-cancel-btn')
    fireEvent.click(cancelBtn)
    await waitFor(() => {
      expect(mockCancelExtraction).toHaveBeenCalledTimes(1)
    })

    // Select photo 1 (extracted with fallback DateTimeDigitized, orientation 6, extension mismatch)
    fireEvent.click(screen.getByRole('button', { name: /Details for IMG_2024\.jpg/i }))

    const techSection = await screen.findByTestId('photo-technical-metadata-section')
    expect(techSection).toHaveTextContent(/Canon EOS R5/i)
    expect(techSection).toHaveTextContent(/Canon RF24-70mm F2\.8 L IS USM/i)
    expect(techSection).toHaveTextContent(/3,000 × 4,000 px/i)
    expect(techSection).toHaveTextContent(/4,000 × 3,000 px/i)
    expect(techSection).toHaveTextContent(/Orientation 6/i)
    expect(techSection).toHaveTextContent(/Extension \/ container mismatch/i)

    // Capture date provenance in Inferred Metadata section
    const captureDt = screen.getByText('Capture Date')
    expect(captureDt.parentElement).toHaveTextContent(/2024-02-29T08:15:30\.250/)
    expect(captureDt.parentElement).toHaveTextContent(/timezone unknown/i)
    expect(captureDt.parentElement).toHaveTextContent(/DateTimeDigitized/i)

    // Select photo 2 (unprocessed) -> must explicitly state Unknown (not extracted yet)
    fireEvent.click(screen.getByRole('button', { name: /Details for RAW_PENDING\.jpg/i }))
    await waitFor(() => {
      expect(screen.getByText('Capture Date').parentElement).toHaveTextContent(
        /Unknown \(not extracted yet\)/i
      )
    })
  })

  it('combines all Stage 6C SQL filters with rating/flag/collection, resets pagination, drops stale delayed page/detail/facet responses, and resets cleanly', async () => {
    const p1 = makePhoto({ id: 10, fileName: 'match.jpg', rating: 4, flag: 'pick' })
    const p2 = makePhoto({ id: 11, fileName: 'other.png', rating: 2, flag: 'none' })

    const stalePageDeferred = createDeferred<GetPhotosPageResponse>()
    let pageCallCount = 0

    const mockGetPhotosPage = vi
      .fn()
      .mockImplementation((req: GetPhotosPageRequest): Promise<GetPhotosPageResponse> => {
        pageCallCount++
        // Simulate a slow response for cameraNormalized === 'slow-camera' that arrives AFTER a newer filter change
        if (req.cameraNormalized === 'slow-camera') {
          return stalePageDeferred.promise
        }
        if (
          req.ratingFilter === '4' &&
          req.flagFilter === 'pick' &&
          req.cameraNormalized === 'nikon z 8' &&
          req.lensNormalized === 'nikkor z 24-70mm f/2.8 s' &&
          req.captureDateFrom === '2025-01-01' &&
          req.captureDateTo === '2025-12-31' &&
          req.includeUnknownCaptureDate === true &&
          req.minWidthPx === 1920 &&
          req.minHeightPx === 1080 &&
          req.includeUnknownDimensions === true &&
          req.fileTypeBasis === 'filename_extension' &&
          req.fileTypeValue === '.jpg'
        ) {
          return Promise.resolve({
            items: [p1],
            totalCount: 1,
            offset: 0,
            limit: 50,
            hasMore: false
          })
        }
        return Promise.resolve({
          items: [p1, p2],
          totalCount: 2,
          offset: req.offset,
          limit: req.limit,
          hasMore: false
        })
      })

    const staleDetailDeferred = createDeferred<GetPhotoMetadataDetailResponse>()
    const mockGetMetadataDetail = vi
      .fn()
      .mockImplementation(({ fileLocationId }: { fileLocationId: number }) => {
        if (fileLocationId === 10) {
          return staleDetailDeferred.promise
        }
        return Promise.resolve({
          detail: {
            fileLocationId: 11,
            currentRevision: 'rev:110',
            effectiveStatus: 'no_metadata',
            parserRecipeVersion: 'exif_tech_v1',
            recordedExtension: '.png',
            historicalMetadataCount: 0,
            currentMetadata: null
          }
        } satisfies GetPhotoMetadataDetailResponse)
      })

    const mockGetMetadataFacets = vi
      .fn()
      .mockImplementation(async (req: GetPhotoMetadataFacetsRequest) => {
        if (req.field === 'camera') {
          return {
            field: 'camera',
            items: [
              { normalizedValue: 'slow-camera', displayLabel: 'Slow Camera', count: 1 },
              { normalizedValue: 'nikon z 8', displayLabel: 'NIKON Z 8', count: 1 }
            ],
            unknownCount: 1,
            unprocessedCount: 0,
            offset: req.offset ?? 0,
            limit: req.limit ?? 15,
            hasMore: false
          } satisfies GetPhotoMetadataFacetsResponse
        }
        if (req.field === 'lens') {
          return {
            field: 'lens',
            items: [
              {
                normalizedValue: 'nikkor z 24-70mm f/2.8 s',
                displayLabel: 'NIKKOR Z 24-70mm f/2.8 S',
                count: 1
              }
            ],
            unknownCount: 1,
            unprocessedCount: 0,
            offset: req.offset ?? 0,
            limit: req.limit ?? 15,
            hasMore: false
          } satisfies GetPhotoMetadataFacetsResponse
        }
        return {
          field: req.field,
          items: [{ normalizedValue: '.jpg', displayLabel: '.jpg', count: 1 }],
          unknownCount: 0,
          unprocessedCount: 0,
          offset: req.offset ?? 0,
          limit: req.limit ?? 15,
          hasMore: false
        } satisfies GetPhotoMetadataFacetsResponse
      })

    window.api = {
      ...window.api,
      getPhotosPage: mockGetPhotosPage,
      getThumbnail: vi.fn().mockResolvedValue({
        status: 'missing',
        locationId: 10,
        reason: 'test'
      }),
      cancelThumbnail: vi.fn(),
      listCollections: vi.fn().mockResolvedValue({
        items: [],
        totalCount: 0,
        offset: 0,
        limit: 50,
        hasMore: false
      }),
      getPhotoMemberships: vi.fn().mockResolvedValue({
        items: [],
        totalCount: 0,
        hasMore: false
      }),
      getPhotoMetadataProgress: vi.fn().mockResolvedValue(
        makeIdleProgress({
          coverage: {
            parserRecipeVersion: 'exif_tech_v1',
            totalPhotos: 2,
            extractedCount: 1,
            noMetadataCount: 1,
            unsupportedCount: 0,
            failedCount: 0,
            unavailableCount: 0,
            staleCount: 0,
            unprocessedCount: 0
          }
        })
      ),
      startPhotoMetadataExtraction: vi.fn(),
      pausePhotoMetadataExtraction: vi.fn(),
      resumePhotoMetadataExtraction: vi.fn(),
      cancelPhotoMetadataExtraction: vi.fn(),
      onPhotoMetadataProgress: vi.fn().mockReturnValue(() => {}),
      getPhotoMetadataDetail: mockGetMetadataDetail,
      getPhotoMetadataFacets: mockGetMetadataFacets
    } as unknown as VaultApi

    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('match.jpg')).toBeInTheDocument()
      expect(screen.getByText('other.png')).toBeInTheDocument()
    })
    expect(pageCallCount).toBeGreaterThanOrEqual(1)

    // Test selected-photo detail race guard: click match.jpg (slow detail) then immediately click other.png (fast detail)
    fireEvent.click(screen.getByRole('button', { name: /Details for match\.jpg/i }))
    fireEvent.click(screen.getByRole('button', { name: /Details for other\.png/i }))

    await waitFor(() => {
      expect(screen.getByTestId('photo-technical-metadata-section')).toHaveTextContent(
        /no embedded EXIF/i
      )
    })

    // Now resolve the delayed detail for photo 10 -> MUST be ignored while photo 11 is selected!
    staleDetailDeferred.resolve({
      detail: {
        fileLocationId: 10,
        currentRevision: 'rev:100',
        effectiveStatus: 'extracted',
        parserRecipeVersion: 'exif_tech_v1',
        recordedExtension: '.jpg',
        historicalMetadataCount: 0,
        currentMetadata: {
          id: 99,
          fileLocationId: 10,
          discoveryObservationId: 100,
          parserRecipeVersion: 'exif_tech_v1',
          extractionStatus: 'extracted',
          contentSha256: 'b'.repeat(64),
          contentRevision: 'metarev:100',
          observedByteSize: 512000,
          observedMtimeMs: 1700000005000,
          recordedExtension: '.jpg',
          detectedFormat: 'jpeg',
          extensionFormatMismatch: false,
          encodedWidthPx: 1920,
          encodedHeightPx: 1080,
          exifOrientation: 1,
          displayWidthPx: 1920,
          displayHeightPx: 1080,
          captureDateSourceTag: 'DateTimeOriginal',
          rawCaptureDateText: '2025:06:01 12:00:00',
          captureSubseconds: null,
          captureOffsetMinutes: 0,
          captureOffsetText: '+00:00',
          captureTimezoneStatus: 'offset_present',
          captureCalendarDate: '2025-06-01',
          captureYear: 2025,
          captureMonth: 6,
          captureDay: 1,
          captureLocalIso: '2025-06-01T12:00:00',
          captureUtcEpochMs: 1748779200000,
          captureDateParseError: null,
          captureDateConflict: null,
          gpsStatus: 'absent',
          gpsLatitude: null,
          gpsLongitude: null,
          gpsAltitudeM: null,
          gpsParseError: null,
          cameraMakeRaw: 'STALE',
          cameraModelRaw: 'STALE CAMERA SHOULD NOT APPEAR',
          cameraDisplay: 'STALE CAMERA SHOULD NOT APPEAR',
          cameraNormalized: 'stale',
          lensMakeRaw: null,
          lensModelRaw: null,
          lensDisplay: null,
          lensNormalized: null,
          unknownTagCount: 0,
          parserLimitsNote: null,
          rawMetadataJson: null,
          errorCode: null,
          errorMessage: null,
          createdAtMs: 1700000030000,
          isCurrent: true
        }
      }
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.getByTestId('photo-technical-metadata-section')).not.toHaveTextContent(
      /STALE CAMERA SHOULD NOT APPEAR/
    )

    // Open Metadata & Filters and exercise combined SQL filters + stale page response guard
    fireEvent.click(screen.getByTestId('photos-toggle-metadata-filters'))
    const panel = await screen.findByTestId('photo-metadata-filter-panel')

    await waitFor(() => {
      expect(within(panel).getByTestId('filter-camera-select')).toHaveTextContent(/NIKON Z 8/)
    })

    // Trigger slow filter first, then immediately switch to real combined filter
    fireEvent.change(within(panel).getByTestId('filter-camera-select'), {
      target: { value: 'slow-camera' }
    })

    fireEvent.change(screen.getByLabelText('Filter by Rating'), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('Filter by Flag'), { target: { value: 'pick' } })
    fireEvent.change(within(panel).getByTestId('filter-date-from'), {
      target: { value: '2025-01-01' }
    })
    fireEvent.change(within(panel).getByTestId('filter-date-to'), {
      target: { value: '2025-12-31' }
    })
    fireEvent.click(within(panel).getByTestId('filter-include-unknown-date'))
    fireEvent.change(within(panel).getByTestId('filter-camera-select'), {
      target: { value: 'nikon z 8' }
    })
    fireEvent.change(within(panel).getByTestId('filter-lens-select'), {
      target: { value: 'nikkor z 24-70mm f/2.8 s' }
    })
    fireEvent.change(within(panel).getByTestId('filter-min-width'), {
      target: { value: '1920' }
    })
    fireEvent.change(within(panel).getByTestId('filter-min-height'), {
      target: { value: '1080' }
    })
    fireEvent.click(within(panel).getByTestId('filter-include-unknown-dimensions'))
    fireEvent.change(within(panel).getByTestId('filter-filetype-basis'), {
      target: { value: 'filename_extension' }
    })
    await waitFor(() => {
      expect(within(panel).getByTestId('filter-filetype-value')).toHaveTextContent('.jpg')
    })
    fireEvent.change(within(panel).getByTestId('filter-filetype-value'), {
      target: { value: '.jpg' }
    })

    await waitFor(() => {
      expect(screen.getByText('1 photo')).toBeInTheDocument()
    })

    // Resolve delayed 'slow-camera' response now -> MUST be dropped and NOT overwrite the 1 matching photo!
    stalePageDeferred.resolve({
      items: [p1, p2],
      totalCount: 99,
      offset: 0,
      limit: 50,
      hasMore: true
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.getByText('1 photo')).toBeInTheDocument()

    // Reset filters clears both Stage 5B and Stage 6C filters and restores full count (2 photos)
    fireEvent.click(screen.getByRole('button', { name: /Reset filters/i }))
    await waitFor(() => {
      expect(screen.getByText('2 photos')).toBeInTheDocument()
    })
    expect((screen.getByLabelText('Filter by Rating') as HTMLSelectElement).value).toBe('all')
    expect((within(panel).getByTestId('filter-camera-select') as HTMLSelectElement).value).toBe('')
    expect((within(panel).getByTestId('filter-min-width') as HTMLInputElement).value).toBe('')
  })

  it('guards against same-ID selected-photo revision races and delayed out-of-order facet search responses', async () => {
    let currentPhoto = makePhoto({
      id: 77,
      fileName: 'rev-race.jpg',
      discoveryObservationId: 701,
      byteSize: 400_000,
      activeHash: '1'.repeat(64)
    })

    const mockGetPhotosPage = vi.fn().mockImplementation(async () => ({
      items: [currentPhoto],
      totalCount: 1,
      offset: 0,
      limit: 50,
      hasMore: false
    }))

    let detailCall = 0
    const oldRevisionDetailDeferred = createDeferred<GetPhotoMetadataDetailResponse>()

    const mockGetMetadataDetail = vi.fn().mockImplementation(() => {
      detailCall++
      if (detailCall === 1) {
        return oldRevisionDetailDeferred.promise
      }
      return Promise.resolve({
        detail: {
          fileLocationId: 77,
          currentRevision: 'rev:702',
          effectiveStatus: 'stale',
          parserRecipeVersion: 'exif_tech_v1',
          recordedExtension: '.jpg',
          historicalMetadataCount: 1,
          currentMetadata: null
        }
      } satisfies GetPhotoMetadataDetailResponse)
    })

    const slowCameraFacetDeferred = createDeferred<GetPhotoMetadataFacetsResponse>()

    const mockGetMetadataFacets = vi
      .fn()
      .mockImplementation((req: GetPhotoMetadataFacetsRequest) => {
        if (req.field === 'camera' && req.search === 'ca') {
          return slowCameraFacetDeferred.promise
        }
        if (req.field === 'camera' && req.search === 'sony') {
          return Promise.resolve({
            field: 'camera',
            items: [
              { normalizedValue: 'sony ilce-7rm5', displayLabel: 'SONY ILCE-7RM5', count: 3 }
            ],
            unknownCount: 0,
            unprocessedCount: 0,
            offset: 0,
            limit: 15,
            hasMore: false
          } satisfies GetPhotoMetadataFacetsResponse)
        }
        return Promise.resolve({
          field: req.field,
          items: [],
          unknownCount: 0,
          unprocessedCount: 0,
          offset: 0,
          limit: 15,
          hasMore: false
        } satisfies GetPhotoMetadataFacetsResponse)
      })

    window.api = {
      ...window.api,
      getPhotosPage: mockGetPhotosPage,
      getThumbnail: vi.fn().mockResolvedValue({
        status: 'missing',
        locationId: 77,
        reason: 'test'
      }),
      cancelThumbnail: vi.fn(),
      listCollections: vi.fn().mockResolvedValue({
        items: [],
        totalCount: 0,
        offset: 0,
        limit: 50,
        hasMore: false
      }),
      getPhotoMemberships: vi.fn().mockResolvedValue({
        items: [],
        totalCount: 0,
        hasMore: false
      }),
      getPhotoMetadataProgress: vi.fn().mockResolvedValue(makeIdleProgress()),
      onPhotoMetadataProgress: vi.fn().mockReturnValue(() => {}),
      getPhotoMetadataDetail: mockGetMetadataDetail,
      getPhotoMetadataFacets: mockGetMetadataFacets
    } as unknown as VaultApi

    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('rev-race.jpg')).toBeInTheDocument()
    })

    // Select photo 77 on revision 701 (detail request 1 hangs)
    fireEvent.click(screen.getByRole('button', { name: /Details for rev-race\.jpg/i }))
    expect(detailCall).toBe(1)

    // Same fileLocationId (77) updates to a new revision (702) after rescan + Refresh
    currentPhoto = makePhoto({
      id: 77,
      fileName: 'rev-race.jpg',
      discoveryObservationId: 702,
      byteSize: 450_000,
      activeHash: '2'.repeat(64)
    })
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }))

    await waitFor(() => {
      expect(screen.getByTestId('photo-technical-metadata-section')).toHaveTextContent(
        /Stale \(source or parser recipe changed/i
      )
    })

    // Late response from old revision 701 arrives now -> MUST be discarded!
    oldRevisionDetailDeferred.resolve({
      detail: {
        fileLocationId: 77,
        currentRevision: 'rev:701',
        effectiveStatus: 'extracted',
        parserRecipeVersion: 'exif_tech_v1',
        recordedExtension: '.jpg',
        historicalMetadataCount: 0,
        currentMetadata: {
          id: 701,
          fileLocationId: 77,
          discoveryObservationId: 701,
          parserRecipeVersion: 'exif_tech_v1',
          extractionStatus: 'extracted',
          contentSha256: '1'.repeat(64),
          contentRevision: 'metarev:701',
          observedByteSize: 400_000,
          observedMtimeMs: 1700000005000,
          recordedExtension: '.jpg',
          detectedFormat: 'jpeg',
          extensionFormatMismatch: false,
          encodedWidthPx: 1000,
          encodedHeightPx: 1000,
          exifOrientation: 1,
          displayWidthPx: 1000,
          displayHeightPx: 1000,
          captureDateSourceTag: null,
          rawCaptureDateText: null,
          captureSubseconds: null,
          captureOffsetMinutes: null,
          captureOffsetText: null,
          captureTimezoneStatus: 'unknown',
          captureCalendarDate: null,
          captureYear: null,
          captureMonth: null,
          captureDay: null,
          captureLocalIso: null,
          captureUtcEpochMs: null,
          captureDateParseError: null,
          captureDateConflict: null,
          gpsStatus: 'absent',
          gpsLatitude: null,
          gpsLongitude: null,
          gpsAltitudeM: null,
          gpsParseError: null,
          cameraMakeRaw: 'OLD_REV_CAMERA',
          cameraModelRaw: 'OLD_REV_CAMERA',
          cameraDisplay: 'OLD_REV_CAMERA',
          cameraNormalized: 'old_rev_camera',
          lensMakeRaw: null,
          lensModelRaw: null,
          lensDisplay: null,
          lensNormalized: null,
          unknownTagCount: 0,
          parserLimitsNote: null,
          rawMetadataJson: null,
          errorCode: null,
          errorMessage: null,
          createdAtMs: 1700000030000,
          isCurrent: true
        }
      }
    })

    await new Promise((r) => setTimeout(r, 30))
    expect(screen.getByTestId('photo-technical-metadata-section')).not.toHaveTextContent(
      /OLD_REV_CAMERA/
    )
    expect(screen.getByTestId('photo-technical-metadata-section')).toHaveTextContent(
      /Stale \(source or parser recipe changed/i
    )

    // Test delayed out-of-order facet search response ('ca' slow vs 'sony' fast)
    fireEvent.click(screen.getByTestId('photos-toggle-metadata-filters'))
    const panel = await screen.findByTestId('photo-metadata-filter-panel')

    fireEvent.change(within(panel).getByTestId('filter-camera-search'), {
      target: { value: 'ca' }
    })
    fireEvent.change(within(panel).getByTestId('filter-camera-search'), {
      target: { value: 'sony' }
    })

    await waitFor(() => {
      expect(within(panel).getByTestId('filter-camera-select')).toHaveTextContent(/SONY ILCE-7RM5/)
    })

    // Resolve earlier 'ca' facet search -> MUST be dropped!
    slowCameraFacetDeferred.resolve({
      field: 'camera',
      items: [{ normalizedValue: 'stale-canon', displayLabel: 'STALE CANON FACET', count: 9 }],
      unknownCount: 0,
      unprocessedCount: 0,
      offset: 0,
      limit: 15,
      hasMore: false
    })

    await new Promise((r) => setTimeout(r, 30))
    expect(within(panel).getByTestId('filter-camera-select')).not.toHaveTextContent(
      /STALE CANON FACET/
    )
    expect(within(panel).getByTestId('filter-camera-select')).toHaveTextContent(/SONY ILCE-7RM5/)
  })
})
