/**
 * Personal Vault — Shared Photo SQL Filter Builder
 *
 * Constructs parameterized SQL WHERE clauses and technical-metadata JOINs
 * for Stage 5B review annotations/collections and Stage 6C technical metadata.
 * Shared by CatalogDatabase.queryFileLocations and SemanticSearchRepository.
 */

import type { SQLInputValue } from 'node:sqlite'
import type { QueryFileLocationsOptions } from './types'
import { METADATA_PARSER_RECIPE_VERSION } from '../metadata/types'

export interface PhotoFilterSqlClauses {
  readonly conditions: string[]
  readonly params: SQLInputValue[]
  readonly techMetaJoinClause: string
  readonly joinParams: SQLInputValue[]
}

/**
 * Constructs shared SQL WHERE filter conditions and joins for Stage 5B
 * ratings/flags/collections and Stage 6C technical metadata.
 */
export function buildPhotoFilterClauses(options: QueryFileLocationsOptions): PhotoFilterSqlClauses {
  const conditions: string[] = []
  const params: SQLInputValue[] = []

  if (typeof options.sourceId === 'number') {
    conditions.push('f.source_id = ?')
    params.push(options.sourceId)
  }

  if (options.category) {
    conditions.push('f.category = ?')
    params.push(options.category)
  }

  if (options.mediaKindFilter && options.mediaKindFilter !== 'all') {
    conditions.push('f.media_kind = ?')
    params.push(options.mediaKindFilter)
  }

  if (typeof options.hasActiveHash === 'boolean') {
    if (options.hasActiveHash) {
      conditions.push('h.sha256 IS NOT NULL')
    } else {
      conditions.push('h.sha256 IS NULL')
    }
  }

  if (options.sha256) {
    conditions.push('h.sha256 = ?')
    params.push(options.sha256.toLowerCase())
  }

  if (options.ratingFilter && options.ratingFilter !== 'all') {
    if (options.ratingFilter === 'unrated') {
      conditions.push('(a.rating IS NULL OR a.id IS NULL)')
    } else if (options.ratingFilter === '1') {
      conditions.push('a.rating >= 1')
    } else if (options.ratingFilter === '2') {
      conditions.push('a.rating >= 2')
    } else if (options.ratingFilter === '3') {
      conditions.push('a.rating >= 3')
    } else if (options.ratingFilter === '4') {
      conditions.push('a.rating >= 4')
    } else if (options.ratingFilter === '5') {
      conditions.push('a.rating = 5')
    }
  }

  if (options.flagFilter && options.flagFilter !== 'all') {
    if (options.flagFilter === 'none') {
      conditions.push("(a.flag = 'none' OR a.flag IS NULL OR a.id IS NULL)")
    } else if (options.flagFilter === 'pick') {
      conditions.push("a.flag = 'pick'")
    } else if (options.flagFilter === 'reject') {
      conditions.push("a.flag = 'reject'")
    }
  }

  if (typeof options.collectionId === 'number') {
    conditions.push(`
        EXISTS (
          SELECT 1 FROM collection_memberships cm
          WHERE cm.file_location_id = f.id AND cm.collection_id = ? AND cm.is_current = 1
            AND (cm.discovery_observation_id = d.id OR (cm.content_sha256 IS NOT NULL AND h.sha256 IS NOT NULL AND cm.content_sha256 = h.sha256))
        )
      `)
    params.push(options.collectionId)
  }

  // Stage 6C + metadata-aware search: SQL-backed technical metadata, recurring dates, GPS/places & file-type filters (combined with AND before pagination)
  const hasDateRange = Boolean(options.captureDateFrom || options.captureDateTo)
  const hasRecurringDate =
    typeof options.captureMonth === 'number' || typeof options.captureDay === 'number'
  const hasDateFilter = Boolean(
    hasDateRange || hasRecurringDate || options.includeUnknownCaptureDate
  )
  const hasGpsBounds = Boolean(options.gpsBounds)
  const hasUserPlaceFilter =
    typeof options.userPlaceId === 'number' ||
    Boolean(options.userPlaceLabel && options.userPlaceLabel.trim().length > 0)
  const hasCameraFilter = Boolean(options.cameraNormalized || options.onlyUnknownCamera)
  const hasLensFilter = Boolean(options.lensNormalized || options.onlyUnknownLens)
  const hasMinDimensions =
    typeof options.minWidthPx === 'number' || typeof options.minHeightPx === 'number'
  const hasDimensionFilter = Boolean(hasMinDimensions || options.includeUnknownDimensions)
  const fileTypeBasis = options.fileTypeBasis ?? 'detected_format'
  const hasDetectedFormatFilter =
    fileTypeBasis === 'detected_format' &&
    Boolean(options.fileTypeValue || options.onlyUnknownDetectedFormat)
  const hasExtensionFilter =
    fileTypeBasis === 'filename_extension' && Boolean(options.fileTypeValue)

  const needsTechMetaJoin =
    hasDateFilter ||
    hasGpsBounds ||
    hasCameraFilter ||
    hasLensFilter ||
    hasDimensionFilter ||
    hasDetectedFormatFilter

  const joinParams: SQLInputValue[] = []
  let techMetaJoinClause = ''
  if (needsTechMetaJoin) {
    const recipeVersion = options.parserRecipeVersion ?? METADATA_PARSER_RECIPE_VERSION
    techMetaJoinClause = `
        LEFT JOIN photo_technical_metadata tm
          ON tm.file_location_id = f.id
         AND tm.is_current = 1
         AND tm.parser_recipe_version = ?
         AND tm.discovery_observation_id = d.id
      `
    joinParams.push(recipeVersion)
  }

  if (hasDateFilter) {
    const knownDateParts: string[] = ["tm.extraction_status IN ('extracted', 'no_metadata')"]
    const knownDateParams: SQLInputValue[] = []

    if (hasDateRange) {
      knownDateParts.push('tm.capture_calendar_date IS NOT NULL')
      if (options.captureDateFrom) {
        knownDateParts.push('tm.capture_calendar_date >= ?')
        knownDateParams.push(options.captureDateFrom)
      }
      if (options.captureDateTo) {
        knownDateParts.push('tm.capture_calendar_date <= ?')
        knownDateParams.push(options.captureDateTo)
      }
    }

    if (hasRecurringDate) {
      if (typeof options.captureMonth === 'number') {
        knownDateParts.push('tm.capture_month = ?')
        knownDateParams.push(options.captureMonth)
      }
      if (typeof options.captureDay === 'number') {
        knownDateParts.push('tm.capture_day = ?')
        knownDateParams.push(options.captureDay)
      }
    }

    if ((hasDateRange || hasRecurringDate) && options.includeUnknownCaptureDate) {
      conditions.push(
        `((${knownDateParts.join(' AND ')}) OR (tm.extraction_status IN ('extracted', 'no_metadata') AND tm.capture_calendar_date IS NULL))`
      )
      params.push(...knownDateParams)
    } else if (hasDateRange || hasRecurringDate) {
      conditions.push(...knownDateParts)
      params.push(...knownDateParams)
    } else if (options.includeUnknownCaptureDate) {
      conditions.push("tm.extraction_status IN ('extracted', 'no_metadata')")
      conditions.push('tm.capture_calendar_date IS NULL')
    }
  }

  if (hasGpsBounds || hasUserPlaceFilter) {
    const placeBranches: string[] = []
    if (options.gpsBounds) {
      const { minLat, maxLat, minLon, maxLon } = options.gpsBounds
      const lonClause =
        minLon <= maxLon
          ? 'tm.gps_longitude >= ? AND tm.gps_longitude <= ?'
          : '(tm.gps_longitude >= ? OR tm.gps_longitude <= ?)'
      placeBranches.push(
        `(tm.extraction_status IN ('extracted', 'no_metadata') AND tm.gps_status = 'present' AND tm.gps_latitude IS NOT NULL AND tm.gps_longitude IS NOT NULL AND tm.gps_latitude >= ? AND tm.gps_latitude <= ? AND ${lonClause})`
      )
      params.push(minLat, maxLat, minLon, maxLon)
    }
    if (hasUserPlaceFilter) {
      const userPlaceConds: string[] = []
      if (typeof options.userPlaceId === 'number') {
        userPlaceConds.push('pup.place_id = ?')
        params.push(options.userPlaceId)
      }
      if (options.userPlaceLabel && options.userPlaceLabel.trim().length > 0) {
        userPlaceConds.push('pup.normalized_label = ?')
        params.push(options.userPlaceLabel.trim().toLowerCase())
      }
      placeBranches.push(
        `EXISTS (SELECT 1 FROM photo_user_places pup WHERE pup.file_location_id = f.id AND (${userPlaceConds.join(' OR ')}))`
      )
    }
    conditions.push(`(${placeBranches.join(' OR ')})`)
  }

  if (hasCameraFilter) {
    if (options.onlyUnknownCamera) {
      conditions.push("tm.extraction_status IN ('extracted', 'no_metadata')")
      conditions.push('tm.camera_normalized IS NULL')
    } else if (options.cameraNormalized) {
      conditions.push("tm.extraction_status IN ('extracted', 'no_metadata')")
      conditions.push('tm.camera_normalized = ?')
      params.push(options.cameraNormalized.trim().toLowerCase())
    }
  }

  if (hasLensFilter) {
    if (options.onlyUnknownLens) {
      conditions.push("tm.extraction_status IN ('extracted', 'no_metadata')")
      conditions.push('tm.lens_normalized IS NULL')
    } else if (options.lensNormalized) {
      conditions.push("tm.extraction_status IN ('extracted', 'no_metadata')")
      conditions.push('tm.lens_normalized = ?')
      params.push(options.lensNormalized.trim().toLowerCase())
    }
  }

  if (hasDimensionFilter) {
    if (hasMinDimensions && options.includeUnknownDimensions) {
      const knownSub: string[] = [
        "tm.extraction_status IN ('extracted', 'no_metadata')",
        'tm.display_width_px IS NOT NULL',
        'tm.display_height_px IS NOT NULL'
      ]
      if (typeof options.minWidthPx === 'number') {
        knownSub.push('tm.display_width_px >= ?')
        params.push(options.minWidthPx)
      }
      if (typeof options.minHeightPx === 'number') {
        knownSub.push('tm.display_height_px >= ?')
        params.push(options.minHeightPx)
      }
      conditions.push(
        `((${knownSub.join(' AND ')}) OR (tm.extraction_status IN ('extracted', 'no_metadata', 'unsupported', 'failed') AND (tm.display_width_px IS NULL OR tm.display_height_px IS NULL)))`
      )
    } else if (hasMinDimensions) {
      conditions.push("tm.extraction_status IN ('extracted', 'no_metadata')")
      conditions.push('tm.display_width_px IS NOT NULL')
      conditions.push('tm.display_height_px IS NOT NULL')
      if (typeof options.minWidthPx === 'number') {
        conditions.push('tm.display_width_px >= ?')
        params.push(options.minWidthPx)
      }
      if (typeof options.minHeightPx === 'number') {
        conditions.push('tm.display_height_px >= ?')
        params.push(options.minHeightPx)
      }
    } else if (options.includeUnknownDimensions) {
      conditions.push(
        "tm.extraction_status IN ('extracted', 'no_metadata', 'unsupported', 'failed')"
      )
      conditions.push('(tm.display_width_px IS NULL OR tm.display_height_px IS NULL)')
    }
  }

  if (hasExtensionFilter && options.fileTypeValue) {
    const trimmedExt = options.fileTypeValue.trim().toLowerCase()
    const normExt = trimmedExt.startsWith('.') ? trimmedExt : `.${trimmedExt}`
    conditions.push('LOWER(f.extension) = ?')
    params.push(normExt)
  } else if (hasDetectedFormatFilter) {
    if (options.onlyUnknownDetectedFormat) {
      conditions.push(
        "tm.extraction_status IN ('extracted', 'no_metadata', 'unsupported', 'failed')"
      )
      conditions.push('tm.detected_format IS NULL')
    } else if (options.fileTypeValue) {
      conditions.push(
        "tm.extraction_status IN ('extracted', 'no_metadata', 'unsupported', 'failed')"
      )
      conditions.push('tm.detected_format = ?')
      params.push(options.fileTypeValue.trim().toLowerCase())
    }
  }

  return { conditions, params, techMetaJoinClause, joinParams }
}
