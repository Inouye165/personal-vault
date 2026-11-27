/**
 * Personal Vault — Stage 8A Slice 2: Export Job History Repository (`ExportRepository`)
 *
 * Manages SQLite Migration 16 persistence (`export_jobs`, `export_job_items`):
 * - Records export job creation, privacy policy flags (defaulting to false/omitted),
 *   and per-item outcomes without storing raw source paths or extracted document text.
 * - Enforces the export core's single completion rule (`inspectExportBundleStatus`)
 *   before any history record can claim `status = 'completed'` or `bundleVerified = true`.
 * - Handles restart recovery (`markRunningJobsAsInterrupted`) for interrupted jobs and
 *   pending items, plus idempotent/duplicate outcome updates and bounded pagination.
 */

import { join } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import {
  ExportPrivacyOptionsSchema,
  type ExportByteSourceUsed,
  type ExportErrorCode,
  type ExportPrivacyOptions,
  type ExportVaultIntegrityWarning
} from '../../../shared/validation/export-schemas'
import { exportBundle, inspectExportBundleStatus } from '../export/bundle'
import type {
  ExportBundleIncompleteReason,
  ExportBundleInspectionResult,
  ExportBundleParams,
  ExportBundleResult,
  ExportItemOutcome,
  ExportTestHooks
} from '../export/types'

export type ExportJobStatus = 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed'
export type ExportJobItemStatus = 'pending' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface ExportJobRecord {
  readonly id: string
  readonly bundleDir: string
  readonly bundleFolderName: string
  readonly status: ExportJobStatus
  readonly privacyOptions: ExportPrivacyOptions
  readonly manifestPublished: boolean
  readonly bundleVerified: boolean
  readonly incompleteReasons: readonly ExportBundleIncompleteReason[]
  readonly totalItems: number
  readonly exportedItems: number
  readonly failedItems: number
  readonly cancelledItems: number
  readonly vaultIntegrityWarnings: number
  readonly errorCode: ExportErrorCode | null
  readonly errorMessage: string | null
  readonly startedAtMs: number
  readonly updatedAtMs: number
  readonly completedAtMs: number | null
}

export interface ExportJobItemRecord {
  readonly jobId: string
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly hashObservationId: number
  readonly category: 'photo' | 'document'
  readonly originalFileName: string
  readonly expectedSha256: string
  readonly expectedByteSize: number
  readonly status: ExportJobItemStatus
  readonly exportedFileName: string | null
  readonly sidecarFileName: string | null
  readonly byteSourceUsed: ExportByteSourceUsed | null
  readonly vaultIntegrityWarning: ExportVaultIntegrityWarning | null
  readonly errorCode: ExportErrorCode | null
  readonly errorMessage: string | null
  readonly updatedAtMs: number
}

export interface CreateExportJobItemInput {
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly hashObservationId: number
  readonly category: 'photo' | 'document'
  readonly originalFileName: string
  readonly expectedSha256: string
  readonly expectedByteSize: number
}

export interface CreateExportJobInput {
  readonly id: string
  readonly bundleDir: string
  readonly bundleFolderName: string
  readonly privacyOptions?: Partial<ExportPrivacyOptions>
  readonly items: readonly CreateExportJobItemInput[]
  readonly startedAtMs?: number
}

export interface RecordExportItemOutcomeInput {
  readonly jobId: string
  readonly outcome: ExportItemOutcome
  readonly updatedAtMs?: number
}

export interface FinalizeExportJobInput {
  readonly result: ExportBundleResult
  readonly completedAtMs?: number
  readonly inspectBundle?: (bundleDir: string) => ExportBundleInspectionResult
}

export interface ListExportJobsOptions {
  readonly limit?: number
  readonly offset?: number
  readonly status?: ExportJobStatus
}

export interface ListExportJobItemsOptions {
  readonly limit?: number
  readonly offset?: number
  readonly status?: ExportJobItemStatus
}

