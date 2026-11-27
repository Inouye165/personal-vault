/**
 * Personal Vault — Stage 8B Sub-slice 1B: Backup Persistence Repository (`BackupRepository`)
 *
 * Manages SQLite Migration 17 persistence:
 * - `backup_destinations`
 * - `backup_jobs`
 * - `backup_job_units`
 * - `backup_destination_objects`
 * - `backup_bandwidth_ledger`
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  BackupEncryptionMode,
  BackupVerificationScope
} from '../../../shared/validation/backup-schemas'

export type BackupDestinationKind = 'local_fs' | 'google_drive' | 'drive_for_desktop'

export type BackupJobStatus =
  | 'queued_destination_unavailable'
  | 'capturing'
  | 'running'
  | 'paused'
  | 'interrupted'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'abandoned'

export type BackupPauseReason =
  | 'destination_unavailable'
  | 'user_paused'
  | 'daily_budget_exhausted'
  | 'provider_quota'
  | 'metered_network'

export type BackupJobUnitKind = 'chunk' | 'manifest' | 'complete_marker'

export type BackupJobUnitStatus =
  'pending' | 'in_progress' | 'verified' | 'reused' | 'failed' | 'cancelled'

export interface BackupDestinationRecord {
  readonly id: string
  readonly name: string
  readonly kind: BackupDestinationKind
  readonly targetPath: string | null
  readonly maxBytesPerSecond: number | null
  readonly dailyBudgetBytes: number | null
  readonly encryptionMode: BackupEncryptionMode
  readonly repositoryId: string | null
  readonly isEnabled: boolean
  readonly lastVerifiedSnapshotId: string | null
  readonly lastVerifiedAtMs: number | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface BackupJobRecord {
  readonly id: string
  readonly destinationId: string
  readonly snapshotId: string
  readonly repositoryId: string | null
  readonly status: BackupJobStatus
  readonly pauseReason: BackupPauseReason | null
  readonly stagingDir: string | null
  readonly verificationScope: BackupVerificationScope | null
  readonly totalObjectCount: number
  readonly completedObjectCount: number
  readonly writtenChunkCount: number
  readonly reusedChunkCount: number
  readonly totalLogicalBytes: number
  readonly totalStoredBytes: number
  readonly transferredBytes: number
  readonly manifestSha256: string | null
  readonly abandonedFromJobId: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly createdAtMs: number
  readonly startedAtMs: number | null
  readonly updatedAtMs: number
  readonly completedAtMs: number | null
}

export interface BackupJobUnitRecord {
  readonly id: number
  readonly jobId: string
  readonly unitKind: BackupJobUnitKind
  readonly objectId: string
  readonly plaintextSha256: string | null
  readonly plaintextByteSize: number
  readonly storedByteSize: number
  readonly status: BackupJobUnitStatus
  readonly retryCount: number
  readonly resumeSessionUri: string | null
  readonly uploadedOffsetBytes: number
  readonly updatedAtMs: number
}

export interface BackupDestinationObjectRecord {
  readonly destinationId: string
  readonly objectId: string
  readonly storedByteSize: number
  readonly plaintextSha256: string | null
  readonly verifiedAtMs: number
  readonly lastSnapshotId: string | null
}

export interface CreateBackupDestinationInput {
  readonly id?: string
  readonly name: string
  readonly kind: BackupDestinationKind
  readonly targetPath: string | null
  readonly maxBytesPerSecond?: number | null
  readonly dailyBudgetBytes?: number | null
  readonly encryptionMode?: BackupEncryptionMode
  readonly isEnabled?: boolean
  readonly nowMs?: number
}

export interface UpdateBackupDestinationInput {
  readonly name?: string
  readonly targetPath?: string | null
  readonly maxBytesPerSecond?: number | null
  readonly dailyBudgetBytes?: number | null
  readonly repositoryId?: string | null
  readonly isEnabled?: boolean
  readonly lastVerifiedSnapshotId?: string | null
  readonly lastVerifiedAtMs?: number | null
  readonly nowMs?: number
}

export interface CreateBackupJobInput {
  readonly id?: string
  readonly destinationId: string
  readonly snapshotId: string
  readonly repositoryId?: string | null
  readonly status: BackupJobStatus
  readonly pauseReason?: BackupPauseReason | null
  readonly stagingDir?: string | null
  readonly abandonedFromJobId?: string | null
  readonly createdAtMs?: number
  readonly startedAtMs?: number | null
}

export interface UpdateBackupJobStateInput {
  readonly status?: BackupJobStatus
  readonly pauseReason?: BackupPauseReason | null
  readonly repositoryId?: string | null
  readonly stagingDir?: string | null
  readonly verificationScope?: BackupVerificationScope | null
  readonly totalObjectCount?: number
  readonly completedObjectCount?: number
  readonly writtenChunkCount?: number
  readonly reusedChunkCount?: number
  readonly totalLogicalBytes?: number
  readonly totalStoredBytes?: number
  readonly transferredBytes?: number
  readonly manifestSha256?: string | null
  readonly errorCode?: string | null
  readonly errorMessage?: string | null
  readonly startedAtMs?: number | null
  readonly completedAtMs?: number | null
  readonly nowMs?: number
}

export interface UpsertBackupJobUnitInput {
  readonly jobId: string
  readonly unitKind: BackupJobUnitKind
  readonly objectId: string
  readonly plaintextSha256?: string | null
  readonly plaintextByteSize?: number
  readonly storedByteSize?: number
  readonly status: BackupJobUnitStatus
  readonly retryCount?: number
  readonly resumeSessionUri?: string | null
  readonly uploadedOffsetBytes?: number
  readonly updatedAtMs?: number
}

export interface UpsertBackupDestinationObjectInput {
  readonly destinationId: string
  readonly objectId: string
  readonly storedByteSize: number
  readonly plaintextSha256?: string | null
  readonly verifiedAtMs?: number
  readonly lastSnapshotId?: string | null
}

export interface ListBackupJobsOptions {
  readonly destinationId?: string
  readonly status?: BackupJobStatus
  readonly limit?: number
  readonly offset?: number
}

export interface PaginatedBackupResult<T> {
  readonly items: readonly T[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

function mapDestinationRow(row: Record<string, unknown>): BackupDestinationRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as BackupDestinationKind,
    targetPath: row.target_path !== null ? String(row.target_path) : null,
    maxBytesPerSecond: row.max_bytes_per_second !== null ? Number(row.max_bytes_per_second) : null,
    dailyBudgetBytes: row.daily_budget_bytes !== null ? Number(row.daily_budget_bytes) : null,
    encryptionMode: row.encryption_mode as BackupEncryptionMode,
    repositoryId: row.repository_id !== null ? String(row.repository_id) : null,
    isEnabled: Number(row.is_enabled) === 1,
    lastVerifiedSnapshotId:
      row.last_verified_snapshot_id !== null ? String(row.last_verified_snapshot_id) : null,
    lastVerifiedAtMs: row.last_verified_at_ms !== null ? Number(row.last_verified_at_ms) : null,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms)
  }
}

function mapJobRow(row: Record<string, unknown>): BackupJobRecord {
  return {
    id: String(row.id),
    destinationId: String(row.destination_id),
    snapshotId: String(row.snapshot_id),
    repositoryId: row.repository_id !== null ? String(row.repository_id) : null,
    status: row.status as BackupJobStatus,
    pauseReason: row.pause_reason !== null ? (row.pause_reason as BackupPauseReason) : null,
    stagingDir: row.staging_dir !== null ? String(row.staging_dir) : null,
    verificationScope:
      row.verification_scope !== null ? (row.verification_scope as BackupVerificationScope) : null,
    totalObjectCount: Number(row.total_object_count),
    completedObjectCount: Number(row.completed_object_count),
    writtenChunkCount: Number(row.written_chunk_count),
    reusedChunkCount: Number(row.reused_chunk_count),
    totalLogicalBytes: Number(row.total_logical_bytes),
    totalStoredBytes: Number(row.total_stored_bytes),
    transferredBytes: Number(row.transferred_bytes),
    manifestSha256: row.manifest_sha256 !== null ? String(row.manifest_sha256) : null,
    abandonedFromJobId:
      row.abandoned_from_job_id !== null ? String(row.abandoned_from_job_id) : null,
    errorCode: row.error_code !== null ? String(row.error_code) : null,
    errorMessage: row.error_message !== null ? String(row.error_message) : null,
    createdAtMs: Number(row.created_at_ms),
    startedAtMs: row.started_at_ms !== null ? Number(row.started_at_ms) : null,
    updatedAtMs: Number(row.updated_at_ms),
    completedAtMs: row.completed_at_ms !== null ? Number(row.completed_at_ms) : null
  }
}

function mapUnitRow(row: Record<string, unknown>): BackupJobUnitRecord {
  return {
    id: Number(row.id),
    jobId: String(row.job_id),
    unitKind: row.unit_kind as BackupJobUnitKind,
    objectId: String(row.object_id),
    plaintextSha256: row.plaintext_sha256 !== null ? String(row.plaintext_sha256) : null,
    plaintextByteSize: Number(row.plaintext_byte_size),
    storedByteSize: Number(row.stored_byte_size),
    status: row.status as BackupJobUnitStatus,
    retryCount: Number(row.retry_count),
    resumeSessionUri: row.resume_session_uri !== null ? String(row.resume_session_uri) : null,
    uploadedOffsetBytes: Number(row.uploaded_offset_bytes),
    updatedAtMs: Number(row.updated_at_ms)
  }
}

function mapDestObjectRow(row: Record<string, unknown>): BackupDestinationObjectRecord {
  return {
    destinationId: String(row.destination_id),
    objectId: String(row.object_id),
    storedByteSize: Number(row.stored_byte_size),
    plaintextSha256: row.plaintext_sha256 !== null ? String(row.plaintext_sha256) : null,
    verifiedAtMs: Number(row.verified_at_ms),
    lastSnapshotId: row.last_snapshot_id !== null ? String(row.last_snapshot_id) : null
  }
}

export class BackupRepository {
  private readonly db: DatabaseSync

  public constructor(options: { readonly db: DatabaseSync }) {
    this.db = options.db
  }

  private runInTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;')
    try {
      const result = fn()
      this.db.exec('COMMIT;')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore rollback error
      }
      throw err
    }
  }

  // ---------------------------------------------------------------------------
  // Destinations
  // ---------------------------------------------------------------------------

  public createDestination(input: CreateBackupDestinationInput): BackupDestinationRecord {
    const id = input.id ?? randomUUID()
    const now = input.nowMs ?? Date.now()
    const maxRate = input.maxBytesPerSecond ?? null
    if (maxRate !== null && (!Number.isInteger(maxRate) || maxRate < 65_536)) {
      throw new Error('maxBytesPerSecond must be null or an integer >= 65536 (64 KiB/s)')
    }
    const dailyBudget = input.dailyBudgetBytes ?? null
    if (dailyBudget !== null && (!Number.isInteger(dailyBudget) || dailyBudget < 16_777_216)) {
      throw new Error('dailyBudgetBytes must be null or an integer >= 16777216 (16 MiB)')
    }

    this.db
      .prepare(
        `INSERT INTO backup_destinations (
          id, name, kind, target_path, max_bytes_per_second, daily_budget_bytes,
          encryption_mode, repository_id, is_enabled, last_verified_snapshot_id,
          last_verified_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.kind,
        input.targetPath,
        maxRate,
        dailyBudget,
        input.encryptionMode ?? 'none',
        input.isEnabled === false ? 0 : 1,
        now,
        now
      )

    const created = this.getDestination(id)
    if (!created) throw new Error(`Failed to load created backup destination ${id}`)
    return created
  }

  public getDestination(id: string): BackupDestinationRecord | null {
    const row = this.db.prepare('SELECT * FROM backup_destinations WHERE id = ?').get(id) as
      Record<string, unknown> | undefined
    return row ? mapDestinationRow(row) : null
  }

  public listDestinations(options?: { readonly enabledOnly?: boolean }): BackupDestinationRecord[] {
    const sql = options?.enabledOnly
      ? 'SELECT * FROM backup_destinations WHERE is_enabled = 1 ORDER BY updated_at_ms DESC, id ASC'
      : 'SELECT * FROM backup_destinations ORDER BY updated_at_ms DESC, id ASC'
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>
    return rows.map(mapDestinationRow)
  }

  public updateDestination(
    id: string,
    patch: UpdateBackupDestinationInput
  ): BackupDestinationRecord {
    const existing = this.getDestination(id)
    if (!existing) {
      throw new Error(`Backup destination "${id}" not found`)
    }
    const now = patch.nowMs ?? Date.now()
    const maxRate =
      patch.maxBytesPerSecond !== undefined ? patch.maxBytesPerSecond : existing.maxBytesPerSecond
    if (maxRate !== null && (!Number.isInteger(maxRate) || maxRate < 65_536)) {
      throw new Error('maxBytesPerSecond must be null or an integer >= 65536 (64 KiB/s)')
    }
    const dailyBudget =
      patch.dailyBudgetBytes !== undefined ? patch.dailyBudgetBytes : existing.dailyBudgetBytes
    if (dailyBudget !== null && (!Number.isInteger(dailyBudget) || dailyBudget < 16_777_216)) {
      throw new Error('dailyBudgetBytes must be null or an integer >= 16777216 (16 MiB)')
    }

    this.db
      .prepare(
        `UPDATE backup_destinations
         SET name = ?,
             target_path = ?,
             max_bytes_per_second = ?,
             daily_budget_bytes = ?,
             repository_id = ?,
             is_enabled = ?,
             last_verified_snapshot_id = ?,
             last_verified_at_ms = ?,
             updated_at_ms = ?
         WHERE id = ?`
      )
      .run(
        patch.name ?? existing.name,
        patch.targetPath !== undefined ? patch.targetPath : existing.targetPath,
        maxRate,
        dailyBudget,
        patch.repositoryId !== undefined ? patch.repositoryId : existing.repositoryId,
        patch.isEnabled !== undefined ? (patch.isEnabled ? 1 : 0) : existing.isEnabled ? 1 : 0,
        patch.lastVerifiedSnapshotId !== undefined
          ? patch.lastVerifiedSnapshotId
          : existing.lastVerifiedSnapshotId,
        patch.lastVerifiedAtMs !== undefined ? patch.lastVerifiedAtMs : existing.lastVerifiedAtMs,
        now,
        id
      )

    const updated = this.getDestination(id)
    if (!updated) throw new Error(`Failed to reload updated backup destination ${id}`)
    return updated
  }

  public deleteDestination(id: string): boolean {
    const res = this.db.prepare('DELETE FROM backup_destinations WHERE id = ?').run(id)
    return Number(res.changes) > 0
  }

  // ---------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------

  public createJob(input: CreateBackupJobInput): BackupJobRecord {
    const id = input.id ?? randomUUID()
    const now = input.createdAtMs ?? Date.now()
    this.db
      .prepare(
        `INSERT INTO backup_jobs (
          id, destination_id, snapshot_id, repository_id, status, pause_reason,
          staging_dir, abandoned_from_job_id, created_at_ms, started_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.destinationId,
        input.snapshotId,
        input.repositoryId ?? null,
        input.status,
        input.pauseReason ?? null,
        input.stagingDir ?? null,
        input.abandonedFromJobId ?? null,
        now,
        input.startedAtMs ?? null,
        now
      )

    const created = this.getJob(id)
    if (!created) throw new Error(`Failed to load created backup job ${id}`)
    return created
  }

  public getJob(id: string): BackupJobRecord | null {
    const row = this.db.prepare('SELECT * FROM backup_jobs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined
    return row ? mapJobRow(row) : null
  }

  public listJobs(options?: ListBackupJobsOptions): PaginatedBackupResult<BackupJobRecord> {
    const conditions: string[] = []
    const params: SQLInputValue[] = []
    if (options?.destinationId) {
      conditions.push('destination_id = ?')
      params.push(options.destinationId)
    }
    if (options?.status) {
      conditions.push('status = ?')
      params.push(options.status)
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM backup_jobs ${whereClause}`)
      .get(...params) as { cnt: number }

    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200)
    const offset = Math.max(options?.offset ?? 0, 0)
    const rows = this.db
      .prepare(
        `SELECT * FROM backup_jobs ${whereClause}
         ORDER BY created_at_ms DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>

    return {
      items: rows.map(mapJobRow),
      total: Number(totalRow.cnt),
      limit,
      offset
    }
  }

  public getResumableJobs(): BackupJobRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM backup_jobs
         WHERE status IN ('queued_destination_unavailable', 'paused', 'interrupted')
         ORDER BY created_at_ms ASC, id ASC`
      )
      .all() as Array<Record<string, unknown>>
    return rows.map(mapJobRow)
  }

  public markRunningJobsAsInterrupted(nowMs = Date.now()): number {
    return this.runInTransaction(() => {
      const res = this.db
        .prepare(
          `UPDATE backup_jobs
           SET status = 'interrupted', updated_at_ms = ?
           WHERE status IN ('capturing', 'running')`
        )
        .run(nowMs)
      this.db
        .prepare(
          `UPDATE backup_job_units
           SET status = 'pending', updated_at_ms = ?
           WHERE status = 'in_progress'
             AND job_id IN (SELECT id FROM backup_jobs WHERE status = 'interrupted')`
        )
        .run(nowMs)
      return Number(res.changes)
    })
  }

  public updateJobState(id: string, patch: UpdateBackupJobStateInput): BackupJobRecord {
    const existing = this.getJob(id)
    if (!existing) {
      throw new Error(`Backup job "${id}" not found`)
    }
    const now = patch.nowMs ?? Date.now()
    this.db
      .prepare(
        `UPDATE backup_jobs
         SET status = ?,
             pause_reason = ?,
             repository_id = ?,
             staging_dir = ?,
             verification_scope = ?,
             total_object_count = ?,
             completed_object_count = ?,
             written_chunk_count = ?,
             reused_chunk_count = ?,
             total_logical_bytes = ?,
             total_stored_bytes = ?,
             transferred_bytes = ?,
             manifest_sha256 = ?,
             error_code = ?,
             error_message = ?,
             started_at_ms = ?,
             updated_at_ms = ?,
             completed_at_ms = ?
         WHERE id = ?`
      )
      .run(
        patch.status ?? existing.status,
        patch.pauseReason !== undefined ? patch.pauseReason : existing.pauseReason,
        patch.repositoryId !== undefined ? patch.repositoryId : existing.repositoryId,
        patch.stagingDir !== undefined ? patch.stagingDir : existing.stagingDir,
        patch.verificationScope !== undefined
          ? patch.verificationScope
          : existing.verificationScope,
        patch.totalObjectCount ?? existing.totalObjectCount,
        patch.completedObjectCount ?? existing.completedObjectCount,
        patch.writtenChunkCount ?? existing.writtenChunkCount,
        patch.reusedChunkCount ?? existing.reusedChunkCount,
        patch.totalLogicalBytes ?? existing.totalLogicalBytes,
        patch.totalStoredBytes ?? existing.totalStoredBytes,
        patch.transferredBytes ?? existing.transferredBytes,
        patch.manifestSha256 !== undefined ? patch.manifestSha256 : existing.manifestSha256,
        patch.errorCode !== undefined ? patch.errorCode : existing.errorCode,
        patch.errorMessage !== undefined ? patch.errorMessage : existing.errorMessage,
        patch.startedAtMs !== undefined ? patch.startedAtMs : existing.startedAtMs,
        now,
        patch.completedAtMs !== undefined ? patch.completedAtMs : existing.completedAtMs,
        id
      )

    const updated = this.getJob(id)
    if (!updated) throw new Error(`Failed to reload updated backup job ${id}`)
    return updated
  }

  // ---------------------------------------------------------------------------
  // Job Units & Destination Object Cache
  // ---------------------------------------------------------------------------

  public upsertJobUnit(input: UpsertBackupJobUnitInput): BackupJobUnitRecord {
    const now = input.updatedAtMs ?? Date.now()
    this.db
      .prepare(
        `INSERT INTO backup_job_units (
          job_id, unit_kind, object_id, plaintext_sha256, plaintext_byte_size,
          stored_byte_size, status, retry_count, resume_session_uri,
          uploaded_offset_bytes, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (job_id, unit_kind, object_id) DO UPDATE SET
          plaintext_sha256 = COALESCE(excluded.plaintext_sha256, backup_job_units.plaintext_sha256),
          plaintext_byte_size = excluded.plaintext_byte_size,
          stored_byte_size = excluded.stored_byte_size,
          status = excluded.status,
          retry_count = excluded.retry_count,
          resume_session_uri = COALESCE(excluded.resume_session_uri, backup_job_units.resume_session_uri),
          uploaded_offset_bytes = excluded.uploaded_offset_bytes,
          updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        input.jobId,
        input.unitKind,
        input.objectId,
        input.plaintextSha256 ?? null,
        input.plaintextByteSize ?? 0,
        input.storedByteSize ?? 0,
        input.status,
        input.retryCount ?? 0,
        input.resumeSessionUri ?? null,
        input.uploadedOffsetBytes ?? 0,
        now
      )

    const row = this.db
      .prepare(
        'SELECT * FROM backup_job_units WHERE job_id = ? AND unit_kind = ? AND object_id = ?'
      )
      .get(input.jobId, input.unitKind, input.objectId) as Record<string, unknown> | undefined
    if (!row) {
      throw new Error(`Failed to load upserted backup job unit ${input.jobId}/${input.objectId}`)
    }
    return mapUnitRow(row)
  }

  public listJobUnits(jobId: string): BackupJobUnitRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM backup_job_units WHERE job_id = ? ORDER BY id ASC')
      .all(jobId) as Array<Record<string, unknown>>
    return rows.map(mapUnitRow)
  }

  public upsertDestinationObject(input: UpsertBackupDestinationObjectInput): void {
    const now = input.verifiedAtMs ?? Date.now()
    this.db
      .prepare(
        `INSERT INTO backup_destination_objects (
          destination_id, object_id, stored_byte_size, plaintext_sha256,
          verified_at_ms, last_snapshot_id
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (destination_id, object_id) DO UPDATE SET
          stored_byte_size = excluded.stored_byte_size,
          plaintext_sha256 = COALESCE(excluded.plaintext_sha256, backup_destination_objects.plaintext_sha256),
          verified_at_ms = excluded.verified_at_ms,
          last_snapshot_id = COALESCE(excluded.last_snapshot_id, backup_destination_objects.last_snapshot_id)`
      )
      .run(
        input.destinationId,
        input.objectId,
        input.storedByteSize,
        input.plaintextSha256 ?? null,
        now,
        input.lastSnapshotId ?? null
      )
  }

  public getDestinationObject(
    destinationId: string,
    objectId: string
  ): BackupDestinationObjectRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM backup_destination_objects WHERE destination_id = ? AND object_id = ?'
      )
      .get(destinationId, objectId) as Record<string, unknown> | undefined
    return row ? mapDestObjectRow(row) : null
  }

  public countDestinationObjects(destinationId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM backup_destination_objects WHERE destination_id = ?')
      .get(destinationId) as { cnt: number }
    return Number(row.cnt)
  }

  public hasCompletedJobForSnapshot(
    destinationId: string,
    snapshotId: string,
    excludeJobId: string
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS found FROM backup_jobs
         WHERE destination_id = ? AND snapshot_id = ? AND id != ? AND status = 'completed'
         LIMIT 1`
      )
      .get(destinationId, snapshotId, excludeJobId) as { found?: number } | undefined
    return row?.found === 1
  }

  public completeJobAndUpdateDestinationAtomically(input: {
    readonly jobId: string
    readonly destinationId: string
    readonly repositoryId: string
    readonly snapshotId: string
    readonly verificationScope: BackupVerificationScope
    readonly totalObjectCount: number
    readonly writtenChunkCount?: number
    readonly reusedChunkCount?: number
    readonly totalLogicalBytes: number
    readonly totalStoredBytes: number
    readonly manifestSha256: string
    readonly completedAtMs: number
  }): BackupJobRecord {
    return this.runInTransaction(() => {
      const existing = this.getJob(input.jobId)
      if (!existing) {
        throw new Error(`Backup job "${input.jobId}" not found`)
      }
      if (existing.status === 'completed') {
        return existing
      }

      const now = Date.now()
      this.db
        .prepare(
          `UPDATE backup_jobs
           SET status = 'completed',
               pause_reason = NULL,
               repository_id = ?,
               staging_dir = NULL,
               verification_scope = ?,
               total_object_count = ?,
               completed_object_count = ?,
               written_chunk_count = COALESCE(?, written_chunk_count),
               reused_chunk_count = COALESCE(?, reused_chunk_count),
               total_logical_bytes = ?,
               total_stored_bytes = ?,
               manifest_sha256 = ?,
               error_code = NULL,
               error_message = NULL,
               updated_at_ms = ?,
               completed_at_ms = ?
           WHERE id = ?`
        )
        .run(
          input.repositoryId,
          input.verificationScope,
          input.totalObjectCount,
          input.totalObjectCount,
          input.writtenChunkCount ?? null,
          input.reusedChunkCount ?? null,
          input.totalLogicalBytes,
          input.totalStoredBytes,
          input.manifestSha256,
          now,
          input.completedAtMs,
          input.jobId
        )

      this.db
        .prepare(
          `UPDATE backup_destinations
           SET repository_id = ?,
               last_verified_snapshot_id = ?,
               last_verified_at_ms = ?,
               updated_at_ms = ?
           WHERE id = ?`
        )
        .run(input.repositoryId, input.snapshotId, input.completedAtMs, now, input.destinationId)

      const updated = this.getJob(input.jobId)
      if (!updated) {
        throw new Error(`Failed to reload completed backup job "${input.jobId}"`)
      }
      return updated
    })
  }

  // ---------------------------------------------------------------------------
  // Bandwidth Ledger (Slice 3 readiness)
  // ---------------------------------------------------------------------------

  public recordBandwidthReservation(input: {
    readonly destinationId: string
    readonly jobId?: string | null
    readonly unitId?: number | null
    readonly bytesReserved: number
    readonly recordedAtMs?: number
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO backup_bandwidth_ledger (
          destination_id, job_id, unit_id, bytes_reserved, recorded_at_ms
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        input.destinationId,
        input.jobId ?? null,
        input.unitId ?? null,
        input.bytesReserved,
        input.recordedAtMs ?? Date.now()
      )
    return Number(res.lastInsertRowid)
  }

  public getRolling24hBandwidthBytes(destinationId: string, nowMs = Date.now()): number {
    const cutoff = nowMs - 86_400_000
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(bytes_reserved), 0) AS total_bytes
         FROM backup_bandwidth_ledger
         WHERE destination_id = ? AND recorded_at_ms > ?`
      )
      .get(destinationId, cutoff) as { total_bytes: number }
    return Number(row.total_bytes)
  }

  public tryReserveRollingBandwidth(input: {
    readonly destinationId: string
    readonly jobId?: string | null
    readonly unitId?: number | null
    readonly bytesToReserve: number
    readonly dailyBudgetBytes: number | null
    readonly nowMs?: number
  }): {
    readonly allowed: boolean
    readonly usedBytes: number
    readonly remainingBytes: number | null
  } {
    const nowMs = input.nowMs ?? Date.now()
    return this.runInTransaction(() => {
      const usedBytes = this.getRolling24hBandwidthBytes(input.destinationId, nowMs)
      if (
        input.dailyBudgetBytes !== null &&
        usedBytes + input.bytesToReserve > input.dailyBudgetBytes
      ) {
        return {
          allowed: false,
          usedBytes,
          remainingBytes: Math.max(0, input.dailyBudgetBytes - usedBytes)
        }
      }
      this.recordBandwidthReservation({
        destinationId: input.destinationId,
        jobId: input.jobId ?? null,
        unitId: input.unitId ?? null,
        bytesReserved: input.bytesToReserve,
        recordedAtMs: nowMs
      })
      const nextUsed = usedBytes + input.bytesToReserve
      return {
        allowed: true,
        usedBytes: nextUsed,
        remainingBytes:
          input.dailyBudgetBytes !== null ? Math.max(0, input.dailyBudgetBytes - nextUsed) : null
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Durable Google Drive Upload State (Slice 3)
  // ---------------------------------------------------------------------------

  public getDriveUploadState(
    destinationId: string,
    resourceKey: string
  ): {
    readonly destinationId: string
    readonly resourceKey: string
    readonly pregeneratedFileId: string
    readonly sessionUri: string | null
    readonly contentSha256: string | null
    readonly byteSize: number | null
    readonly jobId: string | null
    readonly updatedAtMs: number
  } | null {
    const row = this.db
      .prepare(
        `SELECT destination_id, resource_key, pregenerated_file_id, session_uri,
                content_sha256, byte_size, job_id, updated_at_ms
         FROM backup_drive_upload_state
         WHERE destination_id = ? AND resource_key = ?`
      )
      .get(destinationId, resourceKey) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      destinationId: String(row.destination_id),
      resourceKey: String(row.resource_key),
      pregeneratedFileId: String(row.pregenerated_file_id),
      sessionUri: row.session_uri !== null ? String(row.session_uri) : null,
      contentSha256: row.content_sha256 !== null ? String(row.content_sha256) : null,
      byteSize: row.byte_size !== null ? Number(row.byte_size) : null,
      jobId: row.job_id !== null ? String(row.job_id) : null,
      updatedAtMs: Number(row.updated_at_ms)
    }
  }

  public upsertDriveUploadState(input: {
    readonly destinationId: string
    readonly resourceKey: string
    readonly pregeneratedFileId: string
    readonly sessionUri?: string | null
    readonly contentSha256?: string | null
    readonly byteSize?: number | null
    readonly jobId?: string | null
    readonly updatedAtMs?: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO backup_drive_upload_state (
          destination_id, resource_key, pregenerated_file_id, session_uri,
          content_sha256, byte_size, job_id, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (destination_id, resource_key) DO UPDATE SET
          pregenerated_file_id = excluded.pregenerated_file_id,
          session_uri = excluded.session_uri,
          content_sha256 = excluded.content_sha256,
          byte_size = excluded.byte_size,
          job_id = COALESCE(excluded.job_id, backup_drive_upload_state.job_id),
          updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        input.destinationId,
        input.resourceKey,
        input.pregeneratedFileId,
        input.sessionUri ?? null,
        input.contentSha256 ?? null,
        input.byteSize ?? null,
        input.jobId ?? null,
        input.updatedAtMs ?? Date.now()
      )
  }

  public deleteDriveUploadState(destinationId: string, resourceKey: string): void {
    this.db
      .prepare(
        'DELETE FROM backup_drive_upload_state WHERE destination_id = ? AND resource_key = ?'
      )
      .run(destinationId, resourceKey)
  }
}
