import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import type { VaultApi } from '../../src/preload/index.d'
import type {
  GetPhotoMetadataDetailResponse,
  PhotoItem,
  PhotoMetadataProgressResponse
} from '../../src/shared/validation/ipc-schemas'

function makePhoto(id: number, fileName: string): PhotoItem {
  return {
    id,
    sourceId: 1,
    originalPath: `C:\\Users\\Ron\\Pictures\\${fileName}`,
    fileName,
    extension: '.heic',
    category: 'photo',
    discoveryObservationId: id,
    byteSize: 2048000,
    filesystemBirthtimeMs: 1758560000000,
    filesystemMtimeMs: 1758560000000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1758560000000,
    lastSeenAtMs: 1758560000000,
    activeHash: 'edcbf114655b534d39656642e0341c80d00cc5d0eb453c00abefb31895d397f9',
    activeHashVerifiedAtMs: 1758560000000,
    rating: null,
    flag: 'none',
    annotationVersion: 0
  }
}

const DEFAULT_META_PROGRESS: PhotoMetadataProgressResponse = {
  jobId: null,
  status: 'completed',
  parserRecipeVersion: 'exif_tech_v2',
  totalPhotos: 3,
  processedPhotos: 1,
  reusedPhotos: 0,
  extractedPhotos: 1,
  absentMetadataPhotos: 0,
  unsupportedPhotos: 0,
  failedPhotos: 1,
  unavailablePhotos: 0,
  pendingPhotos: 0,
  startedAtMs: 1000,
  updatedAtMs: 2000,
  completedAtMs: 2000,
  lastError: null,
  coverage: {
    parserRecipeVersion: 'exif_tech_v2',
    totalPhotos: 3,
    extractedCount: 1,
    noMetadataCount: 0,
    unsupportedCount: 0,
    failedCount: 1,
    unavailableCount: 0,
    staleCount: 0,
    unprocessedCount: 1
  }
}

