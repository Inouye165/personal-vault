/**
 * Personal Vault — Stage 7E Slice 2: Document Classification Repository (`DocumentClassificationRepository`)
 *
 * Manages:
 * - Migration 15 persistence (`document_classifications`, `document_classification_labels`,
 *   `document_classification_overrides`, `document_classification_jobs`, `document_classification_job_items`)
 * - Full provenance & compatibility checks across source observation, relative path,
 *   native/OCR extraction identity, `normalized_input_sha256`, and `rule_version`
 * - Atomic `BEGIN IMMEDIATE` `REVISION_MISMATCH` stale-commit rejection
 * - Stale classification invalidation (stale rows never hide documents)
 * - Durable two-phase `AnnotationJournal` (`kind: 'document_classification_override'`)
 *   user overrides with `STALE_REVISION` / `STALE_OVERRIDE_VERSION` conflict guards,
 *   timestamp-touch preservation, and content-change invalidation
 * - Off-main `document_snapshot_worker` (`kind: 'doc_classify'`) 250-row batched scope snapshots,
 *   incomplete-snapshot cleanup, and startup `interrupted` recovery.
 */

import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import type {
  ClassificationConfidenceBand,
  DocumentClassificationEvidence,
  DocumentClassificationResult,
  DocumentClassificationTextSource,
  DocumentClutterOverride,
  DocumentEffectiveClassificationSummary,
  DocumentOriginLabel,
  DocumentOriginStatus,
  DocumentPurposeLabel,
  DocumentPurposeStatus,
  GetDocumentClassificationFacetsResponseDto,
  UncertaintyReason
} from '../../../shared/validation/document-schemas'
import type { AnnotationJournal } from '../annotations/journal'
import { DETERMINISTIC_RULE_VERSION } from '../documents/classification/rules'
import { AppWorkerBudget, type WorkerBudgetReservation } from '../worker-budget'
import { resolveMainWorkerScriptPath } from '../worker-path'
import {
  DOCUMENT_CLASSIFICATION_CANDIDATE_SELECT,
  EFFECTIVE_CLASSIFICATION_JOIN_SQL,
  EFFECTIVE_CLUTTER_SQL_EXPR,
  isDocumentClassificationRowCompatible,
  resolveClassificationInputTrack,
  type DocClassificationJobScopeKind,
  type DocClassificationSnapshotItem,
  type DocumentClassificationCandidateRow,
  type ResolvedClassificationInputTrack
} from './document-classification-snapshot-query'
import { buildDocumentContentRevision, buildDocumentFilterSql } from './document-snapshot-query'

export type DocClassificationJobStatus =
  'running' | 'paused' | 'completed' | 'cancelled' | 'interrupted' | 'failed'

export type DocClassificationJobItemStatus =
  'pending' | 'classified' | 'other' | 'unknown' | 'reused' | 'skipped_stale' | 'failed'

export interface DocClassificationCoverage {
  readonly totalDocuments: number
  readonly classifiedDocuments: number
  readonly otherDocuments: number
  readonly unknownDocuments: number
  readonly unclassifiedDocuments: number
  readonly staleDocuments: number
  readonly hiddenClutterCount: number
  readonly overriddenDocuments: number
}

export const EMPTY_DOC_CLASSIFICATION_COVERAGE: DocClassificationCoverage = {
  totalDocuments: 0,
  classifiedDocuments: 0,
  otherDocuments: 0,
  unknownDocuments: 0,
  unclassifiedDocuments: 0,
  staleDocuments: 0,
  hiddenClutterCount: 0,
  overriddenDocuments: 0
}

export interface DocClassificationJobRecord {
  readonly id: string
  readonly scopeKind: DocClassificationJobScopeKind
  readonly status: DocClassificationJobStatus
  readonly ruleVersion: string
  readonly filterExtension: string | null
  readonly filterFilenameQuery: string | null
  readonly forceReclassify: boolean
  readonly snapshotComplete: boolean
  readonly totalItems: number
  readonly processedItems: number
  readonly classifiedItems: number
  readonly otherItems: number
  readonly unknownItems: number
  readonly clutterItems: number
  readonly reusedItems: number
  readonly skippedStaleItems: number
  readonly failedItems: number
  readonly startedAtMs: number
  readonly updatedAtMs: number
  readonly completedAtMs: number | null
  readonly lastError: string | null
}

export interface DocClassificationPendingItem {
  readonly jobId: string
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly contentRevision: string
  readonly nativeExtractionId: number | null
  readonly ocrExtractionId: number | null
  readonly normalizedInputSha256: string
}

export interface DocClassificationOverrideRecord {
  readonly id: number
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly contentSha256: string
  readonly contentRevision: string
  readonly purposeLabels: readonly DocumentPurposeLabel[] | null
  readonly originLabels: readonly DocumentOriginLabel[] | null
  readonly clutterOverride: DocumentClutterOverride
  readonly overrideVersion: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly persistencePending?: boolean
  readonly persistenceError?: string
}

export interface EffectiveDocumentClassification {
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly contentRevision: string
  readonly isClassified: boolean
  readonly isStale: boolean
  readonly machineRuleVersion: string | null
  readonly machineTextSourceKind: DocumentClassificationTextSource | null
  readonly machinePurposeStatus: DocumentPurposeStatus
  readonly machineOriginStatus: DocumentOriginStatus
  readonly machinePurposeLabels: readonly DocumentPurposeLabel[]
  readonly machineOriginLabels: readonly DocumentOriginLabel[]
  readonly confidenceBand: ClassificationConfidenceBand
  readonly uncertaintyReason: UncertaintyReason | null
  readonly uncertaintyReasons: readonly UncertaintyReason[]
  readonly isClutterCandidate: boolean
  readonly hasPersonalVeto: boolean
  readonly evidence: readonly DocumentClassificationEvidence[]
  readonly override: DocClassificationOverrideRecord | null
  readonly hasStaleOverride: boolean
  readonly hasUnverifiedOverride: boolean
  readonly latestOverrideVersion: number
  readonly effectivePurposeLabels: readonly DocumentPurposeLabel[]
  readonly effectiveOriginLabels: readonly DocumentOriginLabel[]
  readonly effectivePurposeStatus: DocumentPurposeStatus
  readonly effectiveOriginStatus: DocumentOriginStatus
  readonly effectiveIsClutter: boolean
}

export interface CommitDocClassificationParams {
  readonly fileLocationId: number
  readonly expectedDiscoveryObservationId: number
  readonly expectedContentRevision: string
  readonly expectedNativeExtractionId: number | null
  readonly expectedOcrExtractionId: number | null
  readonly expectedNormalizedInputSha256: string
  readonly sourceRootPath: string
  readonly resolved: ResolvedClassificationInputTrack
  readonly row: DocumentClassificationCandidateRow
  readonly result: DocumentClassificationResult
}

export interface SetClassificationOverrideParams {
  readonly fileLocationId: number
  readonly expectedRevision: string
  readonly expectedOverrideVersion: number
  readonly purposeLabels: readonly DocumentPurposeLabel[] | null
  readonly originLabels: readonly DocumentOriginLabel[] | null
  readonly clutterOverride: DocumentClutterOverride
}

export interface DocumentClassificationRepositoryOptions {
  readonly getDb: () => DatabaseSync
  readonly getCatalogPath: () => string
  readonly getJournal?: () => AnnotationJournal | undefined
  readonly onClassificationMutation?: () => void
}

const MAX_EVIDENCE_JSON_BYTES = 8192

function serializeBoundedEvidence(evidence: readonly DocumentClassificationEvidence[]): string {
  const full = JSON.stringify(evidence)
  if (Buffer.byteLength(full, 'utf8') <= MAX_EVIDENCE_JSON_BYTES) {
    return full
  }
  const trimmed: DocumentClassificationEvidence[] = []
  for (const item of evidence) {
    const candidate = JSON.stringify([...trimmed, item])
    if (Buffer.byteLength(candidate, 'utf8') > MAX_EVIDENCE_JSON_BYTES) break
    trimmed.push(item)
  }
  return JSON.stringify(trimmed)
}

