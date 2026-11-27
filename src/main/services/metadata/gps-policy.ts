/**
 * Personal Vault — GPS Coordinate Extraction & Validation Policy
 *
 * Extracts recorded WGS-84 latitude, longitude, and optional altitude from
 * ExifReader's expanded GPS group and raw EXIF GPS tags without fabricating
 * coordinates or silently clamping out-of-range values.
 */

import type { GpsExtractionStatus } from './types'

export interface GpsResolution {
  readonly gpsStatus: GpsExtractionStatus
  readonly gpsLatitude: number | null
  readonly gpsLongitude: number | null
  readonly gpsAltitudeM: number | null
  readonly gpsParseError: string | null
  readonly rawGpsEvidence: Record<string, string | number> | null
}

function readTagDescOrValue(tag: unknown): string | null {
  if (!tag || typeof tag !== 'object') return null
  const rec = tag as { description?: unknown; value?: unknown }
  if (typeof rec.description === 'string' && rec.description.trim().length > 0) {
    return rec.description.trim()
  }
  if (typeof rec.value === 'string' && rec.value.trim().length > 0) {
    return rec.value.trim()
  }
  if (Array.isArray(rec.value) && rec.value.length > 0 && typeof rec.value[0] === 'string') {
    return rec.value[0].trim()
  }
  return null
}

function parseDmsArray(tag: unknown): number | null {
  if (!tag || typeof tag !== 'object') return null
  const raw = (tag as { value?: unknown }).value
  if (!Array.isArray(raw) || raw.length === 0) return null

  const toNum = (item: unknown): number | null => {
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (
      Array.isArray(item) &&
      item.length === 2 &&
      typeof item[0] === 'number' &&
      typeof item[1] === 'number' &&
      item[1] !== 0
    ) {
      return item[0] / item[1]
    }
    return null
  }

  const deg = toNum(raw[0])
  if (deg === null) return null
  const min = raw.length > 1 ? (toNum(raw[1]) ?? 0) : 0
  const sec = raw.length > 2 ? (toNum(raw[2]) ?? 0) : 0
  const total = deg + min / 60 + sec / 3600
  return Number.isFinite(total) ? total : null
}

export function resolveGpsCoordinates(params: {
  readonly gpsGroup?: Record<string, unknown> | null
  readonly exifGroup?: Record<string, unknown> | null
}): GpsResolution {
  const gpsGroup = params.gpsGroup ?? {}
  const exifGroup = params.exifGroup ?? {}

  const rawEvidence: Record<string, string | number> = {}
  const latTag = exifGroup.GPSLatitude
  const latRefTag = exifGroup.GPSLatitudeRef
  const lonTag = exifGroup.GPSLongitude
  const lonRefTag = exifGroup.GPSLongitudeRef
  const altTag = exifGroup.GPSAltitude
  const altRefTag = exifGroup.GPSAltitudeRef

  const latDesc = readTagDescOrValue(latTag)
  const latRefDesc = readTagDescOrValue(latRefTag)
  const lonDesc = readTagDescOrValue(lonTag)
  const lonRefDesc = readTagDescOrValue(lonRefTag)
  const altDesc = readTagDescOrValue(altTag)

  if (latDesc) rawEvidence.GPSLatitude = latDesc
  if (latRefDesc) rawEvidence.GPSLatitudeRef = latRefDesc
  if (lonDesc) rawEvidence.GPSLongitude = lonDesc
  if (lonRefDesc) rawEvidence.GPSLongitudeRef = lonRefDesc
  if (altDesc) rawEvidence.GPSAltitude = altDesc

  const hasGroupLat = typeof gpsGroup.Latitude === 'number'
  const hasGroupLon = typeof gpsGroup.Longitude === 'number'
  const hasGroupAlt = typeof gpsGroup.Altitude === 'number'
  const hasAnyGpsTag =
    hasGroupLat ||
    hasGroupLon ||
    hasGroupAlt ||
    latTag !== undefined ||
    lonTag !== undefined ||
    latRefTag !== undefined ||
    lonRefTag !== undefined ||
    altTag !== undefined

  if (!hasAnyGpsTag) {
    return {
      gpsStatus: 'absent',
      gpsLatitude: null,
      gpsLongitude: null,
      gpsAltitudeM: null,
      gpsParseError: null,
      rawGpsEvidence: null
    }
  }

  let lat: number | null =
    typeof gpsGroup.Latitude === 'number' && Number.isFinite(gpsGroup.Latitude)
      ? gpsGroup.Latitude
      : null
  let lon: number | null =
    typeof gpsGroup.Longitude === 'number' && Number.isFinite(gpsGroup.Longitude)
      ? gpsGroup.Longitude
      : null

  if (lat === null && latTag !== undefined) {
    const parsed = parseDmsArray(latTag)
    if (parsed !== null) {
      const ref = (latRefDesc ?? '').toUpperCase()
      lat = ref.startsWith('S') ? -Math.abs(parsed) : parsed
    }
  }
  if (lon === null && lonTag !== undefined) {
    const parsed = parseDmsArray(lonTag)
    if (parsed !== null) {
      const ref = (lonRefDesc ?? '').toUpperCase()
      lon = ref.startsWith('W') ? -Math.abs(parsed) : parsed
    }
  }

  if (lat === null || lon === null) {
    return {
      gpsStatus: 'invalid',
      gpsLatitude: null,
      gpsLongitude: null,
      gpsAltitudeM: null,
      gpsParseError: 'Incomplete or malformed GPS latitude/longitude tags',
      rawGpsEvidence: Object.keys(rawEvidence).length > 0 ? rawEvidence : null
    }
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return {
      gpsStatus: 'invalid',
      gpsLatitude: null,
      gpsLongitude: null,
      gpsAltitudeM: null,
      gpsParseError: `Out-of-range GPS coordinates (${lat}, ${lon})`,
      rawGpsEvidence: Object.keys(rawEvidence).length > 0 ? rawEvidence : null
    }
  }

  let altitudeM: number | null = null
  if (typeof gpsGroup.Altitude === 'number' && Number.isFinite(gpsGroup.Altitude)) {
    altitudeM = Math.round(gpsGroup.Altitude * 100) / 100
  } else if (altTag !== undefined) {
    const altVal = (altTag as { value?: unknown }).value
    if (
      Array.isArray(altVal) &&
      altVal.length === 2 &&
      typeof altVal[0] === 'number' &&
      typeof altVal[1] === 'number' &&
      altVal[1] !== 0
    ) {
      const rawAlt = altVal[0] / altVal[1]
      const refVal = (altRefTag as { value?: unknown } | undefined)?.value
      const belowSea = refVal === 1 || (Array.isArray(refVal) && refVal[0] === 1)
      altitudeM = Math.round((belowSea ? -rawAlt : rawAlt) * 100) / 100
    }
  }

  rawEvidence.resolvedDecimal = `${lat.toFixed(6)}, ${lon.toFixed(6)}`

  return {
    gpsStatus: 'present',
    gpsLatitude: Math.round(lat * 1_000_000) / 1_000_000,
    gpsLongitude: Math.round(lon * 1_000_000) / 1_000_000,
    gpsAltitudeM: altitudeM,
    gpsParseError: null,
    rawGpsEvidence: rawEvidence
  }
}
