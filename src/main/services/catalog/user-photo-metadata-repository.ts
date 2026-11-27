/**
 * Personal Vault — User-Assigned Photo Metadata Repository
 *
 * Manages user-defined places, per-photo place overrides, saved named events
 * (date ranges), and user camera labels strictly separate from immutable
 * filesystem facts and extracted EXIF metadata.
 */

import type { DatabaseSync } from 'node:sqlite'
import type {
  CameraLabelRecord,
  PhotoUserPlaceRecord,
  SavedEventRecord,
  SavedPlaceRecord
} from './types'

export interface UpsertSavedEventInput {
  readonly name: string
  readonly dateFrom: string
  readonly dateTo: string
  readonly notes?: string | null
}

export interface UpsertSavedPlaceInput {
  readonly name: string
  readonly minLat: number
  readonly maxLat: number
  readonly minLon: number
  readonly maxLon: number
  readonly centerLat?: number
  readonly centerLon?: number
  readonly radiusKm?: number | null
  readonly notes?: string | null
}

export interface SetPhotoUserPlaceInput {
  readonly fileLocationId: number
  readonly placeId?: number | null
  readonly placeLabel: string
}

export interface UpsertCameraLabelInput {
  readonly cameraNormalized: string
  readonly label: string
}

function normalizeKey(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

function isValidCalendarIso(val: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return false
  const [y, m, d] = val.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, m! - 1, d!))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d
}

export class UserPhotoMetadataRepository {
  private readonly getDb: () => DatabaseSync

  public constructor(deps: { readonly getDb: () => DatabaseSync }) {
    this.getDb = deps.getDb
  }

  public listSavedEvents(): SavedEventRecord[] {
    const db = this.getDb()
    const rows = db
      .prepare('SELECT * FROM saved_events ORDER BY date_from DESC, name ASC;')
      .all() as Array<Record<string, unknown>>
    return rows.map((r) => this.mapSavedEventRow(r))
  }

  public findSavedEventByName(name: string): SavedEventRecord | null {
    const norm = normalizeKey(name)
    if (!norm) return null
    const db = this.getDb()
    const row = db
      .prepare('SELECT * FROM saved_events WHERE normalized_name = ? LIMIT 1;')
      .get(norm) as Record<string, unknown> | undefined
    return row ? this.mapSavedEventRow(row) : null
  }

  public upsertSavedEvent(input: UpsertSavedEventInput): SavedEventRecord {
    const name = input.name.trim().replace(/\s+/g, ' ')
    const norm = normalizeKey(name)
    if (!name || name.length > 120) {
      throw new RangeError('Event name must be between 1 and 120 characters')
    }
    if (!isValidCalendarIso(input.dateFrom) || !isValidCalendarIso(input.dateTo)) {
      throw new RangeError('Event dates must be valid YYYY-MM-DD calendar dates')
    }
    if (input.dateFrom > input.dateTo) {
      throw new RangeError('Event start date must be on or before end date')
    }
    const notes = input.notes ? input.notes.trim().slice(0, 500) : null
    const now = Date.now()
    const db = this.getDb()

    db.prepare(
      `
      INSERT INTO saved_events (name, normalized_name, date_from, date_to, notes, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(normalized_name) DO UPDATE SET
        name = excluded.name,
        date_from = excluded.date_from,
        date_to = excluded.date_to,
        notes = excluded.notes,
        updated_at_ms = excluded.updated_at_ms;
    `
    ).run(name, norm, input.dateFrom, input.dateTo, notes, now, now)

    return this.findSavedEventByName(name)!
  }

  public deleteSavedEvent(id: number): boolean {
    const db = this.getDb()
    const res = db.prepare('DELETE FROM saved_events WHERE id = ?;').run(id)
    return Number(res.changes) > 0
  }

  public listSavedPlaces(): SavedPlaceRecord[] {
    const db = this.getDb()
    const rows = db.prepare('SELECT * FROM saved_places ORDER BY name ASC;').all() as Array<
      Record<string, unknown>
    >
    return rows.map((r) => this.mapSavedPlaceRow(r))
  }