export interface PaginatedExportResult<T> {
  readonly items: readonly T[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

export interface ExportRepositoryOptions {
  readonly getDb: () => DatabaseSync
  readonly inspectBundle?: (bundleDir: string) => ExportBundleInspectionResult
}

interface RawExportJobRow {
  readonly id: string
  readonly bundle_dir: string
  readonly bundle_folder_name: string
  readonly status: ExportJobStatus
  readonly include_original_paths: number
  readonly include_extracted_text: number
  readonly manifest_published: number
  readonly bundle_verified: number
  readonly total_items: number
  readonly exported_items: number
  readonly failed_items: number
  readonly cancelled_items: number
  readonly vault_integrity_warnings: number
  readonly error_code: ExportErrorCode | null
  readonly error_message: string | null
  readonly incomplete_reasons_json: string | null
  readonly started_at_ms: number
  readonly updated_at_ms: number
  readonly completed_at_ms: number | null
}

interface RawExportJobItemRow {
  readonly job_id: string
  readonly file_location_id: number
  readonly discovery_observation_id: number
  readonly hash_observation_id: number
  readonly category: 'photo' | 'document'
  readonly original_file_name: string
  readonly expected_sha256: string
  readonly expected_byte_size: number
  readonly status: ExportJobItemStatus
  readonly exported_file_name: string | null
  readonly sidecar_file_name: string | null
  readonly byte_source_used: ExportByteSourceUsed | null
  readonly vault_integrity_warning: ExportVaultIntegrityWarning | null
  readonly error_code: ExportErrorCode | null
  readonly error_message: string | null
  readonly updated_at_ms: number
}

interface RecomputedJobCounts {
  readonly exportedItems: number
  readonly failedItems: number
  readonly cancelledItems: number
  readonly vaultIntegrityWarnings: number
}

const DEFAULT_EXPORT_HISTORY_LIMIT = 50
const MAX_EXPORT_HISTORY_LIMIT = 500

function validatePagination(options?: { limit?: number; offset?: number }): {
  limit: number
  offset: number
} {
  const limit = options?.limit ?? DEFAULT_EXPORT_HISTORY_LIMIT
  const offset = options?.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXPORT_HISTORY_LIMIT) {
    throw new RangeError(
      `Invalid limit ${limit}; expected integer between 1 and ${MAX_EXPORT_HISTORY_LIMIT}`
    )
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`Invalid offset ${offset}; expected non-negative integer`)
  }
  return { limit, offset }
}

function parseIncompleteReasons(raw: string | null): readonly ExportBundleIncompleteReason[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is ExportBundleIncompleteReason => typeof item === 'string')
  } catch {
    return []
  }
}

function mapExportJobRow(row: RawExportJobRow): ExportJobRecord {
  return {
    id: row.id,
    bundleDir: row.bundle_dir,
    bundleFolderName: row.bundle_folder_name,
    status: row.status,
    privacyOptions: {
      includeOriginalPaths: row.include_original_paths === 1,
      includeExtractedText: row.include_extracted_text === 1
    },
    manifestPublished: row.manifest_published === 1,
    bundleVerified: row.bundle_verified === 1,
    incompleteReasons: parseIncompleteReasons(row.incomplete_reasons_json),
    totalItems: row.total_items,
    exportedItems: row.exported_items,
    failedItems: row.failed_items,
    cancelledItems: row.cancelled_items,
    vaultIntegrityWarnings: row.vault_integrity_warnings,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAtMs: row.started_at_ms,
    updatedAtMs: row.updated_at_ms,
    completedAtMs: row.completed_at_ms
  }
}

function mapExportJobItemRow(row: RawExportJobItemRow): ExportJobItemRecord {
  return {
    jobId: row.job_id,
    fileLocationId: row.file_location_id,
    discoveryObservationId: row.discovery_observation_id,
    hashObservationId: row.hash_observation_id,
    category: row.category,
    originalFileName: row.original_file_name,
    expectedSha256: row.expected_sha256,
    expectedByteSize: row.expected_byte_size,
    status: row.status,
    exportedFileName: row.exported_file_name,
    sidecarFileName: row.sidecar_file_name,
    byteSourceUsed: row.byte_source_used,
    vaultIntegrityWarning: row.vault_integrity_warning,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    updatedAtMs: row.updated_at_ms
  }
}

function runInImmediateTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;')
  try {
    const result = fn()
    db.exec('COMMIT;')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK;')
    } catch {
      // Ignore rollback failure
    }
    throw err
  }
}

