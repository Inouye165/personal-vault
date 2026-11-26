/**
 * Personal Vault — Stage 6C Technical Photo Metadata Contracts & Resource Bounds
 */

export const METADATA_PARSER_RECIPE_VERSION = 'exif_tech_v2' as const

export const METADATA_LIMITS = {
  MAX_SOURCE_SIZE_BYTES: 128 * 1024 * 1024, // 128 MiB
  MAX_METADATA_PARSE_BYTES: 4 * 1024 * 1024, // 4 MiB max embedded metadata payload
  MAX_RAW_EVIDENCE_JSON_BYTES: 32 * 1024, // 32 KiB max serialized raw evidence JSON
  MAX_TEXT_LENGTH: 256,
  MAX_DIMENSION_EDGE_PX: 100_000,
  MAX_DIMENSION_AREA_PX: 1_000_000_000, // 1 Gigapixel header cap
  JOB_SNAPSHOT_BATCH_SIZE: 500,
  JOB_FETCH_BATCH_SIZE: 16,
  TASK_TIMEOUT_MS: 15_000,
  FACET_DEFAULT_LIMIT: 25,
  FACET_MAX_LIMIT: 50
} as const

export type MetadataExtractionStatus =
  'unprocessed' | 'extracted' | 'no_metadata' | 'unsupported' | 'failed' | 'unavailable' | 'stale'

export type PersistedMetadataExtractionStatus =
  'extracted' | 'no_metadata' | 'unsupported' | 'failed' | 'unavailable' | 'stale'

export type GpsExtractionStatus = 'present' | 'absent' | 'invalid'

export type CaptureDateSourceTag = 'DateTimeOriginal' | 'DateTimeDigitized'

export type CaptureTimezoneStatus =
  'offset_present' | 'local_wall_clock_unknown_tz' | 'invalid_offset' | 'unknown'

export type SupportedMetadataContainerFormat =
  'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'tiff' | 'heic'

export type UnsupportedContainerFormat =
  'cr2' | 'cr3' | 'dng' | 'nef' | 'arw' | 'orf' | 'rw2' | 'raf' | 'pef' | 'bmp' | 'raw_tiff'

export type DetectedContainerFormat = SupportedMetadataContainerFormat | UnsupportedContainerFormat

export interface CaptureDateResolution {
  readonly captureDateSourceTag: CaptureDateSourceTag | null
  readonly rawCaptureDateText: string | null
  readonly captureSubseconds: string | null
  readonly captureOffsetMinutes: number | null
  readonly captureOffsetText: string | null
  readonly captureTimezoneStatus: CaptureTimezoneStatus
  readonly captureCalendarDate: string | null
  readonly captureLocalIso: string | null
  readonly captureUtcEpochMs: number | null
  readonly captureDateParseError: string | null
  readonly captureDateConflict: string | null
}

export interface DimensionResolution {
  readonly encodedWidthPx: number | null
  readonly encodedHeightPx: number | null
  readonly exifOrientation: number | null
  readonly displayWidthPx: number | null
  readonly displayHeightPx: number | null
  readonly dimensionWarning: string | null
}

export interface CameraLensResolution {
  readonly cameraMakeRaw: string | null
  readonly cameraModelRaw: string | null
  readonly cameraDisplay: string | null
  readonly cameraNormalized: string | null
  readonly lensMakeRaw: string | null
  readonly lensModelRaw: string | null
  readonly lensDisplay: string | null
  readonly lensNormalized: string | null
  readonly wasTruncated: boolean
}

export interface ExtractedPhotoMetadataResult {
  readonly extractionStatus: 'extracted' | 'no_metadata' | 'unsupported' | 'failed'
  readonly parserRecipeVersion: string
  readonly contentSha256: string | null
  readonly observedByteSize: number | null
  readonly observedMtimeMs: number | null
  readonly recordedExtension: string
  readonly detectedFormat: DetectedContainerFormat | null
  readonly extensionFormatMismatch: boolean

  readonly encodedWidthPx: number | null
  readonly encodedHeightPx: number | null
  readonly exifOrientation: number | null
  readonly displayWidthPx: number | null
  readonly displayHeightPx: number | null

  readonly captureDateSourceTag: CaptureDateSourceTag | null
  readonly rawCaptureDateText: string | null
  readonly captureSubseconds: string | null
  readonly captureOffsetMinutes: number | null
  readonly captureOffsetText: string | null
  readonly captureTimezoneStatus: CaptureTimezoneStatus
  readonly captureCalendarDate: string | null
  readonly captureYear: number | null
  readonly captureMonth: number | null
  readonly captureDay: number | null
  readonly captureLocalIso: string | null
  readonly captureUtcEpochMs: number | null
  readonly captureDateParseError: string | null
  readonly captureDateConflict: string | null

  readonly gpsStatus: GpsExtractionStatus
  readonly gpsLatitude: number | null
  readonly gpsLongitude: number | null
  readonly gpsAltitudeM: number | null
  readonly gpsParseError: string | null

  readonly cameraMakeRaw: string | null
  readonly cameraModelRaw: string | null
  readonly cameraDisplay: string | null
  readonly cameraNormalized: string | null
  readonly lensMakeRaw: string | null
  readonly lensModelRaw: string | null
  readonly lensDisplay: string | null
  readonly lensNormalized: string | null

  readonly unknownTagCount: number
  readonly parserLimitsNote: string | null
  readonly rawMetadataJson: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
}

export interface PhotoMetadataCoverageSnapshot {
  readonly parserRecipeVersion: string
  readonly totalPhotos: number
  readonly extractedCount: number
  readonly noMetadataCount: number
  readonly unsupportedCount: number
  readonly failedCount: number
  readonly unavailableCount: number
  readonly staleCount: number
  readonly unprocessedCount: number
}

export interface PhotoMetadataExtractionProgress {
  readonly jobId: string | null
  readonly status:
    'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'interrupted' | 'failed'
  readonly parserRecipeVersion: string
  readonly totalPhotos: number
  readonly processedPhotos: number
  readonly extractedPhotos: number
  readonly absentMetadataPhotos: number
  readonly reusedPhotos: number
  readonly unsupportedPhotos: number
  readonly failedPhotos: number
  readonly unavailablePhotos: number
  readonly pendingPhotos: number
  readonly startedAtMs: number | null
  readonly updatedAtMs: number | null
  readonly completedAtMs: number | null
  readonly lastError: string | null
  readonly coverage: PhotoMetadataCoverageSnapshot
}
