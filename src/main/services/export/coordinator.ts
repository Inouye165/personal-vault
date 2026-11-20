/**
 * Personal Vault — Stage 8A Slice 3: Export Coordinator
 *
 * Orchestrates selective bundle exports in the main process:
 * - Runs startup recovery (`markRunningJobsAsInterrupted`) before history is queried.
 * - Resolves cataloged items (recorded facts, vault copies, photo/document metadata,
 *   user overrides/annotations) into `ExportItemInput` records without modifying sources/vault.
 * - Enforces privacy defaults (`includeOriginalPaths: false`, `includeExtractedText: false`),
 *   destination containment, no-overwrite, and single-active-job cancellation.
 */

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  ExportPrivacyOptionsSchema,
  type ExportPrivacyOptions
} from '../../../shared/validation/export-schemas'
import type { CatalogDatabase } from '../catalog/database'
import type {
  ExportJobItemRecord,
  ExportJobRecord,
  ListExportJobItemsOptions,
  ListExportJobsOptions,
  PaginatedExportResult
} from '../catalog/export-repository'
import { exportBundle } from './bundle'
import { validateExportParentAndBundlePath } from './containment'
import type {
  ExportDocumentMachineGeneratedInput,
  ExportDocumentUserOverridesInput,
  ExportItemInput,
  ExportPhotoMachineGeneratedInput,
  ExportPhotoUserAnnotationsInput,
  ExportTestHooks,
  ExportVaultCopyRef
} from './types'

export interface ExportCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly userDataDir: string
  readonly appVersion: string
}

export interface StartExportInput {
  readonly parentDir: string
  readonly bundleFolderName: string
  readonly fileLocationIds: readonly number[]
  readonly privacyOptions?: Partial<ExportPrivacyOptions>
  readonly hooks?: ExportTestHooks
}