function recomputeCountsForJob(db: DatabaseSync, jobId: string): RecomputedJobCounts {
  const row = db
    .prepare(
      `
      SELECT
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS exported_items,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_items,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_items,
        COALESCE(SUM(CASE WHEN vault_integrity_warning IS NOT NULL THEN 1 ELSE 0 END), 0) AS vault_integrity_warnings
      FROM export_job_items
      WHERE job_id = ?;
    `
    )
    .get(jobId) as
    | {
        exported_items: number
        failed_items: number
        cancelled_items: number
        vault_integrity_warnings: number
      }
    | undefined

  return {
    exportedItems: Number(row?.exported_items ?? 0),
    failedItems: Number(row?.failed_items ?? 0),
    cancelledItems: Number(row?.cancelled_items ?? 0),
    vaultIntegrityWarnings: Number(row?.vault_integrity_warnings ?? 0)
  }
}

function applyItemOutcomeInTx(
  db: DatabaseSync,
  jobId: string,
  outcome: ExportItemOutcome,
  updatedAtMs: number
): void {
  const res = db
    .prepare(
      `
      UPDATE export_job_items
      SET status = ?,
          exported_file_name = ?,
          sidecar_file_name = ?,
          byte_source_used = ?,
          vault_integrity_warning = ?,
          error_code = ?,
          error_message = ?,
          updated_at_ms = ?
      WHERE job_id = ? AND file_location_id = ?;
    `
    )
    .run(
      outcome.status,
      outcome.exportedFileName,
      outcome.sidecarFileName,
      outcome.byteSourceUsed,
      outcome.vaultIntegrityWarning,
      outcome.errorCode,
      outcome.errorMessage,
      updatedAtMs,
      jobId,
      outcome.fileLocationId
    )
  if (Number(res.changes) === 0) {
    throw new Error(
      `Export job item not found for jobId=${jobId}, fileLocationId=${outcome.fileLocationId}`
    )
  }
}

function assertJobRunningInTx(db: DatabaseSync, jobId: string): void {
  const row = db.prepare('SELECT status FROM export_jobs WHERE id = ?;').get(jobId) as
    { status: ExportJobStatus } | undefined
  if (!row) {
    throw new Error(`Export job not found: ${jobId}`)
  }
  if (row.status !== 'running') {
    throw new Error(`Cannot modify terminal export job ${jobId} (status=${row.status})`)
  }
}

export class ExportRepository {
  private readonly getDb: () => DatabaseSync
  private readonly defaultInspectBundle: (bundleDir: string) => ExportBundleInspectionResult

  public constructor(options: ExportRepositoryOptions) {
    this.getDb = options.getDb
    this.defaultInspectBundle = options.inspectBundle ?? inspectExportBundleStatus
  }

  /**
   * Creates a new `running` export job and its `pending` item records atomically.
   * Enforces privacy defaults (`includeOriginalPaths: false`, `includeExtractedText: false`).
   */
  public createExportJob(input: CreateExportJobInput): ExportJobRecord {
    const db = this.getDb()
    const privacyOptions = ExportPrivacyOptionsSchema.parse(input.privacyOptions ?? {})
    const startedAtMs = input.startedAtMs ?? Date.now()

    const seenLocationIds = new Set<number>()
    for (const item of input.items) {
      if (seenLocationIds.has(item.fileLocationId)) {
        throw new Error(`Duplicate fileLocationId ${item.fileLocationId} in export job ${input.id}`)
      }
      seenLocationIds.add(item.fileLocationId)
    }

    runInImmediateTx(db, () => {
      db.prepare(
        `
        INSERT INTO export_jobs (
          id,
          bundle_dir,
          bundle_folder_name,
          status,
          include_original_paths,
          include_extracted_text,
          manifest_published,
          bundle_verified,
          total_items,
          exported_items,
          failed_items,
          cancelled_items,
          vault_integrity_warnings,
          error_code,
          error_message,
          incomplete_reasons_json,
          started_at_ms,
          updated_at_ms,
          completed_at_ms
        ) VALUES (?, ?, ?, 'running', ?, ?, 0, 0, ?, 0, 0, 0, 0, NULL, NULL, NULL, ?, ?, NULL);
      `
      ).run(
        input.id,
        input.bundleDir,
        input.bundleFolderName,
        privacyOptions.includeOriginalPaths ? 1 : 0,
        privacyOptions.includeExtractedText ? 1 : 0,
        input.items.length,
        startedAtMs,
        startedAtMs
      )

      const itemStmt = db.prepare(
        `
        INSERT INTO export_job_items (
          job_id,
          file_location_id,
          discovery_observation_id,
          hash_observation_id,
          category,
          original_file_name,
          expected_sha256,
          expected_byte_size,
          status,
          exported_file_name,
          sidecar_file_name,
          byte_source_used,
          vault_integrity_warning,
          error_code,
          error_message,
          updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, ?);
      `
      )

      for (const item of input.items) {
        itemStmt.run(
          input.id,
          item.fileLocationId,
          item.discoveryObservationId,
          item.hashObservationId,
          item.category,
          item.originalFileName,
          item.expectedSha256,
          item.expectedByteSize,
          startedAtMs
        )
      }
    })

    const created = this.getExportJob(input.id)
    if (!created) {
      throw new Error(`Failed to create export job ${input.id}`)
    }
    return created
  }