describe('PhotosPanel clear separate status, honest GPS text, attention list & protection status', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows separate previews/metadata/visual statuses, honest Location not read yet vs No embedded GPS, copy/backup protection, and attention items', async () => {
    const unreadPhoto = makePhoto(1, 'unread.heic')
    const noGpsPhoto = makePhoto(2, 'no_gps.jpg')

    const unreadDetail: GetPhotoMetadataDetailResponse = {
      detail: {
        fileLocationId: 1,
        currentRevision: 'rev:1',
        effectiveStatus: 'unprocessed',
        parserRecipeVersion: 'exif_tech_v2',
        recordedExtension: '.heic',
        historicalMetadataCount: 0,
        currentMetadata: null,
        userPlace: null,
        cameraLabel: null,
        protectionStatus: {
          cataloged: true,
          hasVerifiedVaultCopy: false,
          vaultCopyVerifiedAtMs: null,
          vaultCopyRelativePath: null,
          hasVerifiedBackup: false,
          latestBackupVerifiedAtMs: null,
          latestBackupDestinationName: null,
          backupCoversVaultCopy: false
        }
      }
    }

    const noGpsDetail: GetPhotoMetadataDetailResponse = {
      detail: {
        fileLocationId: 2,
        currentRevision: 'rev:2',
        effectiveStatus: 'no_metadata',
        parserRecipeVersion: 'exif_tech_v2',
        recordedExtension: '.jpg',
        historicalMetadataCount: 0,
        currentMetadata: {
          id: 2,
          fileLocationId: 2,
          discoveryObservationId: 2,
          contentSha256: 'a'.repeat(64),
          contentRevision: 'rev:2',
          observedByteSize: 1024,
          observedMtimeMs: 1758560000000,
          parserRecipeVersion: 'exif_tech_v2',
          extractionStatus: 'no_metadata',
          detectedFormat: 'jpeg',
          recordedExtension: '.jpg',
          extensionFormatMismatch: false,
          encodedWidthPx: 800,
          encodedHeightPx: 600,
          exifOrientation: null,
          displayWidthPx: 800,
          displayHeightPx: 600,
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
          cameraMakeRaw: null,
          cameraModelRaw: null,
          cameraDisplay: null,
          cameraNormalized: null,
          lensMakeRaw: null,
          lensModelRaw: null,
          lensDisplay: null,
          lensNormalized: null,
          unknownTagCount: 0,
          parserLimitsNote: null,
          rawMetadataJson: null,
          errorCode: null,
          errorMessage: null,
          createdAtMs: 2000,
          isCurrent: true
        },
        userPlace: null,
        cameraLabel: null,
        protectionStatus: {
          cataloged: true,
          hasVerifiedVaultCopy: true,
          vaultCopyVerifiedAtMs: 1758561000000,
          vaultCopyRelativePath: 'objects/aa/aaaa.jpg',
          hasVerifiedBackup: true,
          latestBackupVerifiedAtMs: 1758562000000,
          latestBackupDestinationName: 'External SSD Backup',
          backupCoversVaultCopy: true
        }
      }
    }

    const startExtractionMock = vi.fn().mockResolvedValue(DEFAULT_META_PROGRESS)

    window.api = {
      ...window.api,
      getPhotosPage: vi.fn().mockResolvedValue({
        items: [unreadPhoto, noGpsPhoto],
        totalCount: 2,
        offset: 0,
        limit: 50,
        hasMore: false
      }),
      getThumbnail: vi.fn().mockResolvedValue({
        status: 'ready',
        locationId: 1,
        dataUrl: 'data:image/webp;base64,TEST',
        mimeType: 'image/webp',
        width: 120,
        height: 90
      }),
      cancelThumbnail: vi.fn().mockResolvedValue({ cancelled: true }),
      getThumbnailPrepProgress: vi.fn().mockResolvedValue({
        status: 'running',
        totalPhotos: 3,
        preparedPhotos: 1,
        unsupportedPhotos: 0,
        unavailablePhotos: 0,
        failedPhotos: 0,
        pendingPhotos: 2
      }),
      onThumbnailPrepProgress: vi.fn().mockReturnValue(() => {}),
      listCollections: vi
        .fn()
        .mockResolvedValue({ items: [], totalCount: 0, offset: 0, limit: 50, hasMore: false }),
      getPhotoMemberships: vi
        .fn()
        .mockResolvedValue({ items: [], totalCount: 0, offset: 0, limit: 50, hasMore: false }),
      getPhotoAnnotation: vi.fn().mockResolvedValue({ annotation: null }),
      getPhotoMetadataProgress: vi.fn().mockResolvedValue(DEFAULT_META_PROGRESS),
      onPhotoMetadataProgress: vi.fn().mockReturnValue(() => {}),
      startPhotoMetadataExtraction: startExtractionMock,
      getPhotoMetadataDetail: vi
        .fn()
        .mockImplementation(async ({ fileLocationId }: { fileLocationId: number }) =>
          fileLocationId === 1 ? unreadDetail : noGpsDetail
        ),
      getPhotoMetadataAttentionItems: vi.fn().mockResolvedValue({
        items: [
          {
            fileLocationId: 3,
            originalPath: 'C:\\Users\\Ron\\Pictures\\corrupt_gps.jpg',
            fileName: 'corrupt_gps.jpg',
            recordedExtension: '.jpg',
            extractionStatus: 'failed',
            errorCode: 'PARSE_ERROR',
            errorMessage: 'Corrupt EXIF header',
            updatedAtMs: 2000
          }
        ],
        totalCount: 1
      }),
      getPhotoMetadataFacets: vi.fn().mockResolvedValue({
        field: 'camera',
        items: [],
        unknownCount: 0,
        unprocessedCount: 1,
        offset: 0,
        limit: 15,
        hasMore: false
      }),
      listSavedEvents: vi.fn().mockResolvedValue({ events: [] }),
      listSavedPlaces: vi.fn().mockResolvedValue({ places: [] }),
      getSemanticModelStatus: vi.fn().mockResolvedValue({
        state: 'ready',
        modelId: 'clip',
        modelCommit: 'c',
        modelManifestSha256: '0'.repeat(64),
        preprocessingVersion: 'v1',
        dimensions: 512,
        requiredBytes: 100,
        downloadedBytes: 100,
        currentArtifact: null,
        verifiedAtMs: 1000,
        error: null,
        lastReplacementError: null
      }),
      getSemanticIndexProgress: vi.fn().mockResolvedValue({
        jobId: 'sem-1',
        status: 'running',
        modelId: 'clip',
        modelCommit: 'c',
        preprocessingVersion: 'v1',
        totalPhotos: 3,
        processedPhotos: 1,
        reusedPhotos: 0,
        unsupportedPhotos: 0,
        failedPhotos: 0,
        pendingPhotos: 2,
        totalCatalogPhotos: 3,
        currentIndexedPhotos: 1,
        startedAtMs: 1000,
        updatedAtMs: 2000,
        completedAtMs: null,
        lastError: null
      }),
      onSemanticModelStatus: vi.fn().mockReturnValue(() => {}),
      onSemanticIndexProgress: vi.fn().mockReturnValue(() => {}),
      getSemanticIndexJobItems: vi.fn().mockResolvedValue({
        jobId: 'sem-1',
        items: [],
        totalCount: 0,
        page: 1,
        pageSize: 25
      })
    } as unknown as VaultApi

    render(<PhotosPanel />)

    // Separate statuses in Photos toolbar
    await waitFor(() => {
      expect(screen.getByTestId('photos-prep-status')).toHaveTextContent(
        /Preparing (?:photo )?previews \(1 of 3\)/i
      )
      expect(screen.getByTestId('photos-metadata-status')).toHaveTextContent(/Dates & locations:/i)
      expect(screen.getByTestId('photos-visual-status')).toHaveTextContent(
        /Visual search: indexing 1 of 3/i
      )
    })

    // Select unread photo -> must say "Location not read yet" (never "no embedded GPS") and show no verified vault copy
    fireEvent.click(screen.getByRole('button', { name: /Details for unread\.heic/i }))
    await waitFor(() => {
      expect(screen.getByText('Capture Location (GPS)').parentElement).toHaveTextContent(
        /Location not read yet/i
      )
    })
    expect(screen.queryByText(/No embedded GPS/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('photo-protection-section')).toHaveTextContent(
      /No verified vault copy yet/i
    )
    expect(screen.getByTestId('photo-protection-section')).toHaveTextContent(
      /No verified backup yet/i
    )

    // Select photo that WAS read cleanly with no GPS -> must say "No embedded GPS" and show verified vault + backup
    fireEvent.click(screen.getByRole('button', { name: /Details for no_gps\.jpg/i }))
    await waitFor(() => {
      expect(screen.getByText('Capture Location (GPS)').parentElement).toHaveTextContent(
        /No embedded GPS/i
      )
    })
    expect(screen.getByTestId('photo-protection-section')).toHaveTextContent(/Verified Vault Copy/i)
    expect(screen.getByTestId('photo-protection-section')).toHaveTextContent(/External SSD Backup/i)

    // Open Filters & Metadata drawer and expand Files needing attention
    fireEvent.click(screen.getByTestId('photos-toggle-metadata-filters'))
    await waitFor(() => {
      expect(screen.getByTestId('metadata-attention-toggle')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('metadata-attention-toggle'))
    await waitFor(() => {
      expect(screen.getByTestId('metadata-attention-list')).toHaveTextContent(/corrupt_gps\.jpg/i)
      expect(screen.getByTestId('metadata-attention-list')).toHaveTextContent(
        /Corrupt EXIF header/i
      )
    })
  })
})