export class DocumentClassificationRepository {
  private readonly getDb: () => DatabaseSync
  private readonly getCatalogPath: () => string
  private readonly getJournal?: () => AnnotationJournal | undefined
  private readonly onClassificationMutation?: () => void
  private readonly inFlightSnapshotJobIds = new Set<string>()

  public constructor(options: DocumentClassificationRepositoryOptions) {
    this.getDb = options.getDb
    this.getCatalogPath = options.getCatalogPath
    this.getJournal = options.getJournal
    this.onClassificationMutation = options.onClassificationMutation
  }

  public getCandidateForLocation(fileLocationId: number): {
    readonly row: DocumentClassificationCandidateRow
    readonly resolved: ResolvedClassificationInputTrack
    readonly isCompatible: boolean
  } | null {
    const db = this.getDb()
    const row = db
      .prepare(
        `
        ${DOCUMENT_CLASSIFICATION_CANDIDATE_SELECT}
        WHERE f.id = ? AND f.category = 'document';
      `
      )
      .get(fileLocationId) as unknown as DocumentClassificationCandidateRow | undefined

    if (!row) return null
    const resolved = resolveClassificationInputTrack(row)
    const isCompatible = isDocumentClassificationRowCompatible(
      row,
      resolved,
      DETERMINISTIC_RULE_VERSION
    )
    return { row, resolved, isCompatible }
  }