  public findSavedPlaceByName(name: string): SavedPlaceRecord | null {
    const norm = normalizeKey(name)
    if (!norm) return null
    const db = this.getDb()
    const row = db
      .prepare('SELECT * FROM saved_places WHERE normalized_name = ? LIMIT 1;')
      .get(norm) as Record<string, unknown> | undefined
    return row ? this.mapSavedPlaceRow(row) : null
  }

  public upsertSavedPlace(input: UpsertSavedPlaceInput): SavedPlaceRecord {
    const name = input.name.trim().replace(/\s+/g, ' ')
    const norm = normalizeKey(name)
    if (!name || name.length > 120) {
      throw new RangeError('Place name must be between 1 and 120 characters')
    }
    if (
      !Number.isFinite(input.minLat) ||
      !Number.isFinite(input.maxLat) ||
      !Number.isFinite(input.minLon) ||
      !Number.isFinite(input.maxLon) ||
      input.minLat < -90 ||
      input.maxLat > 90 ||
      input.minLat > input.maxLat ||
      input.minLon < -180 ||
      input.maxLon > 180
    ) {
      throw new RangeError('Place bounding coordinates are invalid')
    }

    const centerLat =
      typeof input.centerLat === 'number' && Number.isFinite(input.centerLat)
        ? input.centerLat
        : (input.minLat + input.maxLat) / 2
    const centerLon =
      typeof input.centerLon === 'number' && Number.isFinite(input.centerLon)
        ? input.centerLon
        : (input.minLon + input.maxLon) / 2
    const radiusKm =
      typeof input.radiusKm === 'number' && Number.isFinite(input.radiusKm) && input.radiusKm > 0
        ? input.radiusKm
        : null
    const notes = input.notes ? input.notes.trim().slice(0, 500) : null
    const now = Date.now()
    const db = this.getDb()

    db.prepare(
      `
      INSERT INTO saved_places (
        name, normalized_name, min_lat, max_lat, min_lon, max_lon,
        center_lat, center_lon, radius_km, notes, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(normalized_name) DO UPDATE SET
        name = excluded.name,
        min_lat = excluded.min_lat,
        max_lat = excluded.max_lat,
        min_lon = excluded.min_lon,
        max_lon = excluded.max_lon,
        center_lat = excluded.center_lat,
        center_lon = excluded.center_lon,
        radius_km = excluded.radius_km,
        notes = excluded.notes,
        updated_at_ms = excluded.updated_at_ms;
    `
    ).run(
      name,
      norm,
      input.minLat,
      input.maxLat,
      input.minLon,
      input.maxLon,
      centerLat,
      centerLon,
      radiusKm,
      notes,
      now,
      now
    )

    return this.findSavedPlaceByName(name)!
  }

  public deleteSavedPlace(id: number): boolean {
    const db = this.getDb()
    const res = db.prepare('DELETE FROM saved_places WHERE id = ?;').run(id)
    return Number(res.changes) > 0
  }

  public getPhotoUserPlace(fileLocationId: number): PhotoUserPlaceRecord | null {
    const db = this.getDb()
    const row = db
      .prepare('SELECT * FROM photo_user_places WHERE file_location_id = ? LIMIT 1;')
      .get(fileLocationId) as Record<string, unknown> | undefined
    return row ? this.mapPhotoUserPlaceRow(row) : null
  }

  public setPhotoUserPlace(input: SetPhotoUserPlaceInput): PhotoUserPlaceRecord {
    const placeLabel = input.placeLabel.trim().replace(/\s+/g, ' ')
    const normalizedLabel = normalizeKey(placeLabel)
    if (!placeLabel || placeLabel.length > 120) {
      throw new RangeError('Place label must be between 1 and 120 characters')
    }
    const now = Date.now()
    const db = this.getDb()
    db.prepare(
      `
      INSERT INTO photo_user_places (
        file_location_id, place_id, place_label, normalized_label, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_location_id) DO UPDATE SET
        place_id = excluded.place_id,
        place_label = excluded.place_label,
        normalized_label = excluded.normalized_label,
        updated_at_ms = excluded.updated_at_ms;
    `
    ).run(input.fileLocationId, input.placeId ?? null, placeLabel, normalizedLabel, now, now)

    return this.getPhotoUserPlace(input.fileLocationId)!
  }