export class ExportCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly userDataDir: string
  private readonly appVersion: string
  private readonly events = new EventEmitter()
  private activeJobId: string | null = null
  private abortController: AbortController | null = null
  private completionPromise: Promise<ExportJobRecord | null> | null = null
  private isStarting = false
  private isShutdown = false

  public constructor(options: ExportCoordinatorOptions) {
    this.catalog = options.catalog
    this.userDataDir = options.userDataDir
    this.appVersion = options.appVersion
  }

  /**
   * Transitions any stale `running` export jobs from an interrupted session to
   * `interrupted` before history is surfaced or new exports begin.
   */
  public initialize(): number {
    return this.catalog.getExportRepository().markRunningJobsAsInterrupted()
  }

  public hasActiveJob(): boolean {
    return this.isStarting || this.activeJobId !== null
  }

  public getActiveExportJob(): ExportJobRecord | null {
    if (!this.activeJobId) {
      return null
    }
    return this.catalog.getExportRepository().getExportJob(this.activeJobId)
  }

  public listExportJobs(options?: ListExportJobsOptions): PaginatedExportResult<ExportJobRecord> {
    return this.catalog.getExportRepository().listExportJobs(options)
  }

  public getExportJob(jobId: string): ExportJobRecord | null {
    return this.catalog.getExportRepository().getExportJob(jobId)
  }

  public getExportJobItems(
    jobId: string,
    options?: ListExportJobItemsOptions
  ): PaginatedExportResult<ExportJobItemRecord> {
    return this.catalog.getExportRepository().getExportJobItems(jobId, options)
  }

  public verifyExportJob(jobId: string): ExportJobRecord | null {
    return this.catalog.getExportRepository().verifyExportJobBundleOnDisk(jobId)
  }

  public onProgress(listener: (job: ExportJobRecord) => void): () => void {
    this.events.on('progress', listener)
    return () => {
      this.events.off('progress', listener)
    }
  }

  private emitProgress(job: ExportJobRecord): void {
    this.events.emit('progress', job)
  }

  public async waitForCompletion(): Promise<ExportJobRecord | null> {
    if (this.completionPromise) {
      return await this.completionPromise
    }
    return null
  }

  public cancelExport(jobId: string): boolean {
    if (!this.activeJobId || this.activeJobId !== jobId || !this.abortController) {
      return false
    }
    this.abortController.abort()
    return true
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    if (this.abortController) {
      this.abortController.abort()
    }
    if (this.completionPromise) {
      try {
        await this.completionPromise
      } catch {
        // Ignore shutdown errors from aborted export
      }
    }
  }

  public startExport(input: StartExportInput): ExportJobRecord {
    if (this.isShutdown) {
      throw new Error('ExportCoordinator is shut down')
    }
    if (this.hasActiveJob()) {
      throw new Error('An export job is already running')
    }

    this.isStarting = true
    try {
      const privacyOptions = ExportPrivacyOptionsSchema.parse(input.privacyOptions ?? {})
      const sourceRoots = this.catalog.listSources({ limit: 1000 }).items.map((s) => s.rootPath)
      const activeVault = this.catalog.getActiveVault()
      const vaultPath = activeVault?.vaultPath ?? null
      const vaultRoots = vaultPath ? [vaultPath] : []

      const { bundleDir } = validateExportParentAndBundlePath({
        parentDir: input.parentDir,
        bundleFolderName: input.bundleFolderName,
        sourceRoots,
        vaultRoots,
        userDataDir: this.userDataDir
      })

      if (existsSync(bundleDir)) {
        throw new Error(`Export destination folder already exists: ${input.bundleFolderName}`)
      }

      const items = this.resolveExportItems(
        input.fileLocationIds,
        activeVault?.vaultId ?? null,
        privacyOptions
      )

      const exportJobId = `export-${randomUUID()}`
      const repo = this.catalog.getExportRepository()
      const createdJob = repo.createExportJob({
        id: exportJobId,
        bundleDir,
        bundleFolderName: input.bundleFolderName,
        privacyOptions,
        items: items.map((item) => ({
          fileLocationId: item.fileLocationId,
          discoveryObservationId: item.discoveryObservationId,
          hashObservationId: item.hashObservationId,
          category: item.category,
          originalFileName: item.fileName,
          expectedSha256: item.expectedSha256,
          expectedByteSize: item.recordedFacts.byteSize
        }))
      })

      const controller = new AbortController()
      this.activeJobId = exportJobId
      this.abortController = controller
      this.emitProgress(createdJob)

      this.completionPromise = this.executeExportJob({
        exportJobId,
        bundleDir,
        parentDir: input.parentDir,
        bundleFolderName: input.bundleFolderName,
        sourceRoots,
        vaultRoots,
        vaultPath,
        privacyOptions,
        items,
        signal: controller.signal,
        hooks: input.hooks
      })

      return createdJob
    } finally {
      this.isStarting = false
    }
  }

  private async executeExportJob(params: {
    readonly exportJobId: string
    readonly bundleDir: string
    readonly parentDir: string
    readonly bundleFolderName: string
    readonly sourceRoots: readonly string[]
    readonly vaultRoots: readonly string[]
    readonly vaultPath: string | null
    readonly privacyOptions: ExportPrivacyOptions
    readonly items: readonly ExportItemInput[]
    readonly signal: AbortSignal
    readonly hooks?: ExportTestHooks
  }): Promise<ExportJobRecord | null> {
    const repo = this.catalog.getExportRepository()
    try {
      const result = await exportBundle(
        {
          exportJobId: params.exportJobId,
          parentDir: params.parentDir,
          bundleFolderName: params.bundleFolderName,
          sourceRoots: params.sourceRoots,
          vaultRoots: params.vaultRoots,
          userDataDir: this.userDataDir,
          vaultPath: params.vaultPath,
          appVersion: this.appVersion,
          privacyOptions: params.privacyOptions,
          items: params.items,
          signal: params.signal
        },
        params.hooks
      )
      const finalized = repo.finalizeExportJob({ result })
      this.emitProgress(finalized)
      return finalized
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Export failed unexpectedly'
      try {
        if (!this.catalog.isClosed()) {
          repo.failRunningExportJob({
            jobId: params.exportJobId,
            bundleDir: join(params.parentDir, params.bundleFolderName),
            errorMessage: message
          })
          const failed = repo.getExportJob(params.exportJobId)
          if (failed) {
            this.emitProgress(failed)
          }
          return failed
        }
      } catch {
        // Ignore persistence errors during shutdown
      }
      return null
    } finally {
      if (this.activeJobId === params.exportJobId) {
        this.activeJobId = null
        this.abortController = null
        this.completionPromise = null
      }
    }
  }

  private resolveExportItems(
    fileLocationIds: readonly number[],
    activeVaultId: string | null,
    privacyOptions: ExportPrivacyOptions
  ): ExportItemInput[] {
    const seen = new Set<number>()
    const db = this.catalog.getRawDb()
    const resolved: ExportItemInput[] = []

    const hashStmt = db.prepare(
      'SELECT id FROM hash_observations WHERE discovery_observation_id = ? AND is_active = 1 LIMIT 1;'
    )
    const vaultCopyStmt = db.prepare(
      'SELECT relative_path, sha256, byte_size FROM vault_copies WHERE vault_id = ? AND sha256 = ? AND byte_size = ? LIMIT 1;'
    )
    const dupReviewStmt = db.prepare(
      'SELECT status, preferred_location_id FROM duplicate_reviews WHERE sha256 = ? AND byte_size = ? LIMIT 1;'
    )
    const docOverrideStmt = db.prepare(
      `SELECT purpose_labels_json, origin_labels_json, clutter_override, override_version, updated_at_ms
       FROM document_classification_overrides
       WHERE file_location_id = ? AND discovery_observation_id = ? AND is_current = 1
       LIMIT 1;`
    )

    for (const fileLocationId of fileLocationIds) {
      if (seen.has(fileLocationId)) {
        throw new Error(`Duplicate fileLocationId ${fileLocationId} in export request`)
      }
      seen.add(fileLocationId)

      const file = this.catalog.getFileLocationById(fileLocationId)
      if (!file) {
        throw new Error(`Catalog item not found: ${fileLocationId}`)
      }
      if (!file.activeHash || file.activeHashVerifiedAtMs === null) {
        throw new Error(`Catalog item ${fileLocationId} (${file.fileName}) has not been hashed`)
      }

      const hashRow = hashStmt.get(file.discoveryObservationId) as { id: number } | undefined
      if (!hashRow) {
        throw new Error(`Active hash observation missing for catalog item ${fileLocationId}`)
      }

      let vaultCopy: ExportVaultCopyRef | null = null
      if (activeVaultId) {
        const vcRow = vaultCopyStmt.get(activeVaultId, file.activeHash, file.byteSize) as
          { relative_path: string; sha256: string; byte_size: number } | undefined
        if (vcRow) {
          vaultCopy = {
            relativePath: vcRow.relative_path,
            verifiedSha256: vcRow.sha256,
            verifiedByteSize: Number(vcRow.byte_size)
          }
        }
      }

      const dupRow = dupReviewStmt.get(file.activeHash, file.byteSize) as
        { status: 'reviewed' | 'unreviewed'; preferred_location_id: number | null } | undefined
      const duplicateReview = dupRow
        ? {
            status: dupRow.status,
            isPreferredLocation: dupRow.preferred_location_id === fileLocationId
          }
        : null

      if (file.category === 'photo') {
        resolved.push({
          fileLocationId,
          discoveryObservationId: file.discoveryObservationId,
          hashObservationId: hashRow.id,
          originalPath: file.originalPath,
          fileName: file.fileName,
          extension: file.extension,
          category: 'photo',
          recordedFacts: {
            byteSize: file.byteSize,
            filesystemBirthtimeMs: file.filesystemBirthtimeMs,
            filesystemMtimeMs: file.filesystemMtimeMs,
            firstDiscoveredAtMs: file.firstDiscoveredAtMs,
            lastSeenAtMs: file.lastSeenAtMs,
            hashVerifiedAtMs: file.activeHashVerifiedAtMs
          },
          expectedSha256: file.activeHash,
          vaultCopy,
          machineGenerated: this.buildPhotoMachineGenerated(fileLocationId),
          userOverridesAndAnnotations: this.buildPhotoUserAnnotations(
            fileLocationId,
            file.rating ?? null,
            file.flag ?? null,
            duplicateReview
          )
        })
      } else {
        const docDetail = this.catalog.getDocumentDetail(fileLocationId)
        const docPreview = privacyOptions.includeExtractedText
          ? this.catalog.getDocumentRepository().getDocumentPreview(fileLocationId)
          : null
        const ocrState = this.catalog.getDocumentOcrRepository().getDocumentOcrState(fileLocationId)
        const ocrPreview = privacyOptions.includeExtractedText
          ? this.catalog.getDocumentOcrRepository().getDocumentOcrPreview(fileLocationId)
          : null

        const machineGenerated: ExportDocumentMachineGeneratedInput = {
          kind: 'document',
          nativeExtraction: {
            status: docDetail?.extractionStatus ?? 'unprocessed',
            recipeVersion: docDetail?.recipeVersion ?? null,
            pageCount: docDetail?.pageCount ?? null,
            charCount: docDetail?.extractedCharCount ?? 0,
            truncated: docDetail?.extractionTruncated ?? false,
            text: docPreview?.extractedText ?? null
          },
          ocrExtraction: {
            status: ocrState?.ocrStatus ?? 'not_processed',
            method: ocrState?.extractionMethod ?? null,
            modelId: ocrState?.ocrModelId ?? null,
            language: ocrState?.ocrLanguage ?? null,
            meanConfidence: ocrState?.meanConfidence ?? null,
            truncated: ocrPreview?.previewTruncated ?? false,
            text: ocrPreview?.extractedText ?? null
          },
          automaticClassification:
            docDetail?.classification && docDetail.classification.isClassified
              ? {
                  ruleVersion:
                    docDetail.classification.machineRuleVersion ?? 'doc_classify_rules_v1',
                  textSourceKind: docDetail.classification.machineTextSourceKind ?? 'none',
                  purposeStatus: docDetail.classification.machinePurposeStatus,
                  purposeLabels: docDetail.classification.machinePurposeLabels,
                  originStatus: docDetail.classification.machineOriginStatus,
                  originLabels: docDetail.classification.machineOriginLabels,
                  confidenceBand: docDetail.classification.confidenceBand,
                  isClutterCandidate: docDetail.classification.isClutterCandidate,
                  uncertaintyReasons: docDetail.classification.uncertaintyReasons
                }
              : null
        }

        const cls = docDetail?.classification
        const overrideRow =
          cls && cls.hasOverride
            ? (docOverrideStmt.get(fileLocationId, file.discoveryObservationId) as
                | {
                    purpose_labels_json: string | null
                    origin_labels_json: string | null
                    clutter_override: 'inherit' | 'force_keep' | 'force_clutter'
                    override_version: number
                    updated_at_ms: number
                  }
                | undefined)
            : undefined
        const parseNullableStringArray = (raw: string | null): string[] | null => {
          if (raw === null) return null
          const parsed = JSON.parse(raw) as unknown
          return Array.isArray(parsed)
            ? parsed.filter((item): item is string => typeof item === 'string')
            : null
        }

        const userOverridesAndAnnotations: ExportDocumentUserOverridesInput = {
          kind: 'document',
          classificationOverride: overrideRow
            ? {
                purposeLabels: parseNullableStringArray(overrideRow.purpose_labels_json),
                originLabels: parseNullableStringArray(overrideRow.origin_labels_json),
                clutterOverride: overrideRow.clutter_override,
                overrideVersion: Number(overrideRow.override_version),
                updatedAtMs: Number(overrideRow.updated_at_ms)
              }
            : null,
          effectiveClassification: cls
            ? {
                purposeLabels: cls.effectivePurposeLabels,
                originLabels: cls.effectiveOriginLabels,
                isClutter: cls.effectiveIsClutter,
                resolvedFrom: cls.hasOverride
                  ? 'user_override'
                  : cls.isClassified
                    ? 'automatic_classifier'
                    : 'unclassified'
              }
            : {
                purposeLabels: [],
                originLabels: [],
                isClutter: false,
                resolvedFrom: 'unclassified'
              },
          duplicateReview
        }

        resolved.push({
          fileLocationId,
          discoveryObservationId: file.discoveryObservationId,
          hashObservationId: hashRow.id,
          originalPath: file.originalPath,
          fileName: file.fileName,
          extension: file.extension,
          category: 'document',
          recordedFacts: {
            byteSize: file.byteSize,
            filesystemBirthtimeMs: file.filesystemBirthtimeMs,
            filesystemMtimeMs: file.filesystemMtimeMs,
            firstDiscoveredAtMs: file.firstDiscoveredAtMs,
            lastSeenAtMs: file.lastSeenAtMs,
            hashVerifiedAtMs: file.activeHashVerifiedAtMs
          },
          expectedSha256: file.activeHash,
          vaultCopy,
          machineGenerated,
          userOverridesAndAnnotations
        })
      }
    }

    return resolved
  }

  private buildPhotoMachineGenerated(fileLocationId: number): ExportPhotoMachineGeneratedInput {
    const metaDetail = this.catalog.getPhotoTechnicalMetadataDetail(fileLocationId)
    const meta = metaDetail?.currentMetadata ?? null
    const dhash = this.catalog.getPhotoPerceptualHash(fileLocationId)

    return {
      kind: 'photo',
      metadataStatus:
        metaDetail?.effectiveStatus === 'extracted' ||
        metaDetail?.effectiveStatus === 'no_metadata' ||
        metaDetail?.effectiveStatus === 'unsupported' ||
        metaDetail?.effectiveStatus === 'failed'
          ? metaDetail.effectiveStatus
          : 'unprocessed',
      parserRecipeVersion: meta?.parserRecipeVersion ?? null,
      detectedFormat: meta?.detectedFormat ?? null,
      extensionFormatMismatch: meta?.extensionFormatMismatch ?? false,
      encodedWidthPx: meta?.encodedWidthPx ?? null,
      encodedHeightPx: meta?.encodedHeightPx ?? null,
      exifOrientation: meta?.exifOrientation ?? null,
      displayWidthPx: meta?.displayWidthPx ?? null,
      displayHeightPx: meta?.displayHeightPx ?? null,
      inferredCaptureDate: meta
        ? {
            sourceTag: meta.captureDateSourceTag,
            rawText: meta.rawCaptureDateText,
            localIso: meta.captureLocalIso,
            calendarDate: meta.captureCalendarDate,
            utcEpochMs: meta.captureUtcEpochMs,
            offsetText: meta.captureOffsetText,
            timezoneStatus: meta.captureTimezoneStatus
          }
        : null,
      cameraDisplay: meta?.cameraDisplay ?? null,
      lensDisplay: meta?.lensDisplay ?? null,
      dhash64: dhash?.fingerprint ?? null
    }
  }

  private buildPhotoUserAnnotations(
    fileLocationId: number,
    rating: number | null,
    flag: 'none' | 'pick' | 'reject' | null,
    duplicateReview: {
      readonly status: 'reviewed' | 'unreviewed'
      readonly isPreferredLocation: boolean
    } | null
  ): ExportPhotoUserAnnotationsInput {
    const collections = this.catalog
      .getCollectionMembershipsForPhoto({ fileLocationId, limit: 500 })
      .items.map((c) => c.collectionName)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)

    return {
      kind: 'photo',
      rating: rating ?? null,
      flag: flag ?? 'none',
      collections,
      duplicateReview
    }
  }
}