  /**
   * Idempotently records a single item's outcome and recomputes job aggregate counts
   * from `export_job_items` so duplicate or retried updates never drift.
   */
  public recordExportItemOutcome(input: RecordExportItemOutcomeInput): void {
    const db = this.getDb()
    const updatedAtMs = input.updatedAtMs ?? Date.now()

    runInImmediateTx(db, () => {
      assertJobRunningInTx(db, input.jobId)
      applyItemOutcomeInTx(db, input.jobId, input.outcome, updatedAtMs)
      const counts = recomputeCountsForJob(db, input.jobId)
      db.prepare(
        `
        UPDATE export_jobs
        SET exported_items = ?,
            failed_items = ?,
            cancelled_items = ?,
            vault_integrity_warnings = ?,
            updated_at_ms = ?
        WHERE id = ?;
      `
      ).run(
        counts.exportedItems,
        counts.failedItems,
        counts.cancelledItems,
        counts.vaultIntegrityWarnings,
        updatedAtMs,
        input.jobId
      )
    })
  }

  /**
   * Finalizes an export job after `exportBundle` finishes.
   * Always runs the export core's completion check (`inspectExportBundleStatus`).
   * Never records `status = 'completed'` or `bundleVerified = true` if verification fails.
   */
  public finalizeExportJob(input: FinalizeExportJobInput): ExportJobRecord {
    const db = this.getDb()
    const { result } = input
    const completedAtMs = input.completedAtMs ?? Date.now()
    const inspectBundle = input.inspectBundle ?? this.defaultInspectBundle
    const inspection = inspectBundle(result.bundleDir)

    const bundleVerified = inspection.isCompleteVerified
    let finalStatus: ExportJobStatus = result.status
    let errorCode: ExportErrorCode | null = result.errorCode
    let errorMessage: string | null = result.errorMessage

    if (!bundleVerified && finalStatus === 'completed') {
      finalStatus = 'failed'
      errorCode = errorCode ?? 'manifest_write_failed'
      errorMessage =
        errorMessage ??
        `Export bundle completion verification failed: ${inspection.reasons.join(', ')}`
    }

    const incompleteReasonsJson =
      inspection.reasons.length > 0 ? JSON.stringify(inspection.reasons) : null

    runInImmediateTx(db, () => {
      assertJobRunningInTx(db, result.exportJobId)

      for (const outcome of result.itemOutcomes) {
        applyItemOutcomeInTx(db, result.exportJobId, outcome, completedAtMs)
      }

      const counts = recomputeCountsForJob(db, result.exportJobId)
      db.prepare(
        `
        UPDATE export_jobs
        SET status = ?,
            manifest_published = ?,
            bundle_verified = ?,
            exported_items = ?,
            failed_items = ?,
            cancelled_items = ?,
            vault_integrity_warnings = ?,
            error_code = ?,
            error_message = ?,
            incomplete_reasons_json = ?,
            updated_at_ms = ?,
            completed_at_ms = ?
        WHERE id = ?;
      `
      ).run(
        finalStatus,
        result.manifestPublished ? 1 : 0,
        bundleVerified ? 1 : 0,
        counts.exportedItems,
        counts.failedItems,
        counts.cancelledItems,
        counts.vaultIntegrityWarnings,
        errorCode,
        errorMessage,
        incompleteReasonsJson,
        completedAtMs,
        completedAtMs,
        result.exportJobId
      )
    })

    const updated = this.getExportJob(result.exportJobId)
    if (!updated) {
      throw new Error(`Export job disappeared after finalization: ${result.exportJobId}`)
    }
    return updated
  }