  public clearPhotoUserPlace(fileLocationId: number): boolean {
    const db = this.getDb()
    const res = db
      .prepare('DELETE FROM photo_user_places WHERE file_location_id = ?;')
      .run(fileLocationId)
    return Number(res.changes) > 0
  }

  public listCameraLabels(): CameraLabelRecord[] {
    const db = this.getDb()
    const rows = db.prepare('SELECT * FROM camera_labels ORDER BY label ASC;').all() as Array<
      Record<string, unknown>
    >
    return rows.map((r) => this.mapCameraLabelRow(r))
  }

  public getCameraLabel(cameraNormalized: string | null): CameraLabelRecord | null {
    if (!cameraNormalized) return null
    const normCam = normalizeKey(cameraNormalized)
    const db = this.getDb()
    const row = db
      .prepare('SELECT * FROM camera_labels WHERE camera_normalized = ? LIMIT 1;')
      .get(normCam) as Record<string, unknown> | undefined
    return row ? this.mapCameraLabelRow(row) : null
  }

  public upsertCameraLabel(input: UpsertCameraLabelInput): CameraLabelRecord {
    const camNorm = normalizeKey(input.cameraNormalized)
    const label = input.label.trim().replace(/\s+/g, ' ')
    const normLabel = normalizeKey(label)
    if (!camNorm || camNorm.length > 256) {
      throw new RangeError('Camera identifier is invalid')
    }
    if (!label || label.length > 120) {
      throw new RangeError('Camera label must be between 1 and 120 characters')
    }
    const now = Date.now()
    const db = this.getDb()
    db.prepare(
      `
      INSERT INTO camera_labels (camera_normalized, label, normalized_label, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(camera_normalized) DO UPDATE SET
        label = excluded.label,
        normalized_label = excluded.normalized_label,
        updated_at_ms = excluded.updated_at_ms;
    `
    ).run(camNorm, label, normLabel, now, now)

    return this.getCameraLabel(camNorm)!
  }

  public deleteCameraLabel(id: number): boolean {
    const db = this.getDb()
    const res = db.prepare('DELETE FROM camera_labels WHERE id = ?;').run(id)
    return Number(res.changes) > 0
  }

  private mapSavedEventRow(row: Record<string, unknown>): SavedEventRecord {
    return {
      id: Number(row.id),
      name: String(row.name),
      normalizedName: String(row.normalized_name),
      dateFrom: String(row.date_from),
      dateTo: String(row.date_to),
      notes: row.notes !== null && row.notes !== undefined ? String(row.notes) : null,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    }
  }

  private mapSavedPlaceRow(row: Record<string, unknown>): SavedPlaceRecord {
    return {
      id: Number(row.id),
      name: String(row.name),
      normalizedName: String(row.normalized_name),
      minLat: Number(row.min_lat),
      maxLat: Number(row.max_lat),
      minLon: Number(row.min_lon),
      maxLon: Number(row.max_lon),
      centerLat: Number(row.center_lat),
      centerLon: Number(row.center_lon),
      radiusKm:
        row.radius_km !== null && row.radius_km !== undefined ? Number(row.radius_km) : null,
      notes: row.notes !== null && row.notes !== undefined ? String(row.notes) : null,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    }
  }

  private mapPhotoUserPlaceRow(row: Record<string, unknown>): PhotoUserPlaceRecord {
    return {
      id: Number(row.id),
      fileLocationId: Number(row.file_location_id),
      placeId: row.place_id !== null && row.place_id !== undefined ? Number(row.place_id) : null,
      placeLabel: String(row.place_label),
      normalizedLabel: String(row.normalized_label),
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    }
  }

  private mapCameraLabelRow(row: Record<string, unknown>): CameraLabelRecord {
    return {
      id: Number(row.id),
      cameraNormalized: String(row.camera_normalized),
      label: String(row.label),
      normalizedLabel: String(row.normalized_label),
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    }
  }
}