  public commitClassificationResult(params: CommitDocClassificationParams): {
    readonly status: 'committed' | 'revision_mismatch'
    readonly classificationId?: number
  } {
    const db = this.getDb()
    const now = Date.now()

    db.exec('BEGIN IMMEDIATE;')
    try {
      const live = this.getCandidateForLocation(params.fileLocationId)
      if (!live) {
        db.exec('ROLLBACK;')
        return { status: 'revision_mismatch' }
      }

      if (
        live.row.discovery_observation_id !== params.expectedDiscoveryObservationId ||
        live.resolved.contentRevision !== params.expectedContentRevision ||
        live.resolved.nativeExtractionId !== params.expectedNativeExtractionId ||
        live.resolved.ocrExtractionId !== params.expectedOcrExtractionId ||
        live.resolved.normalizedInputSha256 !== params.expectedNormalizedInputSha256
      ) {
        db.exec('ROLLBACK;')
        return { status: 'revision_mismatch' }
      }

      db.prepare(
        'UPDATE document_classifications SET is_current = 0 WHERE file_location_id = ? AND is_current = 1;'
      ).run(params.fileLocationId)

      const insertRes = db
        .prepare(
          `
          INSERT INTO document_classifications (
            file_location_id,
            discovery_observation_id,
            content_sha256,
            observed_byte_size,
            observed_mtime_ms,
            content_revision,
            source_root_path,
            relative_path,
            native_extraction_id,
            native_recipe_version,
            ocr_extraction_id,
            ocr_recipe_version,
            ocr_model_id,
            ocr_model_manifest_sha256,
            ocr_language,
            text_source_kind,
            normalized_input_sha256,
            classifier_kind,
            rule_version,
            purpose_status,
            origin_status,
            confidence_band,
            uncertainty_reason,
            uncertainty_reasons_json,
            total_normalized_chars,
            inspected_head_chars,
            inspected_tail_chars,
            omitted_chars,
            upstream_truncated,
            unclosed_fence_at_eof,
            is_clutter_candidate,
            has_personal_veto,
            evidence_json,
            is_current,
            created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?);
        `
        )
        .run(
          params.fileLocationId,
          live.row.discovery_observation_id,
          live.row.active_hash ?? '',
          live.row.byte_size,
          live.row.filesystem_mtime_ms,
          live.resolved.contentRevision,
          params.sourceRootPath,
          live.resolved.relativePath,
          live.resolved.nativeExtractionId,
          live.resolved.nativeRecipeVersion,
          live.resolved.ocrExtractionId,
          live.resolved.ocrRecipeVersion,
          live.resolved.ocrModelId,
          live.resolved.ocrModelManifestSha256,
          live.resolved.ocrLanguage,
          params.result.textSourceKind,
          live.resolved.normalizedInputSha256,
          params.result.classifierKind,
          params.result.ruleVersion,
          params.result.purposeStatus,
          params.result.originStatus,
          params.result.confidenceBand,
          params.result.uncertaintyReason,
          JSON.stringify(params.result.uncertaintyReasons),
          params.result.totalNormalizedChars,
          params.result.inspectedHeadChars,
          params.result.inspectedTailChars,
          params.result.omittedChars,
          live.resolved.nativeTruncated || live.resolved.ocrTruncated ? 1 : 0,
          params.result.unclosedFenceAtEof ? 1 : 0,
          params.result.isClutterCandidate ? 1 : 0,
          params.result.hasPersonalVeto ? 1 : 0,
          serializeBoundedEvidence(params.result.evidence),
          now
        )

      const classificationId = Number(insertRes.lastInsertRowid)
      const insertLabelStmt = db.prepare(
        'INSERT INTO document_classification_labels (classification_id, axis, label) VALUES (?, ?, ?);'
      )
      for (const label of params.result.purposeLabels) {
        insertLabelStmt.run(classificationId, 'purpose', label)
      }
      for (const label of params.result.originLabels) {
        insertLabelStmt.run(classificationId, 'origin', label)
      }

      db.exec('COMMIT;')
      this.onClassificationMutation?.()
      return { status: 'committed', classificationId }
    } catch (err) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        // ignore rollback error
      }
      throw err
    }
  }

  public invalidateForLocation(fileLocationId: number): void {
    const db = this.getDb()
    const res = db
      .prepare(
        'UPDATE document_classifications SET is_current = 0 WHERE file_location_id = ? AND is_current = 1;'
      )
      .run(fileLocationId)
    if (Number(res.changes) > 0) {
      this.onClassificationMutation?.()
    }
  }

  /**
   * Reconciles existing classifications & overrides when a location's discovery observation updates:
   * - Always marks stale `document_classifications` non-current (`is_current = 0`) so stale inferences never hide documents.
   * - Timestamp-only touch (identical verified `content_sha256`): preserves `document_classification_overrides` (`is_current = 1`)
   *   and refreshes its observation metadata (`discovery_observation_id`, `observed_mtime_ms`, `content_revision`).
   * - Content change (`content_sha256` differs): marks `document_classification_overrides` non-current (`is_current = 0`).
   */
  /**
   * Reconciles document classification and override state for a location inside an
   * ALREADY-ACTIVE SQLite transaction (e.g., from `CatalogDatabase.persistDiscoveryBatch`
   * or `recordHashObservationsBatch`).
   *
   * Conservative policy:
   * - Stale `document_classifications` for older observations or mismatched hashes are marked `is_current = 0`.
   * - If a new discovery observation has not yet been hashed (`active_sha256` is null):
   *   - An override with no verified hash (`content_sha256 = ''`) or changed `byte_size` is invalidated immediately.
   *   - An override with a verified hash and matching `byte_size` stays anchored to its prior
   *     `discovery_observation_id` (so it is NOT applied to the unverified new observation) until
   *     a matching hash is observed for the new observation.
   * - Once a hash is observed for the current discovery observation:
   *   - If it matches `override.content_sha256`, the override is re-anchored and preserved with refreshed metadata.
   *   - If it differs, the override is invalidated (`is_current = 0`).
   *
   * @returns `true` if any classification or override row was modified.
   */
  public reconcileForLocationInActiveTx(fileLocationId: number): boolean {
    const db = this.getDb()
    const now = Date.now()
    let mutated = false

    const currentObs = db
      .prepare(
        `
        SELECT
          d.id AS discovery_observation_id,
          d.byte_size AS byte_size,
          d.filesystem_mtime_ms AS filesystem_mtime_ms,
          (
            SELECT h.sha256
            FROM hash_observations h
            WHERE h.file_location_id = d.file_location_id
              AND h.discovery_observation_id = d.id
              AND h.is_active = 1
            ORDER BY h.hashed_at_ms DESC, h.id DESC
            LIMIT 1
          ) AS active_sha256
        FROM discovery_observations d
        WHERE d.file_location_id = ? AND d.is_current = 1
        LIMIT 1;
      `
      )
      .get(fileLocationId) as
      | {
          discovery_observation_id: number
          byte_size: number
          filesystem_mtime_ms: number | null
          active_sha256: string | null
        }
      | undefined

    if (!currentObs) {
      const clsRes = db
        .prepare(
          'UPDATE document_classifications SET is_current = 0 WHERE file_location_id = ? AND is_current = 1;'
        )
        .run(fileLocationId)
      const ovRes = db
        .prepare(
          'UPDATE document_classification_overrides SET is_current = 0, updated_at_ms = ? WHERE file_location_id = ? AND is_current = 1;'
        )
        .run(now, fileLocationId)
      return Number(clsRes.changes) > 0 || Number(ovRes.changes) > 0
    }

    const clsRes = db
      .prepare(
        `
        UPDATE document_classifications
        SET is_current = 0
        WHERE file_location_id = ?
          AND is_current = 1
          AND (
            discovery_observation_id != ?
            OR (? IS NOT NULL AND COALESCE(content_sha256, '') != ?)
          );
      `
      )
      .run(
        fileLocationId,
        currentObs.discovery_observation_id,
        currentObs.active_sha256,
        currentObs.active_sha256
      )
    if (Number(clsRes.changes) > 0) {
      mutated = true
    }

    const currOverride = db
      .prepare(
        `
        SELECT id, discovery_observation_id, content_sha256, observed_byte_size
        FROM document_classification_overrides
        WHERE file_location_id = ? AND is_current = 1;
      `
      )
      .get(fileLocationId) as
      | {
          id: number
          discovery_observation_id: number
          content_sha256: string
          observed_byte_size: number
        }
      | undefined

    if (currOverride) {
      const newRevision = buildDocumentContentRevision({
        discoveryObservationId: currentObs.discovery_observation_id,
        byteSize: currentObs.byte_size,
        filesystemMtimeMs: currentObs.filesystem_mtime_ms,
        activeHash: currentObs.active_sha256
      })
      const hasValidNewHash =
        currentObs.active_sha256 !== null && currentObs.active_sha256.length === 64

      if (currOverride.discovery_observation_id === currentObs.discovery_observation_id) {
        if (hasValidNewHash) {
          if (currOverride.content_sha256 === '') {
            db.prepare(
              `
              UPDATE document_classification_overrides
              SET content_sha256 = ?,
                  content_revision = ?,
                  updated_at_ms = ?
              WHERE id = ?;
            `
            ).run(currentObs.active_sha256, newRevision, now, currOverride.id)
            mutated = true
          } else if (currOverride.content_sha256 !== currentObs.active_sha256) {
            db.prepare(
              'UPDATE document_classification_overrides SET is_current = 0, updated_at_ms = ? WHERE id = ?;'
            ).run(now, currOverride.id)
            mutated = true
          }
        }
      } else {
        // New discovery observation created
        if (hasValidNewHash) {
          if (
            currOverride.content_sha256.length === 64 &&
            currOverride.content_sha256 === currentObs.active_sha256
          ) {
            db.prepare(
              `
              UPDATE document_classification_overrides
              SET discovery_observation_id = ?,
                  observed_byte_size = ?,
                  observed_mtime_ms = ?,
                  content_revision = ?,
                  updated_at_ms = ?
              WHERE id = ?;
            `
            ).run(
              currentObs.discovery_observation_id,
              currentObs.byte_size,
              currentObs.filesystem_mtime_ms,
              newRevision,
              now,
              currOverride.id
            )
            mutated = true
          } else {
            db.prepare(
              'UPDATE document_classification_overrides SET is_current = 0, updated_at_ms = ? WHERE id = ?;'
            ).run(now, currOverride.id)
            mutated = true
          }
        } else if (
          currOverride.content_sha256 === '' ||
          currOverride.observed_byte_size !== currentObs.byte_size
        ) {
          // Unverified override or changed byte size -> invalidate immediately
          db.prepare(
            'UPDATE document_classification_overrides SET is_current = 0, updated_at_ms = ? WHERE id = ?;'
          ).run(now, currOverride.id)
          mutated = true
        }
        // Otherwise: verified override with matching byte_size awaits hash verification on the new observation;
        // keeping its old discovery_observation_id ensures it is not applied while unverified.
      }
    }

    return mutated
  }

  public reconcileLocationUpdate(
    fileLocationId: number,
    newDiscoveryObservationId: number,
    newContentSha256: string | null,
    newByteSize: number,
    newMtimeMs: number | null
  ): void {
    const db = this.getDb()
    const now = Date.now()
    const newRevision = buildDocumentContentRevision({
      discoveryObservationId: newDiscoveryObservationId,
      byteSize: newByteSize,
      filesystemMtimeMs: newMtimeMs,
      activeHash: newContentSha256
    })

    db.exec('BEGIN IMMEDIATE;')
    try {
      db.prepare(
        'UPDATE document_classifications SET is_current = 0 WHERE file_location_id = ? AND is_current = 1;'
      ).run(fileLocationId)

      const currOverride = db
        .prepare(
          'SELECT id, content_sha256 FROM document_classification_overrides WHERE file_location_id = ? AND is_current = 1;'
        )
        .get(fileLocationId) as { id: number; content_sha256: string } | undefined

      if (currOverride) {
        const hashMatches =
          newContentSha256 !== null &&
          newContentSha256.length === 64 &&
          currOverride.content_sha256 === newContentSha256

        if (hashMatches) {
          db.prepare(
            `
            UPDATE document_classification_overrides
            SET discovery_observation_id = ?,
                observed_byte_size = ?,
                observed_mtime_ms = ?,
                content_revision = ?,
                updated_at_ms = ?
            WHERE id = ?;
          `
          ).run(
            newDiscoveryObservationId,
            newByteSize,
            newMtimeMs,
            newRevision,
            now,
            currOverride.id
          )
        } else {
          db.prepare(
            'UPDATE document_classification_overrides SET is_current = 0, updated_at_ms = ? WHERE id = ?;'
          ).run(now, currOverride.id)
        }
      }

      db.exec('COMMIT;')
      this.onClassificationMutation?.()
    } catch (err) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        // ignore rollback error
      }
      throw err
    }
  }

  public setClassificationOverride(
    params: SetClassificationOverrideParams
  ): DocClassificationOverrideRecord {
    return this.writeOverrideInTx({
      ...params,
      isActiveRow: true
    })
  }

  public resetClassificationOverride(params: {
    readonly fileLocationId: number
    readonly expectedRevision: string
    readonly expectedOverrideVersion: number
  }): DocClassificationOverrideRecord {
    return this.writeOverrideInTx({
      fileLocationId: params.fileLocationId,
      expectedRevision: params.expectedRevision,
      expectedOverrideVersion: params.expectedOverrideVersion,
      purposeLabels: null,
      originLabels: null,
      clutterOverride: 'inherit',
      isActiveRow: false
    })
  }

  private writeOverrideInTx(
    params: SetClassificationOverrideParams & { readonly isActiveRow: boolean }
  ): DocClassificationOverrideRecord {
    const db = this.getDb()
    const journal = this.getJournal?.()
    const now = Date.now()

    const opId = randomUUID()
    let journalEntry:
      import('../../../shared/validation/ipc-schemas').AnnotationJournalEntry | undefined
    let isCommitted = false

    db.exec('BEGIN IMMEDIATE;')
    try {
      const locRow = db
        .prepare(
          `
          SELECT
            f.id AS file_location_id,
            f.original_path,
            f.normalized_path,
            d.byte_size,
            d.filesystem_mtime_ms,
            d.id AS discovery_observation_id,
            h.sha256 AS active_hash
          FROM file_locations f
          JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
          LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
          WHERE f.id = ? AND f.category = 'document';
        `
        )
        .get(params.fileLocationId) as
        | {
            file_location_id: number
            original_path: string
            normalized_path: string
            byte_size: number
            filesystem_mtime_ms: number | null
            discovery_observation_id: number
            active_hash: string | null
          }
        | undefined

      if (!locRow) {
        throw new Error(`NOT_FOUND: Document location ${params.fileLocationId} does not exist`)
      }

      const currentRevision = buildDocumentContentRevision({
        discoveryObservationId: locRow.discovery_observation_id,
        byteSize: locRow.byte_size,
        filesystemMtimeMs: locRow.filesystem_mtime_ms,
        activeHash: locRow.active_hash
      })

      if (currentRevision !== params.expectedRevision) {
        throw new Error(
          `STALE_REVISION: Expected ${params.expectedRevision}, current ${currentRevision}`
        )
      }

      const existingOverride = db
        .prepare(
          'SELECT COALESCE(MAX(override_version), 0) AS current_version FROM document_classification_overrides WHERE file_location_id = ?;'
        )
        .get(params.fileLocationId) as { current_version: number }

      const currentVersion = Number(existingOverride?.current_version ?? 0)
      if (currentVersion !== params.expectedOverrideVersion) {
        throw new Error(
          `STALE_OVERRIDE_VERSION: Expected version ${params.expectedOverrideVersion}, current ${currentVersion}`
        )
      }

      const nextVersion = currentVersion + 1

      db.prepare(
        'UPDATE document_classification_overrides SET is_current = 0, updated_at_ms = ? WHERE file_location_id = ? AND is_current = 1;'
      ).run(now, params.fileLocationId)

      const insertRes = db
        .prepare(
          `
          INSERT INTO document_classification_overrides (
            file_location_id,
            discovery_observation_id,
            content_sha256,
            observed_byte_size,
            observed_mtime_ms,
            content_revision,
            purpose_labels_json,
            origin_labels_json,
            clutter_override,
            override_version,
            is_current,
            created_at_ms,
            updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        `
        )
        .run(
          params.fileLocationId,
          locRow.discovery_observation_id,
          locRow.active_hash ?? '',
          locRow.byte_size,
          locRow.filesystem_mtime_ms,
          currentRevision,
          params.purposeLabels ? JSON.stringify(params.purposeLabels) : null,
          params.originLabels ? JSON.stringify(params.originLabels) : null,
          params.clutterOverride,
          nextVersion,
          params.isActiveRow ? 1 : 0,
          now,
          now
        )

      if (journal) {
        journalEntry = journal.appendDocumentClassificationOverrideSync({
          opId,
          locationId: params.fileLocationId,
          normalizedPath: locRow.normalized_path,
          originalPath: locRow.original_path,
          byteSize: locRow.byte_size,
          filesystemMtimeMs: locRow.filesystem_mtime_ms,
          activeHash: locRow.active_hash,
          discoveryObservationId: locRow.discovery_observation_id,
          expectedRevision: currentRevision,
          overrideVersion: nextVersion,
          purposeLabels: params.purposeLabels,
          originLabels: params.originLabels,
          clutterOverride: params.clutterOverride
        })
        db.prepare(
          `INSERT INTO journal_operations (op_id, entry_seq, kind, status, applied_at_ms) VALUES (?, ?, 'document_classification_override', 'committed', ?);`
        ).run(opId, journalEntry.entrySeq, now)
      }

      db.exec('COMMIT;')
      isCommitted = true

      let persistencePending = false
      let persistenceError: string | undefined
      if (journal && journalEntry) {
        try {
          journal.appendCommitRecordSync({ opId, targetSeq: journalEntry.entrySeq })
        } catch (commitErr) {
          persistencePending = true
          persistenceError = commitErr instanceof Error ? commitErr.message : String(commitErr)
        }
      }

      this.onClassificationMutation?.()

      return {
        id: Number(insertRes.lastInsertRowid),
        fileLocationId: params.fileLocationId,
        discoveryObservationId: locRow.discovery_observation_id,
        contentSha256: locRow.active_hash ?? '',
        contentRevision: currentRevision,
        purposeLabels: params.purposeLabels ? [...params.purposeLabels] : null,
        originLabels: params.originLabels ? [...params.originLabels] : null,
        clutterOverride: params.clutterOverride,
        overrideVersion: nextVersion,
        createdAtMs: now,
        updatedAtMs: now,
        ...(persistencePending ? { persistencePending: true, persistenceError } : {})
      }
    } catch (err) {
      if (!isCommitted) {
        try {
          db.exec('ROLLBACK;')
        } catch {
          // ignore rollback
        }
        if (journal && journalEntry) {
          try {
            journal.appendAbortRecordSync({
              opId,
              targetSeq: journalEntry.entrySeq,
              reason: err instanceof Error ? err.message : String(err)
            })
          } catch {
            // ignore abort append failure
          }
        }
      }
      throw err
    }
  }

  public getEffectiveDocumentClassification(
    fileLocationId: number
  ): EffectiveDocumentClassification | null {
    const candidate = this.getCandidateForLocation(fileLocationId)
    if (!candidate) return null

    const db = this.getDb()
    const clsRow = db
      .prepare(
        'SELECT * FROM document_classifications WHERE file_location_id = ? AND is_current = 1;'
      )
      .get(fileLocationId) as
      | {
          id: number
          rule_version: string
          text_source_kind: DocumentClassificationTextSource
          purpose_status: DocumentPurposeStatus
          origin_status: DocumentOriginStatus
          confidence_band: ClassificationConfidenceBand
          uncertainty_reason: UncertaintyReason | null
          uncertainty_reasons_json: string
          is_clutter_candidate: number
          has_personal_veto: number
          evidence_json: string
        }
      | undefined

    const labelRows = clsRow
      ? (db
          .prepare(
            'SELECT axis, label FROM document_classification_labels WHERE classification_id = ?;'
          )
          .all(clsRow.id) as Array<{ axis: 'purpose' | 'origin'; label: string }>)
      : []

    const machinePurposeLabels = labelRows
      .filter((l) => l.axis === 'purpose')
      .map((l) => l.label as DocumentPurposeLabel)
    const machineOriginLabels = labelRows
      .filter((l) => l.axis === 'origin')
      .map((l) => l.label as DocumentOriginLabel)

    const overrideRow = db
      .prepare(
        'SELECT * FROM document_classification_overrides WHERE file_location_id = ? AND discovery_observation_id = ? AND is_current = 1;'
      )
      .get(fileLocationId, candidate.row.discovery_observation_id) as
      | {
          id: number
          file_location_id: number
          discovery_observation_id: number
          content_sha256: string
          content_revision: string
          purpose_labels_json: string | null
          origin_labels_json: string | null
          clutter_override: DocumentClutterOverride
          override_version: number
          created_at_ms: number
          updated_at_ms: number
        }
      | undefined

    const latestOverrideRow = db
      .prepare(
        `SELECT is_current, discovery_observation_id, clutter_override, purpose_labels_json, origin_labels_json, override_version
         FROM document_classification_overrides
         WHERE file_location_id = ?
         ORDER BY override_version DESC, id DESC
         LIMIT 1;`
      )
      .get(fileLocationId) as
      | {
          is_current: number
          discovery_observation_id: number
          clutter_override: DocumentClutterOverride
          purpose_labels_json: string | null
          origin_labels_json: string | null
          override_version: number
        }
      | undefined

    const latestOverrideVersion = latestOverrideRow?.override_version ?? 0
    const hasUnverifiedOverride =
      !overrideRow &&
      latestOverrideRow !== undefined &&
      latestOverrideRow.is_current === 1 &&
      latestOverrideRow.discovery_observation_id !== candidate.row.discovery_observation_id
    const isExplicitResetRow =
      latestOverrideRow !== undefined &&
      latestOverrideRow.is_current === 0 &&
      latestOverrideRow.clutter_override === 'inherit' &&
      latestOverrideRow.purpose_labels_json === null &&
      latestOverrideRow.origin_labels_json === null
    const hasStaleOverride =
      !overrideRow &&
      !hasUnverifiedOverride &&
      latestOverrideRow !== undefined &&
      latestOverrideRow.is_current === 0 &&
      !isExplicitResetRow

    const override: DocClassificationOverrideRecord | null = overrideRow
      ? {
          id: overrideRow.id,
          fileLocationId: overrideRow.file_location_id,
          discoveryObservationId: overrideRow.discovery_observation_id,
          contentSha256: overrideRow.content_sha256,
          contentRevision: overrideRow.content_revision,
          purposeLabels: overrideRow.purpose_labels_json
            ? (JSON.parse(overrideRow.purpose_labels_json) as DocumentPurposeLabel[])
            : null,
          originLabels: overrideRow.origin_labels_json
            ? (JSON.parse(overrideRow.origin_labels_json) as DocumentOriginLabel[])
            : null,
          clutterOverride: overrideRow.clutter_override,
          overrideVersion: overrideRow.override_version,
          createdAtMs: overrideRow.created_at_ms,
          updatedAtMs: overrideRow.updated_at_ms
        }
      : null

    const isClassified = clsRow !== undefined
    const isStale = isClassified && !candidate.isCompatible

    // Stale machine classifications must NOT hide documents
    const machineIsClutterActive = isClassified && !isStale && clsRow.is_clutter_candidate === 1

    const effectivePurposeLabels =
      override?.purposeLabels !== undefined && override?.purposeLabels !== null
        ? override.purposeLabels
        : isClassified
          ? machinePurposeLabels
          : []
    const effectiveOriginLabels =
      override?.originLabels !== undefined && override?.originLabels !== null
        ? override.originLabels
        : isClassified
          ? machineOriginLabels
          : []

    const effectivePurposeStatus: DocumentPurposeStatus =
      effectivePurposeLabels.length > 0
        ? 'classified'
        : isClassified
          ? clsRow.purpose_status
          : 'unknown'
    const effectiveOriginStatus: DocumentOriginStatus =
      effectiveOriginLabels.length > 0 ? 'classified' : 'unknown'

    const effectiveIsClutter =
      override?.clutterOverride === 'force_keep'
        ? false
        : override?.clutterOverride === 'force_clutter'
          ? true
          : machineIsClutterActive && !effectiveOriginLabels.includes('personal')

    return {
      fileLocationId,
      discoveryObservationId: candidate.row.discovery_observation_id,
      contentRevision: candidate.resolved.contentRevision,
      isClassified,
      isStale,
      machineRuleVersion: clsRow?.rule_version ?? null,
      machineTextSourceKind: clsRow?.text_source_kind ?? null,
      machinePurposeStatus: clsRow?.purpose_status ?? 'unknown',
      machineOriginStatus: clsRow?.origin_status ?? 'unknown',
      machinePurposeLabels,
      machineOriginLabels,
      confidenceBand: clsRow?.confidence_band ?? 'low',
      uncertaintyReason: clsRow?.uncertainty_reason ?? null,
      uncertaintyReasons: clsRow
        ? (JSON.parse(clsRow.uncertainty_reasons_json) as UncertaintyReason[])
        : [],
      isClutterCandidate: clsRow ? clsRow.is_clutter_candidate === 1 : false,
      hasPersonalVeto: clsRow ? clsRow.has_personal_veto === 1 : false,
      evidence: clsRow
        ? (JSON.parse(clsRow.evidence_json) as DocumentClassificationEvidence[])
        : [],
      override,
      hasStaleOverride,
      hasUnverifiedOverride,
      latestOverrideVersion,
      effectivePurposeLabels,
      effectiveOriginLabels,
      effectivePurposeStatus,
      effectiveOriginStatus,
      effectiveIsClutter
    }
  }

  public getHiddenClutterCount(): number {
    const db = this.getDb()
    const rows = db
      .prepare(
        `
        ${DOCUMENT_CLASSIFICATION_CANDIDATE_SELECT}
        WHERE f.category = 'document';
      `
      )
      .all() as unknown as DocumentClassificationCandidateRow[]

    let count = 0
    for (const row of rows) {
      const ov = db
        .prepare(
          'SELECT clutter_override, origin_labels_json FROM document_classification_overrides WHERE file_location_id = ? AND discovery_observation_id = ? AND is_current = 1;'
        )
        .get(row.file_location_id, row.discovery_observation_id) as
        { clutter_override: DocumentClutterOverride; origin_labels_json: string | null } | undefined

      if (ov?.clutter_override === 'force_keep') continue
      if (ov?.clutter_override === 'force_clutter') {
        count += 1
        continue
      }

      if (row.cls_id === null || row.cls_is_current !== 1) continue
      const resolved = resolveClassificationInputTrack(row)
      if (!isDocumentClassificationRowCompatible(row, resolved, DETERMINISTIC_RULE_VERSION)) {
        continue
      }
      const cls = db
        .prepare('SELECT is_clutter_candidate FROM document_classifications WHERE id = ?;')
        .get(row.cls_id) as { is_clutter_candidate: number } | undefined
      if (cls?.is_clutter_candidate === 1) {
        const overrideOrigins = ov?.origin_labels_json
          ? (JSON.parse(ov.origin_labels_json) as DocumentOriginLabel[])
          : null
        if (!overrideOrigins?.includes('personal')) {
          count += 1
        }
      }
    }
    return count
  }

  public getCoverage(): DocClassificationCoverage {
    const db = this.getDb()
    const rows = db
      .prepare(
        `
        ${DOCUMENT_CLASSIFICATION_CANDIDATE_SELECT}
        WHERE f.category = 'document';
      `
      )
      .all() as unknown as DocumentClassificationCandidateRow[]

    let classifiedDocuments = 0
    let otherDocuments = 0
    let unknownDocuments = 0
    let unclassifiedDocuments = 0
    let staleDocuments = 0
    let hiddenClutterCount = 0

    for (const row of rows) {
      const ov = db
        .prepare(
          'SELECT clutter_override, origin_labels_json FROM document_classification_overrides WHERE file_location_id = ? AND discovery_observation_id = ? AND is_current = 1;'
        )
        .get(row.file_location_id, row.discovery_observation_id) as
        { clutter_override: DocumentClutterOverride; origin_labels_json: string | null } | undefined

      if (row.cls_id === null || row.cls_is_current !== 1) {
        unclassifiedDocuments += 1
        if (ov?.clutter_override === 'force_clutter') hiddenClutterCount += 1
        continue
      }

      const resolved = resolveClassificationInputTrack(row)
      const compatible = isDocumentClassificationRowCompatible(
        row,
        resolved,
        DETERMINISTIC_RULE_VERSION
      )
      if (!compatible) {
        staleDocuments += 1
        if (ov?.clutter_override === 'force_clutter') hiddenClutterCount += 1
        continue
      }

      const cls = db
        .prepare(
          'SELECT purpose_status, is_clutter_candidate FROM document_classifications WHERE id = ?;'
        )
        .get(row.cls_id) as { purpose_status: DocumentPurposeStatus; is_clutter_candidate: number }

      if (cls.purpose_status === 'classified') classifiedDocuments += 1
      else if (cls.purpose_status === 'other') otherDocuments += 1
      else unknownDocuments += 1

      if (ov?.clutter_override === 'force_clutter') {
        hiddenClutterCount += 1
      } else if (ov?.clutter_override !== 'force_keep' && cls.is_clutter_candidate === 1) {
        const overrideOrigins = ov?.origin_labels_json
          ? (JSON.parse(ov.origin_labels_json) as DocumentOriginLabel[])
          : null
        if (!overrideOrigins?.includes('personal')) {
          hiddenClutterCount += 1
        }
      }
    }

    const overriddenCountRow = db
      .prepare(
        `
        SELECT COUNT(*) AS cnt
        FROM document_classification_overrides o
        JOIN file_locations f ON f.id = o.file_location_id
        JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
        WHERE o.is_current = 1
          AND o.discovery_observation_id = d.id
          AND f.category = 'document';
      `
      )
      .get() as { cnt: number }

    return {
      totalDocuments: rows.length,
      classifiedDocuments,
      otherDocuments,
      unknownDocuments,
      unclassifiedDocuments,
      staleDocuments,
      hiddenClutterCount,
      overriddenDocuments: Number(overriddenCountRow.cnt ?? 0)
    }
  }

  public toEffectiveClassificationSummary(
    eff: EffectiveDocumentClassification,
    includeEvidence = false
  ): DocumentEffectiveClassificationSummary {
    return {
      isClassified: eff.isClassified,
      isStale: eff.isStale,
      machineRuleVersion: eff.machineRuleVersion,
      machineTextSourceKind: eff.machineTextSourceKind,
      machinePurposeStatus: eff.machinePurposeStatus,
      machineOriginStatus: eff.machineOriginStatus,
      machinePurposeLabels: [...eff.machinePurposeLabels],
      machineOriginLabels: [...eff.machineOriginLabels],
      confidenceBand: eff.confidenceBand,
      uncertaintyReason: eff.uncertaintyReason,
      uncertaintyReasons: [...eff.uncertaintyReasons],
      isClutterCandidate: eff.isClutterCandidate,
      hasPersonalVeto: eff.hasPersonalVeto,
      effectivePurposeStatus: eff.effectivePurposeStatus,
      effectiveOriginStatus: eff.effectiveOriginStatus,
      effectivePurposeLabels: [...eff.effectivePurposeLabels],
      effectiveOriginLabels: [...eff.effectiveOriginLabels],
      effectiveIsClutter: eff.effectiveIsClutter,
      hasOverride: eff.override !== null,
      hasStaleOverride: eff.hasStaleOverride,
      hasUnverifiedOverride: eff.hasUnverifiedOverride,
      clutterOverride: eff.override?.clutterOverride ?? 'inherit',
      overrideVersion: eff.latestOverrideVersion,
      contentRevision: eff.contentRevision,
      ...(includeEvidence ? { evidence: [...eff.evidence] } : {})
    }
  }

  public getClassificationFacets(filters?: {
    readonly extensionFilter?: string | null
    readonly filenameQuery?: string
  }): GetDocumentClassificationFacetsResponseDto {
    const db = this.getDb()
    const { whereClause, params } = buildDocumentFilterSql({
      extensionFilter: filters?.extensionFilter ?? null,
      filenameQuery: filters?.filenameQuery
    })

    const rows = db
      .prepare(
        `
        SELECT
          f.id AS file_location_id,
          cls.id AS cls_id,
          cls.purpose_status AS cls_purpose_status,
          cls.origin_status AS cls_origin_status,
          clso.id AS override_id,
          clso.purpose_labels_json AS override_purpose_json,
          clso.origin_labels_json AS override_origin_json,
          ${EFFECTIVE_CLUTTER_SQL_EXPR} AS effective_is_clutter
        FROM file_locations f
        JOIN discovery_observations d
          ON d.file_location_id = f.id AND d.is_current = 1
        ${EFFECTIVE_CLASSIFICATION_JOIN_SQL}
        ${whereClause};
      `
      )
      .all(...params) as Array<{
      file_location_id: number
      cls_id: number | null
      cls_purpose_status: DocumentPurposeStatus | null
      cls_origin_status: DocumentOriginStatus | null
      override_id: number | null
      override_purpose_json: string | null
      override_origin_json: string | null
      effective_is_clutter: number
    }>

    const machineLabelsByClsId = new Map<
      number,
      { purpose: DocumentPurposeLabel[]; origin: DocumentOriginLabel[] }
    >()
    const clsIds = rows.map((r) => r.cls_id).filter((id): id is number => id !== null)
    if (clsIds.length > 0) {
      const labelRows = db
        .prepare(
          `SELECT classification_id, axis, label FROM document_classification_labels WHERE classification_id IN (${clsIds.map(() => '?').join(', ')});`
        )
        .all(...clsIds) as Array<{
        classification_id: number
        axis: 'purpose' | 'origin'
        label: string
      }>
      for (const lr of labelRows) {
        let entry = machineLabelsByClsId.get(lr.classification_id)
        if (!entry) {
          entry = { purpose: [], origin: [] }
          machineLabelsByClsId.set(lr.classification_id, entry)
        }
        if (lr.axis === 'purpose') entry.purpose.push(lr.label as DocumentPurposeLabel)
        else entry.origin.push(lr.label as DocumentOriginLabel)
      }
    }

    const purposeCounts = {
      legal: 0,
      lists: 0,
      instructions: 0,
      receipts: 0,
      recipes: 0,
      other: 0,
      unknown: 0
    }
    const originCounts = {
      personal: 0,
      software_project: 0,
      application_system: 0,
      unknown: 0
    }
    let clutterCount = 0
    let overriddenCount = 0

    for (const row of rows) {
      if (row.override_id !== null) overriddenCount += 1
      if (row.effective_is_clutter === 1) clutterCount += 1

      const machine = row.cls_id !== null ? machineLabelsByClsId.get(row.cls_id) : undefined
      const overridePurpose =
        row.override_purpose_json !== null
          ? (JSON.parse(row.override_purpose_json) as DocumentPurposeLabel[])
          : null
      if (overridePurpose !== null) {
        if (overridePurpose.length === 0) purposeCounts.other += 1
        else {
          for (const lbl of overridePurpose) purposeCounts[lbl] += 1
        }
      } else if (row.cls_id !== null && row.cls_purpose_status) {
        if (row.cls_purpose_status === 'classified' && machine && machine.purpose.length > 0) {
          for (const lbl of machine.purpose) purposeCounts[lbl] += 1
        } else if (row.cls_purpose_status === 'other') {
          purposeCounts.other += 1
        } else {
          purposeCounts.unknown += 1
        }
      } else {
        purposeCounts.unknown += 1
      }

      const overrideOrigin =
        row.override_origin_json !== null
          ? (JSON.parse(row.override_origin_json) as DocumentOriginLabel[])
          : null
      if (overrideOrigin !== null) {
        if (overrideOrigin.length === 0) originCounts.unknown += 1
        else {
          for (const lbl of overrideOrigin) originCounts[lbl] += 1
        }
      } else if (row.cls_id !== null && row.cls_origin_status === 'classified' && machine) {
        if (machine.origin.length === 0) originCounts.unknown += 1
        else {
          for (const lbl of machine.origin) originCounts[lbl] += 1
        }
      } else {
        originCounts.unknown += 1
      }
    }

    return {
      purposeCounts,
      originCounts,
      clutterCount,
      totalDocuments: rows.length,
      overriddenCount
    }
  }

  // ─── Job & 250-Row Batched Snapshot Management ─────────────────────────────

  private getValidatedStagingDir(): string | null {
    const stagingDir = resolve(dirname(this.getCatalogPath()), '.doc_classify_snapshots')
    if (!existsSync(stagingDir)) return null
    try {
      const st = lstatSync(stagingDir)
      if (st.isSymbolicLink() || !st.isDirectory()) return null
      return stagingDir
    } catch {
      return null
    }
  }

  private resolveValidatedStagingFilePath(stagingDir: string, fileName: string): string | null {
    if (
      !fileName.endsWith('.ndjson') ||
      fileName.includes('/') ||
      fileName.includes('\\') ||
      fileName.includes('..')
    ) {
      return null
    }
    const resolvedDir = resolve(stagingDir)
    const candidate = resolve(resolvedDir, fileName)
    if (dirname(candidate) !== resolvedDir) return null
    try {
      const st = lstatSync(candidate)
      if (st.isSymbolicLink() || !st.isFile()) return null
      return candidate
    } catch {
      return null
    }
  }

  public cleanupIncompleteSnapshots(): number {
    const db = this.getDb()
    const inFlightIds = [...this.inFlightSnapshotJobIds]
    const res =
      inFlightIds.length > 0
        ? db
            .prepare(
              `DELETE FROM document_classification_jobs WHERE snapshot_complete = 0 AND id NOT IN (${inFlightIds.map(() => '?').join(', ')});`
            )
            .run(...inFlightIds)
        : db.prepare('DELETE FROM document_classification_jobs WHERE snapshot_complete = 0;').run()
    let removedFiles = 0

    const stagingDir = this.getValidatedStagingDir()
    if (stagingDir) {
      const activeRows = db
        .prepare(
          "SELECT id FROM document_classification_jobs WHERE status IN ('running', 'paused', 'interrupted');"
        )
        .all() as Array<{ id: string }>
      const activeIds = new Set([...activeRows.map((r) => r.id), ...inFlightIds])

      for (const entry of readdirSync(stagingDir)) {
        if (!entry.endsWith('.ndjson')) continue
        const jobIdFromFile = entry.slice(0, -'.ndjson'.length)
        if (activeIds.has(jobIdFromFile)) continue
        const validated = this.resolveValidatedStagingFilePath(stagingDir, entry)
        if (!validated) continue
        try {
          rmSync(validated, { force: true })
          removedFiles += 1
        } catch {
          // ignore single file cleanup failure
        }
      }
    }

    return Number(res.changes) + removedFiles
  }

  public markRunningJobsAsInterrupted(): number {
    const db = this.getDb()
    const now = Date.now()
    const inFlightIds = [...this.inFlightSnapshotJobIds]
    const res =
      inFlightIds.length > 0
        ? db
            .prepare(
              `UPDATE document_classification_jobs SET status = 'interrupted', updated_at_ms = ? WHERE status = 'running' AND id NOT IN (${inFlightIds.map(() => '?').join(', ')});`
            )
            .run(now, ...inFlightIds)
        : db
            .prepare(
              "UPDATE document_classification_jobs SET status = 'interrupted', updated_at_ms = ? WHERE status = 'running';"
            )
            .run(now)
    return Number(res.changes)
  }

  public getLatestJob(): DocClassificationJobRecord | null {
    const db = this.getDb()
    const row = db
      .prepare(
        'SELECT * FROM document_classification_jobs ORDER BY started_at_ms DESC, rowid DESC LIMIT 1;'
      )
      .get() as Record<string, unknown> | undefined
    return row ? this.mapJobRow(row) : null
  }

  public getJobById(jobId: string): DocClassificationJobRecord | null {
    const db = this.getDb()
    const row = db
      .prepare('SELECT * FROM document_classification_jobs WHERE id = ?;')
      .get(jobId) as Record<string, unknown> | undefined
    return row ? this.mapJobRow(row) : null
  }

  public updateJobStatus(
    jobId: string,
    status: DocClassificationJobStatus,
    lastError: string | null = null
  ): void {
    const db = this.getDb()
    const now = Date.now()
    const completedAt =
      status === 'completed' || status === 'cancelled' || status === 'failed' ? now : null
    db.prepare(
      `
      UPDATE document_classification_jobs
      SET status = ?, updated_at_ms = ?, completed_at_ms = COALESCE(?, completed_at_ms), last_error = COALESCE(?, last_error)
      WHERE id = ?;
    `
    ).run(status, now, completedAt, lastError, jobId)
  }

  public getNextPendingBatch(jobId: string, limit = 50): DocClassificationPendingItem[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        `
        SELECT
          job_id,
          file_location_id,
          discovery_observation_id,
          content_revision,
          native_extraction_id,
          ocr_extraction_id,
          normalized_input_sha256
        FROM document_classification_job_items
        WHERE job_id = ? AND status = 'pending'
        ORDER BY file_location_id ASC
        LIMIT ?;
      `
      )
      .all(jobId, limit) as Array<{
      job_id: string
      file_location_id: number
      discovery_observation_id: number
      content_revision: string
      native_extraction_id: number | null
      ocr_extraction_id: number | null
      normalized_input_sha256: string
    }>

    return rows.map((r) => ({
      jobId: r.job_id,
      fileLocationId: r.file_location_id,
      discoveryObservationId: r.discovery_observation_id,
      contentRevision: r.content_revision,
      nativeExtractionId: r.native_extraction_id,
      ocrExtractionId: r.ocr_extraction_id,
      normalizedInputSha256: r.normalized_input_sha256
    }))
  }

  public recordJobItemOutcome(params: {
    readonly jobId: string
    readonly fileLocationId: number
    readonly status: Exclude<DocClassificationJobItemStatus, 'pending'>
    readonly isClutter?: boolean
    readonly errorMessage?: string | null
  }): void {
    const db = this.getDb()
    const now = Date.now()
    db.exec('BEGIN IMMEDIATE;')
    try {
      const upd = db
        .prepare(
          `
          UPDATE document_classification_job_items
          SET status = ?, error_message = ?, updated_at_ms = ?
          WHERE job_id = ? AND file_location_id = ? AND status = 'pending';
        `
        )
        .run(params.status, params.errorMessage ?? null, now, params.jobId, params.fileLocationId)

      if (Number(upd.changes) > 0) {
        const incClassified = params.status === 'classified' ? 1 : 0
        const incOther = params.status === 'other' ? 1 : 0
        const incUnknown = params.status === 'unknown' ? 1 : 0
        const incClutter = params.isClutter ? 1 : 0
        const incReused = params.status === 'reused' ? 1 : 0
        const incSkipped = params.status === 'skipped_stale' ? 1 : 0
        const incFailed = params.status === 'failed' ? 1 : 0

        db.prepare(
          `
          UPDATE document_classification_jobs
          SET processed_items = processed_items + 1,
              classified_items = classified_items + ?,
              other_items = other_items + ?,
              unknown_items = unknown_items + ?,
              clutter_items = clutter_items + ?,
              reused_items = reused_items + ?,
              skipped_stale_items = skipped_stale_items + ?,
              failed_items = failed_items + ?,
              updated_at_ms = ?
          WHERE id = ?;
        `
        ).run(
          incClassified,
          incOther,
          incUnknown,
          incClutter,
          incReused,
          incSkipped,
          incFailed,
          now,
          params.jobId
        )
      }

      db.exec('COMMIT;')
    } catch (err) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      throw err
    }
  }

  public async captureAndCreateJob(params: {
    readonly jobId: string
    readonly scopeKind: DocClassificationJobScopeKind
    readonly ruleVersion: string
    readonly fileLocationIds?: readonly number[]
    readonly extensionFilter?: string | null
    readonly filenameQuery?: string
    readonly forceReclassify?: boolean
    readonly workerBudget: AppWorkerBudget
    readonly getExternalLiveWorkers?: () => number
    readonly shouldCancel?: () => boolean
    readonly snapshotWorkerScriptPath?: string
    readonly appPath?: string | null
    readonly isPackaged?: boolean
  }): Promise<DocClassificationJobRecord> {
    const db = this.getDb()
    const catalogPath = this.getCatalogPath()
    if (!catalogPath || catalogPath === ':memory:') {
      throw new Error('Snapshot worker requires a file-backed catalogPath')
    }

    const now = Date.now()
    this.inFlightSnapshotJobIds.add(params.jobId)
    try {
      db.prepare(
        `
      INSERT INTO document_classification_jobs (
        id, scope_kind, status, rule_version, filter_extension, filter_filename_query,
        force_reclassify, snapshot_complete, started_at_ms, updated_at_ms
      ) VALUES (?, ?, 'running', ?, ?, ?, ?, 0, ?, ?);
    `
      ).run(
        params.jobId,
        params.scopeKind,
        params.ruleVersion,
        params.extensionFilter ?? null,
        params.filenameQuery ?? null,
        params.forceReclassify ? 1 : 0,
        now,
        now
      )

      if (
        !params.jobId ||
        params.jobId.includes('/') ||
        params.jobId.includes('\\') ||
        params.jobId.includes('..')
      ) {
        throw new Error('INVALID_JOB_ID: Snapshot jobId must be a safe single-segment identifier')
      }

      const stagingDir = resolve(dirname(catalogPath), '.doc_classify_snapshots')
      if (existsSync(stagingDir)) {
        const st = lstatSync(stagingDir)
        if (st.isSymbolicLink() || !st.isDirectory()) {
          throw new Error(
            'INVALID_STAGING_DIR: Snapshot staging directory must be a real directory'
          )
        }
      } else {
        mkdirSync(stagingDir, { recursive: true })
      }
      const stagingFilePath = resolve(stagingDir, `${params.jobId}.ndjson`)
      if (dirname(stagingFilePath) !== stagingDir) {
        throw new Error('INVALID_STAGING_PATH: Snapshot staging path escaped staging directory')
      }

      try {
        await this.runSnapshotWorker({
          catalogPath,
          stagingFilePath,
          input: {
            scopeKind: params.scopeKind,
            ruleVersion: params.ruleVersion,
            fileLocationIds: params.fileLocationIds,
            extensionFilter: params.extensionFilter,
            filenameQuery: params.filenameQuery,
            forceReclassify: params.forceReclassify
          },
          workerBudget: params.workerBudget,
          getExternalLiveWorkers: params.getExternalLiveWorkers,
          shouldCancel: params.shouldCancel,
          snapshotWorkerScriptPath: params.snapshotWorkerScriptPath,
          appPath: params.appPath,
          isPackaged: params.isPackaged
        })

        if (params.shouldCancel?.()) {
          throw new Error('CANCELLED: Document classification snapshot cancelled')
        }

        const totalItems = await this.ingestSnapshotNdjson({
          jobId: params.jobId,
          stagingFilePath,
          now,
          shouldCancel: params.shouldCancel
        })

        db.prepare(
          `
        UPDATE document_classification_jobs
        SET total_items = ?, snapshot_complete = 1, updated_at_ms = ?
        WHERE id = ?;
      `
        ).run(totalItems, Date.now(), params.jobId)

        return this.getJobById(params.jobId)!
      } catch (err) {
        db.prepare('DELETE FROM document_classification_jobs WHERE id = ?;').run(params.jobId)
        throw err
      } finally {
        try {
          const validated = this.resolveValidatedStagingFilePath(
            stagingDir,
            `${params.jobId}.ndjson`
          )
          if (validated) {
            rmSync(validated, { force: true })
          }
        } catch {
          // ignore cleanup error
        }
      }
    } finally {
      this.inFlightSnapshotJobIds.delete(params.jobId)
    }
  }

  public async ingestSnapshotNdjson(params: {
    readonly jobId: string
    readonly stagingFilePath: string
    readonly now: number
    readonly shouldCancel?: () => boolean
  }): Promise<number> {
    if (!existsSync(params.stagingFilePath)) {
      return 0
    }
    const st = lstatSync(params.stagingFilePath)
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error('INVALID_STAGING_FILE: Snapshot staging file is not a regular file')
    }

    const db = this.getDb()
    const insertItemStmt = db.prepare(
      `
      INSERT OR IGNORE INTO document_classification_job_items (
        job_id, file_location_id, discovery_observation_id, content_revision,
        native_extraction_id, ocr_extraction_id, normalized_input_sha256, status, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?);
    `
    )

    const flushBatch = (batch: readonly DocClassificationSnapshotItem[]): void => {
      if (batch.length === 0) return
      db.exec('BEGIN IMMEDIATE;')
      try {
        for (const item of batch) {
          insertItemStmt.run(
            params.jobId,
            item.f,
            item.d,
            item.r,
            item.ne,
            item.oe,
            item.h,
            params.now
          )
        }
        db.exec('COMMIT;')
      } catch (err) {
        try {
          db.exec('ROLLBACK;')
        } catch {
          // ignore
        }
        throw err
      }
    }

    const BATCH_SIZE = 250
    let batch: DocClassificationSnapshotItem[] = []
    let totalItems = 0

    const stream = createReadStream(params.stagingFilePath, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })

    try {
      for await (const rawLine of rl) {
        if (params.shouldCancel?.()) {
          throw new Error('CANCELLED: Document classification snapshot cancelled')
        }
        const trimmed = rawLine.trim()
        if (trimmed.length === 0) continue

        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch (parseErr) {
          throw new Error(
            `MALFORMED_SNAPSHOT: Invalid JSON line in snapshot (${
              parseErr instanceof Error ? parseErr.message : String(parseErr)
            })`,
            { cause: parseErr }
          )
        }

        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          typeof (parsed as DocClassificationSnapshotItem).f !== 'number' ||
          typeof (parsed as DocClassificationSnapshotItem).d !== 'number' ||
          typeof (parsed as DocClassificationSnapshotItem).r !== 'string' ||
          typeof (parsed as DocClassificationSnapshotItem).h !== 'string'
        ) {
          throw new Error('MALFORMED_SNAPSHOT: Snapshot line missing required fields')
        }

        batch.push(parsed as DocClassificationSnapshotItem)
        totalItems += 1

        if (batch.length >= BATCH_SIZE) {
          flushBatch(batch)
          batch = []
        }
      }

      if (params.shouldCancel?.()) {
        throw new Error('CANCELLED: Document classification snapshot cancelled')
      }

      if (batch.length > 0) {
        flushBatch(batch)
      }
    } finally {
      rl.close()
      stream.destroy()
    }

    return totalItems
  }

  private async runSnapshotWorker(params: {
    readonly catalogPath: string
    readonly stagingFilePath: string
    readonly input: import('./document-classification-snapshot-query').DocClassificationSnapshotJobInput
    readonly workerBudget: AppWorkerBudget
    readonly getExternalLiveWorkers?: () => number
    readonly shouldCancel?: () => boolean
    readonly snapshotWorkerScriptPath?: string
    readonly appPath?: string | null
    readonly isPackaged?: boolean
  }): Promise<number> {
    let reservation: WorkerBudgetReservation
    for (;;) {
      if (params.shouldCancel?.()) {
        throw new Error('CANCELLED: Document classification snapshot cancelled')
      }
      const acquired = params.workerBudget.tryReserve(params.getExternalLiveWorkers)
      if (acquired) {
        reservation = acquired
        break
      }
      await new Promise((r) => setTimeout(r, 15))
    }

    let worker: Worker
    try {
      const scriptPath = resolveMainWorkerScriptPath({
        workerFileName: 'document_snapshot_worker.js',
        sourceEntryPath: resolve(__dirname, '../documents/snapshot-worker.ts'),
        customPath: params.snapshotWorkerScriptPath,
        moduleDir: __dirname,
        appPath: params.appPath,
        isPackaged: params.isPackaged
      })
      if (!existsSync(scriptPath)) {
        throw new Error(`Snapshot worker script not found: ${scriptPath}`)
      }
      worker = new Worker(scriptPath, {
        workerData: {
          kind: 'doc_classify',
          catalogPath: params.catalogPath,
          stagingFilePath: params.stagingFilePath,
          input: params.input
        }
      })
      params.workerBudget.promote(reservation, worker)
    } catch (err) {
      params.workerBudget.releaseReservation(reservation)
      throw err
    }

    return new Promise<number>((resolvePromise, rejectPromise) => {
      let settled = false
      const cleanup = () => {
        clearInterval(pollCancel)
      }
      const pollCancel = setInterval(() => {
        if (params.shouldCancel?.() && !settled) {
          settled = true
          cleanup()
          const rejectCancelled = () =>
            rejectPromise(new Error('CANCELLED: Document classification snapshot cancelled'))
          worker.once('exit', rejectCancelled)
          void worker.terminate().then(rejectCancelled, rejectCancelled)
        }
      }, 25)

      worker.once('message', (msg: { ok: boolean; count?: number; errorMessage?: string }) => {
        if (settled) return
        settled = true
        cleanup()
        const finish = () => {
          if (msg.ok) {
            resolvePromise(msg.count ?? 0)
          } else {
            rejectPromise(new Error(msg.errorMessage ?? 'Snapshot worker failed'))
          }
        }
        worker.once('exit', finish)
        setTimeout(finish, 200)
      })
      worker.once('error', (err) => {
        if (settled) return
        settled = true
        cleanup()
        rejectPromise(err)
      })
      worker.once('exit', (code) => {
        if (settled) return
        settled = true
        cleanup()
        rejectPromise(new Error(`Snapshot worker exited unexpectedly (code=${code})`))
      })
    })
  }

  private mapJobRow(row: Record<string, unknown>): DocClassificationJobRecord {
    return {
      id: String(row.id),
      scopeKind: row.scope_kind as DocClassificationJobScopeKind,
      status: row.status as DocClassificationJobStatus,
      ruleVersion: String(row.rule_version),
      filterExtension: (row.filter_extension as string | null) ?? null,
      filterFilenameQuery: (row.filter_filename_query as string | null) ?? null,
      forceReclassify: Number(row.force_reclassify) === 1,
      snapshotComplete: Number(row.snapshot_complete) === 1,
      totalItems: Number(row.total_items ?? 0),
      processedItems: Number(row.processed_items ?? 0),
      classifiedItems: Number(row.classified_items ?? 0),
      otherItems: Number(row.other_items ?? 0),
      unknownItems: Number(row.unknown_items ?? 0),
      clutterItems: Number(row.clutter_items ?? 0),
      reusedItems: Number(row.reused_items ?? 0),
      skippedStaleItems: Number(row.skipped_stale_items ?? 0),
      failedItems: Number(row.failed_items ?? 0),
      startedAtMs: Number(row.started_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
      completedAtMs: row.completed_at_ms !== null ? Number(row.completed_at_ms) : null,
      lastError: (row.last_error as string | null) ?? null
    }
  }
}