  /**
   * Transitions any `running` export jobs to `interrupted` on startup/restart,
   * marks any remaining `pending` items as `interrupted`, and inspects each bundle
   * directory on disk so history accurately reflects incomplete bundle artifacts.
   * Idempotent: repeated calls when no jobs are `running` return 0.
   */
  public markRunningJobsAsInterrupted(nowMs: number = Date.now()): number {
    const db = this.getDb()

    return runInImmediateTx(db, () => {
      const runningRows = db
        .prepare("SELECT id, bundle_dir, error_message FROM export_jobs WHERE status = 'running';")
        .all() as Array<{ id: string; bundle_dir: string; error_message: string | null }>

      if (runningRows.length === 0) {
        return 0
      }

      const updateJobStmt = db.prepare(
        `
        UPDATE export_jobs
        SET status = 'interrupted',
            bundle_verified = 0,
            incomplete_reasons_json = ?,
            error_message = ?,
            updated_at_ms = ?,
            completed_at_ms = NULL
        WHERE id = ? AND status = 'running';
      `
      )

      const updatePendingItemsStmt = db.prepare(
        `
        UPDATE export_job_items
        SET status = 'interrupted',
            updated_at_ms = ?
        WHERE job_id = ? AND status = 'pending';
      `
      )

      for (const row of runningRows) {
        const inspection = this.defaultInspectBundle(row.bundle_dir)
        const reasonsJson =
          inspection.reasons.length > 0 ? JSON.stringify(inspection.reasons) : null
        const message =
          row.error_message ?? 'Export was interrupted before completion (application restarted).'
        updateJobStmt.run(reasonsJson, message, nowMs, row.id)
        updatePendingItemsStmt.run(nowMs, row.id)
      }

      return runningRows.length
    })
  }

  /**
   * Re-verifies a recorded export job's bundle directory on disk against the export
   * core's completion check. If a previously `completed` record no longer passes
   * verification, it is downgraded to `failed` with `bundleVerified = false`.
   */
  public verifyExportJobBundleOnDisk(
    jobId: string,
    nowMs: number = Date.now()
  ): ExportJobRecord | null {
    const db = this.getDb()
    const existing = this.getExportJob(jobId)
    if (!existing) return null

    const inspection = this.defaultInspectBundle(existing.bundleDir)
    const bundleVerified = inspection.isCompleteVerified
    const reasonsJson = inspection.reasons.length > 0 ? JSON.stringify(inspection.reasons) : null

    let nextStatus = existing.status
    let nextErrorCode = existing.errorCode
    let nextErrorMessage = existing.errorMessage
    if (!bundleVerified && nextStatus === 'completed') {
      nextStatus = 'failed'
      nextErrorCode = nextErrorCode ?? 'manifest_write_failed'
      nextErrorMessage =
        nextErrorMessage ??
        `Export bundle completion verification failed: ${inspection.reasons.join(', ')}`
    }

    runInImmediateTx(db, () => {
      db.prepare(
        `
        UPDATE export_jobs
        SET status = ?,
            bundle_verified = ?,
            incomplete_reasons_json = ?,
            error_code = ?,
            error_message = ?,
            updated_at_ms = ?
        WHERE id = ?;
      `
      ).run(
        nextStatus,
        bundleVerified ? 1 : 0,
        reasonsJson,
        nextErrorCode,
        nextErrorMessage,
        nowMs,
        jobId
      )
    })

    return this.getExportJob(jobId)
  }

  /**
   * Executes `exportBundle` while persisting initial `running` state and finalizing
   * the history record with completion verification.
   */
  public async runExportWithHistory(
    params: ExportBundleParams,
    options?: {
      readonly hooks?: ExportTestHooks
      readonly inspectBundle?: (bundleDir: string) => ExportBundleInspectionResult
    }
  ): Promise<{ readonly result: ExportBundleResult; readonly job: ExportJobRecord }> {
    const bundleDir = join(params.parentDir, params.bundleFolderName)
    this.createExportJob({
      id: params.exportJobId,
      bundleDir,
      bundleFolderName: params.bundleFolderName,
      privacyOptions: params.privacyOptions,
      items: params.items.map((item) => ({
        fileLocationId: item.fileLocationId,
        discoveryObservationId: item.discoveryObservationId,
        hashObservationId: item.hashObservationId,
        category: item.category,
        originalFileName: item.fileName,
        expectedSha256: item.expectedSha256,
        expectedByteSize: item.recordedFacts.byteSize
      }))
    })

    try {
      const result = await exportBundle(params, options?.hooks)
      const job = this.finalizeExportJob({
        result,
        inspectBundle: options?.inspectBundle
      })
      return { result, job }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Export failed unexpectedly'
      this.failRunningExportJob({
        jobId: params.exportJobId,
        bundleDir,
        errorMessage: message,
        inspectBundle: options?.inspectBundle
      })
      throw err
    }
  }

  /**
   * Transitions a still-`running` export job to `failed`, marks `pending` items `failed`,
   * preserves any already-recorded item outcomes, and recomputes job counters atomically.
   * No-ops if the job is missing or already in a terminal state.
   */
  public failRunningExportJob(input: {
    readonly jobId: string
    readonly bundleDir: string
    readonly errorMessage: string
    readonly failedAtMs?: number
    readonly inspectBundle?: (bundleDir: string) => ExportBundleInspectionResult
  }): void {
    const failedAtMs = input.failedAtMs ?? Date.now()
    const inspectBundle = input.inspectBundle ?? this.defaultInspectBundle
    const inspection = inspectBundle(input.bundleDir)
    const reasonsJson = inspection.reasons.length > 0 ? JSON.stringify(inspection.reasons) : null

    const db = this.getDb()
    runInImmediateTx(db, () => {
      const current = db
        .prepare('SELECT status FROM export_jobs WHERE id = ?;')
        .get(input.jobId) as { status: ExportJobStatus } | undefined
      if (!current || current.status !== 'running') {
        return
      }

      db.prepare(
        `
        UPDATE export_job_items
        SET status = 'failed',
            error_message = ?,
            updated_at_ms = ?
        WHERE job_id = ? AND status = 'pending';
      `
      ).run(input.errorMessage, failedAtMs, input.jobId)

      const counts = recomputeCountsForJob(db, input.jobId)

      db.prepare(
        `
        UPDATE export_jobs
        SET status = 'failed',
            manifest_published = 0,
            bundle_verified = 0,
            exported_items = ?,
            failed_items = ?,
            cancelled_items = ?,
            vault_integrity_warnings = ?,
            incomplete_reasons_json = ?,
            error_message = ?,
            updated_at_ms = ?,
            completed_at_ms = ?
        WHERE id = ?;
      `
      ).run(
        counts.exportedItems,
        counts.failedItems,
        counts.cancelledItems,
        counts.vaultIntegrityWarnings,
        reasonsJson,
        input.errorMessage,
        failedAtMs,
        failedAtMs,
        input.jobId
      )
    })
  }

  public getExportJob(jobId: string): ExportJobRecord | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM export_jobs WHERE id = ?;').get(jobId) as unknown as
      RawExportJobRow | undefined
    return row ? mapExportJobRow(row) : null
  }

  public listExportJobs(options?: ListExportJobsOptions): PaginatedExportResult<ExportJobRecord> {
    const db = this.getDb()
    const { limit, offset } = validatePagination(options)
    const whereClauses: string[] = []
    const params: SQLInputValue[] = []

    if (options?.status !== undefined) {
      whereClauses.push('status = ?')
      params.push(options.status)
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM export_jobs ${whereSql};`)
      .get(...params) as { cnt: number } | undefined

    const rows = db
      .prepare(
        `
        SELECT *
        FROM export_jobs
        ${whereSql}
        ORDER BY started_at_ms DESC, id DESC
        LIMIT ? OFFSET ?;
      `
      )
      .all(...params, limit, offset) as unknown as RawExportJobRow[]

    return {
      items: rows.map(mapExportJobRow),
      total: Number(totalRow?.cnt ?? 0),
      limit,
      offset
    }
  }

  public getExportJobItems(
    jobId: string,
    options?: ListExportJobItemsOptions
  ): PaginatedExportResult<ExportJobItemRecord> {
    const db = this.getDb()
    const { limit, offset } = validatePagination(options)
    const whereClauses: string[] = ['job_id = ?']
    const params: SQLInputValue[] = [jobId]

    if (options?.status !== undefined) {
      whereClauses.push('status = ?')
      params.push(options.status)
    }

    const whereSql = `WHERE ${whereClauses.join(' AND ')}`
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM export_job_items ${whereSql};`)
      .get(...params) as { cnt: number } | undefined

    const rows = db
      .prepare(
        `
        SELECT *
        FROM export_job_items
        ${whereSql}
        ORDER BY file_location_id ASC
        LIMIT ? OFFSET ?;
      `
      )
      .all(...params, limit, offset) as unknown as RawExportJobItemRow[]

    return {
      items: rows.map(mapExportJobItemRow),
      total: Number(totalRow?.cnt ?? 0),
      limit,
      offset
    }
  }
}
