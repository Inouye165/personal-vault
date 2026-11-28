/**
 * Personal Vault — Stage 8B Sub-slice 1B: Persistent Backup Coordinator
 *
 * Orchestrates durable local backups across restarts:
 * - Startup recovery (`initialize()`): transitions stale `capturing`/`running` jobs
 *   to `interrupted`, preserves `.backup-staging/<jobId>/` for `paused`/`interrupted`
 *   jobs, and cleans up terminal/orphaned staging directories.
 * - Pre-flight unavailable destination queueing (`queued_destination_unavailable`)
 *   with zero staging created.
 * - Mid-transfer disconnect pause (`paused`, `pauseReason: 'destination_unavailable'`)
 *   retaining staging and `.pv-snapshot-in-progress.json`.
 * - Resume with staging re-verification, snapshot directory ownership validation,
 *   destination chunk read-back re-verification, and `abandoned` fallback to a new
 *   `snapshotId` when staging is missing, corrupt, or non-reproducible.
 * - Capture-window serialization with `VaultImportCoordinator` via `AsyncCaptureGuard`.
 */

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { BackupSummaryDto } from '../../../shared/validation/backup-ipc-schemas'
import {
  BackupSnapshotCompleteMarkerV1Schema,
  BackupSnapshotManifestV1Schema,
  type BackupChunkRef,
  type BackupEncryptionKdfParams,
  type BackupEncryptionMode,
  type BackupSnapshotManifestV1
} from '../../../shared/validation/backup-schemas'
import { JournalSecurityError } from '../annotations/journal'
import type {
  BackupDestinationKind,
  BackupDestinationRecord,
  BackupJobRecord,
  BackupJobUnitRecord,
  ListBackupJobsOptions,
  PaginatedBackupResult
} from '../catalog/backup-repository'
import type { CatalogDatabase } from '../catalog/database'
import type { VaultImportCoordinator } from '../vault/coordinator'
import { AsyncCaptureGuard, type BackupCaptureGuard } from './capture-guard'
import { Aes256GcmObjectCodec } from './codec'
import { validateBackupDestinationPath } from './containment'
import {
  resumeBackupWithTransport,
  resumeLocalBackupFromStaging,
  runBackupWithTransport,
  runLocalBackup,
  verifyCapturedStagingIntegrity,
  type RunLocalBackupResult
} from './engine'
import {
  BackupContainmentError,
  BackupRestoreError,
  BackupSnapshotError,
  classifyBackupDestinationFsError
} from './errors'
import {
  createSqlDriveBandwidthMeter,
  createSqlDriveUploadStateStore,
  GoogleDriveTransport
} from './google-drive-transport'
import { TransferRateLimiter } from './rate-limiter'
import { verifyRecoveryPoint, verifyRemoteRecoveryPoint } from './restore'
import type { CaptureConsistentBackupSnapshotResult } from './snapshot-capture'
import {
  BACKUP_SNAPSHOT_COMPLETE_FILE,
  BACKUP_SNAPSHOT_ENCRYPTED_MANIFEST_FILE,
  BACKUP_SNAPSHOT_MANIFEST_FILE,
  BACKUP_SNAPSHOTS_DIR,
  type LocalBackupTestHooks
} from './transport'

export interface BackupCoordinatorGoogleDriveOptions {
  readonly rootFolderId?: string
  readonly getAccessToken: () => Promise<string> | string
  readonly fetchFn?: typeof fetch
  readonly apiBaseUrl?: string
  readonly uploadBaseUrl?: string
  readonly uploadChunkSizeBytes?: number
  readonly resumableThresholdBytes?: number
  readonly retryDelaysMs?: readonly number[]
  readonly nowMs?: () => number
  readonly isAvailable?: (dest: BackupDestinationRecord) => boolean
}

export interface BackupCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly userDataDir: string
  readonly appVersion: string
  readonly vaultImportCoordinator?: VaultImportCoordinator
  readonly captureGuard?: BackupCaptureGuard
  readonly workerScriptPath?: string
  readonly appPath?: string | null
  readonly isPackaged?: boolean
  readonly googleDrive?: BackupCoordinatorGoogleDriveOptions
  readonly recoverySecret?: string
  readonly getRecoverySecret?: (dest: BackupDestinationRecord) => string | undefined
  readonly kdfParams?: BackupEncryptionKdfParams
}

export interface ConfigureBackupDestinationInput {
  readonly name: string
  readonly kind: BackupDestinationKind
  readonly targetPath: string | null
  readonly maxBytesPerSecond?: number | null
  readonly dailyBudgetBytes?: number | null
  readonly encryptionMode?: BackupEncryptionMode
}

export interface StartBackupOptions {
  readonly snapshotId?: string
  readonly hooks?: LocalBackupTestHooks
  readonly recoverySecret?: string
  readonly kdfParams?: BackupEncryptionKdfParams
}

export interface BackupInitializeSummary {
  readonly interruptedCount: number
  readonly cleanedStagingDirs: readonly string[]
}

type AbortIntent = 'pause' | 'cancel' | 'shutdown' | null

function generateSnapshotId(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  return `${iso}_${randomUUID().slice(0, 8)}`
}

function collectManifestObjectIds(manifest: BackupSnapshotManifestV1): Set<string> {
  const ids = new Set<string>()
  for (const c of manifest.catalogFile.chunks) ids.add(c.objectId.toLowerCase())
  if (manifest.annotations) {
    for (const c of manifest.annotations.ownerMarkerFile.chunks) ids.add(c.objectId.toLowerCase())
    for (const c of manifest.annotations.journalFile.chunks) ids.add(c.objectId.toLowerCase())
  }
  if (manifest.vault) {
    for (const c of manifest.vault.identityFile.chunks) ids.add(c.objectId.toLowerCase())
    for (const copy of manifest.vault.copies) {
      for (const c of copy.payloadFile.chunks) ids.add(c.objectId.toLowerCase())
      for (const c of copy.manifestFile.chunks) ids.add(c.objectId.toLowerCase())
    }
  }
  return ids
}

export class BackupCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly userDataDir: string
  private readonly appVersion: string
  private readonly captureGuard: BackupCaptureGuard
  private readonly workerScriptPath?: string
  private readonly appPath?: string | null
  private readonly isPackaged?: boolean
  private readonly googleDrive?: BackupCoordinatorGoogleDriveOptions
  private readonly recoverySecret?: string
  private readonly getRecoverySecret?: (dest: BackupDestinationRecord) => string | undefined
  private readonly kdfParams?: BackupEncryptionKdfParams
  private readonly secretCache = new Map<string, string>()
  private readonly events = new EventEmitter()

  private activeJobId: string | null = null
  private abortController: AbortController | null = null
  private abortIntent: AbortIntent = null
  private completionPromise: Promise<BackupJobRecord | null> | null = null
  private activeCompletionPromise: Promise<BackupJobRecord | null> | null = null
  private isStarting = false
  private isShutdown = false
  private updateInstallPending = false

  public constructor(options: BackupCoordinatorOptions) {
    this.catalog = options.catalog
    this.userDataDir = options.userDataDir
    this.appVersion = options.appVersion
    this.captureGuard = options.captureGuard ?? new AsyncCaptureGuard()
    this.workerScriptPath = options.workerScriptPath
    this.appPath = options.appPath
    this.isPackaged = options.isPackaged
    this.googleDrive = options.googleDrive
    this.recoverySecret = options.recoverySecret
    this.getRecoverySecret = options.getRecoverySecret
    this.kdfParams = options.kdfParams

    if (options.vaultImportCoordinator) {
      options.vaultImportCoordinator.setCaptureGuard(this.captureGuard)
    }
  }

  public getCaptureGuard(): BackupCaptureGuard {
    return this.captureGuard
  }

  private getStagingRoot(): string {
    return join(this.userDataDir, '.backup-staging')
  }

  private getJobStagingDir(jobId: string): string {
    return join(this.getStagingRoot(), jobId)
  }

  private cleanupStagingDirBestEffort(stagingDir: string | null): void {
    if (!stagingDir) return
    try {
      if (existsSync(stagingDir)) {
        rmSync(stagingDir, { recursive: true, force: true })
      }
    } catch {
      // best-effort staging cleanup
    }
  }

  /**
   * Startup recovery:
   * - Transitions stale `capturing`/`running` jobs to `interrupted`.
   * - Preserves `.backup-staging/<jobId>/` for `paused` and `interrupted` jobs.
   * - Deletes staging directories only for terminal/queued jobs or orphaned dirs.
   */
  public initialize(): BackupInitializeSummary {
    const repo = this.catalog.getBackupRepository()
    const interruptedCount = repo.markRunningJobsAsInterrupted()

    const cleanedStagingDirs: string[] = []
    const stagingRoot = this.getStagingRoot()
    if (existsSync(stagingRoot)) {
      for (const entry of readdirSync(stagingRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const job = repo.getJob(entry.name)
        if (job && (job.status === 'paused' || job.status === 'interrupted')) {
          continue
        }
        const entryPath = join(stagingRoot, entry.name)
        try {
          rmSync(entryPath, { recursive: true, force: true })
          cleanedStagingDirs.push(entry.name)
        } catch {
          // ignore best-effort cleanup error
        }
      }
    }

    return { interruptedCount, cleanedStagingDirs }
  }

  public setUpdateInstallPending(pending: boolean): void {
    this.updateInstallPending = pending
  }

  public hasActiveJob(): boolean {
    return this.isStarting || this.activeJobId !== null
  }

  public isRunningJob(): boolean {
    return this.isStarting || this.activeJobId !== null || this.activeCompletionPromise !== null
  }

  public async waitForActiveJobToFinish(): Promise<void> {
    while (this.isRunningJob()) {
      if (this.activeCompletionPromise) {
        try {
          await this.activeCompletionPromise
        } catch {
          // Job state is persisted in SQLite.
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
  }

  public getActiveBackupJob(): BackupJobRecord | null {
    if (!this.activeJobId) return null
    return this.catalog.getBackupRepository().getJob(this.activeJobId)
  }

  public onProgress(listener: (job: BackupJobRecord) => void): () => void {
    this.events.on('progress', listener)
    return () => {
      this.events.off('progress', listener)
    }
  }

  private emitProgress(job: BackupJobRecord): void {
    this.events.emit('progress', job)
  }

  public async waitForCompletion(): Promise<BackupJobRecord | null> {
    if (this.completionPromise) {
      return await this.completionPromise
    }
    return null
  }

  // ---------------------------------------------------------------------------
  // Destination & Job Queries
  // ---------------------------------------------------------------------------

  public configureDestination(input: ConfigureBackupDestinationInput): BackupDestinationRecord {
    if (input.kind === 'local_fs' && !input.targetPath) {
      throw new BackupContainmentError('Local backup destination requires a non-empty targetPath')
    }
    if (input.kind === 'local_fs' && input.targetPath) {
      const { sourceRoots, vaultRoots } = this.getSourceAndVaultRoots()
      try {
        validateBackupDestinationPath({
          destinationDir: input.targetPath,
          sourceRoots,
          vaultRoots,
          userDataDir: this.userDataDir
        })
      } catch (err) {
        if (
          !(err instanceof JournalSecurityError) &&
          classifyBackupDestinationFsError(err) !== 'destination_unavailable'
        ) {
          throw err
        }
      }
    }
    const encryptionMode =
      input.encryptionMode ?? (input.kind === 'google_drive' ? 'aes-256-gcm-v1' : 'none')
    return this.catalog.getBackupRepository().createDestination({
      name: input.name,
      kind: input.kind,
      targetPath: input.targetPath,
      maxBytesPerSecond: input.maxBytesPerSecond,
      dailyBudgetBytes: input.dailyBudgetBytes,
      encryptionMode
    })
  }

  public getBackupSummary(): BackupSummaryDto {
    const activeVault = this.catalog.getActiveVault()
    const db = this.catalog.getRawDb()

    let vaultFileCount = 0
    let vaultBytes = 0
    if (activeVault) {
      const row = db
        .prepare(
          'SELECT COUNT(*) AS copy_count, COALESCE(SUM(byte_size), 0) AS total_bytes FROM vault_copies WHERE vault_id = ?;'
        )
        .get(activeVault.vaultId) as { copy_count: number; total_bytes: number } | undefined
      vaultFileCount = Number(row?.copy_count ?? 0)
      vaultBytes = Number(row?.total_bytes ?? 0)
    }

    const catalogedRow = db
      .prepare(
        `SELECT COUNT(DISTINCT fl.id) AS cnt
         FROM file_locations fl
         JOIN discovery_observations d
           ON d.file_location_id = fl.id
          AND d.is_current = 1;`
      )
      .get() as { cnt: number } | undefined
    const catalogedFileCount = Number(catalogedRow?.cnt ?? 0)

    const statSize = (filePath: string): number => {
      try {
        return existsSync(filePath) ? statSync(filePath).size : 0
      } catch {
        return 0
      }
    }

    const catalogPath = this.catalog.getCatalogPath()
    const catalogBytes =
      catalogPath !== ':memory:' ? statSize(catalogPath) + statSize(`${catalogPath}-wal`) : 0
    const annotationsDir = join(this.userDataDir, 'annotations')
    const annotationsBytes =
      statSize(join(annotationsDir, '.pv_annotations_owner')) +
      statSize(join(annotationsDir, 'review-journal.jsonl'))

    return {
      hasActiveVault: activeVault !== null,
      activeVaultId: activeVault?.vaultId ?? null,
      activeVaultName: activeVault?.name ?? null,
      activeVaultPath: activeVault?.vaultPath ?? null,
      vaultFileCount,
      vaultBytes,
      catalogBytes,
      annotationsBytes,
      estimatedTotalBytes: catalogBytes + annotationsBytes + vaultBytes,
      catalogedFileCount,
      isCatalogOnly: activeVault === null || vaultFileCount === 0
    }
  }

  public getDestination(id: string): BackupDestinationRecord | null {
    return this.catalog.getBackupRepository().getDestination(id)
  }

  public listDestinations(options?: { readonly enabledOnly?: boolean }): BackupDestinationRecord[] {
    return this.catalog.getBackupRepository().listDestinations(options)
  }

  public getJob(jobId: string): BackupJobRecord | null {
    return this.catalog.getBackupRepository().getJob(jobId)
  }

  public listJobs(options?: ListBackupJobsOptions): PaginatedBackupResult<BackupJobRecord> {
    return this.catalog.getBackupRepository().listJobs(options)
  }

  public getJobUnits(jobId: string): BackupJobUnitRecord[] {
    return this.catalog.getBackupRepository().listJobUnits(jobId)
  }

  // ---------------------------------------------------------------------------
  // Pre-flight & Execution
  // ---------------------------------------------------------------------------

  private getSourceAndVaultRoots(): { sourceRoots: string[]; vaultRoots: string[] } {
    const sourceRoots = this.catalog.getAllSourceRoots()
    const rows = this.catalog.getRawDb().prepare('SELECT vault_path FROM vaults').all() as Array<{
      vault_path: string
    }>
    const vaultRoots = rows.map((r) => r.vault_path)
    return { sourceRoots, vaultRoots }
  }

  private checkDestinationAvailable(dest: BackupDestinationRecord): boolean {
    if (dest.kind === 'google_drive') {
      if (!this.googleDrive) return false
      return this.googleDrive.isAvailable ? this.googleDrive.isAvailable(dest) : true
    }
    if (dest.kind !== 'local_fs' && dest.kind !== 'drive_for_desktop') {
      return false
    }
    if (!dest.targetPath) {
      return false
    }

    const { sourceRoots, vaultRoots } = this.getSourceAndVaultRoots()
    try {
      validateBackupDestinationPath({
        destinationDir: dest.targetPath,
        sourceRoots,
        vaultRoots,
        userDataDir: this.userDataDir
      })
    } catch (err) {
      if (err instanceof JournalSecurityError) {
        return false
      }
      if (err instanceof BackupContainmentError) {
        throw err
      }
      if (classifyBackupDestinationFsError(err) === 'destination_unavailable') {
        return false
      }
      throw err
    }

    if (existsSync(dest.targetPath)) {
      try {
        accessSync(dest.targetPath, constants.R_OK | constants.W_OK)
        return true
      } catch (err) {
        if (classifyBackupDestinationFsError(err) === 'destination_unavailable') {
          return false
        }
        throw err
      }
    }

    // If this destination already has a repositoryId, its folder disappearing means
    // the drive/share was disconnected. If it has no repositoryId yet, require its
    // immediate parent directory (mount/share root) to exist.
    if (dest.repositoryId !== null) {
      return false
    }
    return existsSync(dirname(dest.targetPath))
  }

  private resolveRecoverySecret(
    dest: BackupDestinationRecord,
    overrideSecret?: string
  ): string | undefined {
    if (overrideSecret) {
      this.secretCache.set(dest.id, overrideSecret)
      return overrideSecret
    }
    return this.secretCache.get(dest.id) ?? this.getRecoverySecret?.(dest) ?? this.recoverySecret
  }

  private createGoogleDriveTransport(
    dest: BackupDestinationRecord,
    jobId: string,
    rateLimiter?: TransferRateLimiter,
    hooks?: LocalBackupTestHooks
  ): GoogleDriveTransport {
    if (!this.googleDrive) {
      throw new BackupSnapshotError(
        'destination_unavailable',
        'Google Drive transport is not configured on BackupCoordinator'
      )
    }
    const repo = this.catalog.getBackupRepository()
    const rootFolderId = dest.targetPath ?? this.googleDrive.rootFolderId
    if (!rootFolderId) {
      throw new BackupSnapshotError(
        'destination_unavailable',
        'Google Drive destination is missing a root folder ID'
      )
    }
    return new GoogleDriveTransport({
      rootFolderId,
      getAccessToken: this.googleDrive.getAccessToken,
      fetchFn: this.googleDrive.fetchFn,
      apiBaseUrl: this.googleDrive.apiBaseUrl,
      uploadBaseUrl: this.googleDrive.uploadBaseUrl,
      uploadChunkSizeBytes: this.googleDrive.uploadChunkSizeBytes,
      resumableThresholdBytes: this.googleDrive.resumableThresholdBytes,
      retryDelaysMs: this.googleDrive.retryDelaysMs,
      rateLimiter,
      uploadStateStore: createSqlDriveUploadStateStore(repo, dest.id, jobId),
      bandwidthMeter: createSqlDriveBandwidthMeter(
        repo,
        dest.id,
        dest.dailyBudgetBytes,
        jobId,
        this.googleDrive.nowMs
      ),
      hooks
    })
  }

  public async startBackup(
    destinationId: string,
    options?: StartBackupOptions
  ): Promise<BackupJobRecord> {
    if (this.isShutdown) {
      throw new Error('BackupCoordinator has been shut down')
    }
    if (this.updateInstallPending) {
      throw new Error('Cannot start backup while an application update is installing')
    }
    if (this.hasActiveJob()) {
      throw new Error('A backup job is already active or starting')
    }

    const repo = this.catalog.getBackupRepository()
    const dest = repo.getDestination(destinationId)
    if (!dest) {
      throw new Error(`Backup destination "${destinationId}" not found`)
    }
    if (!dest.isEnabled) {
      throw new Error(`Backup destination "${dest.name}" is disabled`)
    }

    const snapshotId = options?.snapshotId ?? generateSnapshotId()
    const available = this.checkDestinationAvailable(dest)
    if (!available) {
      const queued = repo.createJob({
        destinationId: dest.id,
        snapshotId,
        repositoryId: dest.repositoryId,
        status: 'queued_destination_unavailable',
        pauseReason: 'destination_unavailable',
        stagingDir: null
      })
      this.emitProgress(queued)
      return queued
    }

    this.isStarting = true
    try {
      const jobId = randomUUID()
      const stagingDir = this.getJobStagingDir(jobId)
      const job = repo.createJob({
        id: jobId,
        destinationId: dest.id,
        snapshotId,
        repositoryId: dest.repositoryId,
        status: 'capturing',
        stagingDir,
        startedAtMs: Date.now()
      })

      this.launchBackgroundJob(job, dest, null, options)
      return job
    } finally {
      this.isStarting = false
    }
  }

  private async tryReconcileCompletedBackupOnDisk(
    job: BackupJobRecord,
    dest: BackupDestinationRecord,
    options?: StartBackupOptions
  ): Promise<BackupJobRecord | null> {
    if (job.repositoryId === null) {
      return null
    }
    if (dest.repositoryId !== null && dest.repositoryId !== job.repositoryId) {
      return null
    }

    const repo = this.catalog.getBackupRepository()
    if (repo.hasCompletedJobForSnapshot(dest.id, job.snapshotId, job.id)) {
      return null
    }

    let verified
    let completeMarker
    let manifest
    let pendingRemoteInProgressClear: (() => Promise<void>) | null = null
    if (dest.kind === 'google_drive') {
      try {
        const transport = this.createGoogleDriveTransport(dest, job.id)
        const recoverySecret = this.resolveRecoverySecret(dest, options?.recoverySecret)
        const hasInProgress = await transport.hasSnapshotInProgress(job.snapshotId)
        if (hasInProgress) {
          const inProgressMarker = await transport.readSnapshotInProgressMarker(job.snapshotId)
          if (
            !inProgressMarker ||
            inProgressMarker.jobId !== job.id ||
            inProgressMarker.snapshotId !== job.snapshotId ||
            inProgressMarker.repositoryId !== job.repositoryId
          ) {
            return null
          }
        }
        verified = await verifyRemoteRecoveryPoint({
          transport,
          snapshotId: job.snapshotId,
          recoverySecret,
          allowInProgressMarker: hasInProgress
        })
        completeMarker = await transport.readSnapshotCompleteMarker(job.snapshotId)
        if (!completeMarker) {
          return null
        }
        const repositoryIdentity = await transport.readRepositoryIdentity()
        if (!repositoryIdentity) {
          return null
        }
        const manifestFileName =
          repositoryIdentity.encryptionMode === 'aes-256-gcm-v1'
            ? BACKUP_SNAPSHOT_ENCRYPTED_MANIFEST_FILE
            : BACKUP_SNAPSHOT_MANIFEST_FILE
        const storedManifestBytes = await transport.readSnapshotManifest(
          job.snapshotId,
          undefined,
          manifestFileName
        )
        if (!storedManifestBytes) {
          return null
        }
        let plaintextManifestBytes = storedManifestBytes
        if (repositoryIdentity.encryptionMode === 'aes-256-gcm-v1') {
          const codec = await Aes256GcmObjectCodec.unlockFromRepository({
            repositoryId: repositoryIdentity.repositoryId,
            encryption: repositoryIdentity.encryption,
            recoverySecret,
            errorDomain: 'restore'
          })
          plaintextManifestBytes = await codec.decodeManifest(storedManifestBytes, job.snapshotId)
        }
        manifest = BackupSnapshotManifestV1Schema.parse(
          JSON.parse(plaintextManifestBytes.toString('utf8'))
        )
        if (hasInProgress) {
          pendingRemoteInProgressClear = async () => {
            await transport.removeSnapshotInProgress(job.snapshotId)
            await verifyRemoteRecoveryPoint({
              transport,
              snapshotId: job.snapshotId,
              recoverySecret
            })
          }
        }
      } catch (err) {
        if (
          (err instanceof BackupSnapshotError || err instanceof BackupRestoreError) &&
          (err.code === 'recovery_secret_required' || err.code === 'wrong_recovery_secret')
        ) {
          throw err
        }
        return null
      }
    } else {
      if (!dest.targetPath) {
        return null
      }
      try {
        verified = await verifyRecoveryPoint({
          backupRepoDir: dest.targetPath,
          snapshotId: job.snapshotId,
          recoverySecret: this.resolveRecoverySecret(dest, options?.recoverySecret)
        })
        const snapDir = join(dest.targetPath, BACKUP_SNAPSHOTS_DIR, job.snapshotId)
        completeMarker = BackupSnapshotCompleteMarkerV1Schema.parse(
          JSON.parse(readFileSync(join(snapDir, BACKUP_SNAPSHOT_COMPLETE_FILE), 'utf8'))
        )
        manifest = BackupSnapshotManifestV1Schema.parse(
          JSON.parse(readFileSync(join(snapDir, BACKUP_SNAPSHOT_MANIFEST_FILE), 'utf8'))
        )
      } catch (err) {
        if (
          (err instanceof BackupSnapshotError || err instanceof BackupRestoreError) &&
          (err.code === 'recovery_secret_required' || err.code === 'wrong_recovery_secret')
        ) {
          throw err
        }
        return null
      }
    }

    if (
      verified.repositoryId !== job.repositoryId ||
      completeMarker.repositoryId !== job.repositoryId ||
      completeMarker.snapshotId !== job.snapshotId ||
      manifest.snapshotId !== job.snapshotId
    ) {
      return null
    }

    const chunkUnits = repo
      .listJobUnits(job.id)
      .filter((u) => u.unitKind === 'chunk')
      .map((u) => u.objectId.toLowerCase())
    if (chunkUnits.length === 0) {
      return null
    }

    const manifestObjectIds = collectManifestObjectIds(manifest)
    const unitSet = new Set(chunkUnits)
    for (const unitId of unitSet) {
      if (!manifestObjectIds.has(unitId)) {
        return null
      }
    }
    for (const catalogChunk of manifest.catalogFile.chunks) {
      if (!unitSet.has(catalogChunk.objectId.toLowerCase())) {
        return null
      }
    }

    if (pendingRemoteInProgressClear) {
      try {
        await pendingRemoteInProgressClear()
      } catch {
        return null
      }
    }

    const reconciled = repo.completeJobAndUpdateDestinationAtomically({
      jobId: job.id,
      destinationId: dest.id,
      repositoryId: verified.repositoryId,
      snapshotId: job.snapshotId,
      verificationScope: completeMarker.verificationScope,
      totalObjectCount: completeMarker.totalObjectCount,
      totalLogicalBytes: completeMarker.totalLogicalBytes,
      totalStoredBytes: completeMarker.totalStoredBytes,
      manifestSha256: completeMarker.manifestSha256,
      completedAtMs: completeMarker.completedAtMs
    })

    this.cleanupStagingDirBestEffort(job.stagingDir ?? this.getJobStagingDir(job.id))
    this.emitProgress(reconciled)
    return reconciled
  }

  public async resumeBackup(jobId: string, options?: StartBackupOptions): Promise<BackupJobRecord> {
    if (this.isShutdown) {
      throw new Error('BackupCoordinator has been shut down')
    }
    if (this.updateInstallPending) {
      throw new Error('Cannot resume backup while an application update is installing')
    }
    if (this.hasActiveJob()) {
      throw new Error('A backup job is already active or starting')
    }

    const repo = this.catalog.getBackupRepository()
    const job = repo.getJob(jobId)
    if (!job) {
      throw new Error(`Backup job "${jobId}" not found`)
    }
    if (job.status === 'completed') {
      return job
    }
    if (
      job.status !== 'queued_destination_unavailable' &&
      job.status !== 'paused' &&
      job.status !== 'interrupted'
    ) {
      throw new Error(`Backup job "${jobId}" cannot be resumed from status "${job.status}"`)
    }

    const dest = repo.getDestination(job.destinationId)
    if (!dest) {
      throw new Error(`Backup destination "${job.destinationId}" not found`)
    }

    if (!this.checkDestinationAvailable(dest)) {
      if (job.status === 'queued_destination_unavailable') {
        return job
      }
      const stillPaused = repo.updateJobState(job.id, {
        status: 'paused',
        pauseReason: 'destination_unavailable'
      })
      this.emitProgress(stillPaused)
      return stillPaused
    }

    if (job.status === 'paused' || job.status === 'interrupted') {
      try {
        const reconciled = await this.tryReconcileCompletedBackupOnDisk(job, dest, options)
        if (reconciled) {
          return reconciled
        }
      } catch (err) {
        if (
          (err instanceof BackupSnapshotError || err instanceof BackupRestoreError) &&
          (err.code === 'recovery_secret_required' || err.code === 'wrong_recovery_secret')
        ) {
          this.secretCache.delete(dest.id)
          const paused = repo.updateJobState(job.id, {
            status: 'paused',
            pauseReason: job.pauseReason ?? 'user_paused',
            errorCode: err.code,
            errorMessage: err.message
          })
          this.emitProgress(paused)
          return paused
        }
        throw err
      }
    }

    this.isStarting = true
    try {
      if (job.status === 'queued_destination_unavailable') {
        const stagingDir = this.getJobStagingDir(job.id)
        const updated = repo.updateJobState(job.id, {
          status: 'capturing',
          pauseReason: null,
          stagingDir,
          startedAtMs: job.startedAtMs ?? Date.now(),
          errorCode: null,
          errorMessage: null
        })
        this.launchBackgroundJob(updated, dest, null, options)
        return updated
      }

      // Paused or interrupted job: re-verify captured staging inputs before resuming
      const stagingDir = job.stagingDir ?? this.getJobStagingDir(job.id)
      const { sourceRoots, vaultRoots } = this.getSourceAndVaultRoots()
      try {
        const verifiedStaging = await verifyCapturedStagingIntegrity({
          jobId: job.id,
          snapshotId: job.snapshotId,
          stagingDir,
          userDataDir: this.userDataDir,
          sourceRoots,
          vaultRoots
        })
        const runningJob = repo.updateJobState(job.id, {
          status: 'running',
          pauseReason: null,
          errorCode: null,
          errorMessage: null
        })
        this.launchBackgroundJob(runningJob, dest, verifiedStaging, options)
        return runningJob
      } catch (err) {
        // T5c: captured inputs missing, corrupt, or non-reproducible -> abandon & recapture under new snapshotId
        const message = err instanceof Error ? err.message : String(err)
        repo.updateJobState(job.id, {
          status: 'abandoned',
          pauseReason: null,
          errorCode: err instanceof BackupSnapshotError ? err.code : 'backup_staging_error',
          errorMessage: `Staging verification failed; abandoned for fresh snapshot: ${message}`,
          completedAtMs: Date.now()
        })
        this.cleanupStagingDirBestEffort(stagingDir)

        const newJobId = randomUUID()
        const newSnapshotId = options?.snapshotId ?? generateSnapshotId()
        const newStagingDir = this.getJobStagingDir(newJobId)
        const replacement = repo.createJob({
          id: newJobId,
          destinationId: dest.id,
          snapshotId: newSnapshotId,
          repositoryId: dest.repositoryId,
          status: 'capturing',
          stagingDir: newStagingDir,
          abandonedFromJobId: job.id,
          startedAtMs: Date.now()
        })
        this.launchBackgroundJob(replacement, dest, null, options)
        return replacement
      }
    } finally {
      this.isStarting = false
    }
  }

  private launchBackgroundJob(
    job: BackupJobRecord,
    dest: BackupDestinationRecord,
    verifiedStaging: CaptureConsistentBackupSnapshotResult | null,
    options?: StartBackupOptions
  ): void {
    this.activeJobId = job.id
    this.abortController = new AbortController()
    this.abortIntent = null
    this.emitProgress(job)

    const pipelinePromise = this.executeJobPipeline(
      job,
      dest,
      verifiedStaging,
      this.abortController.signal,
      options
    )
    this.completionPromise = pipelinePromise
    this.activeCompletionPromise = pipelinePromise
    const clearActiveCompletion = () => {
      if (this.activeCompletionPromise === pipelinePromise) {
        this.activeCompletionPromise = null
      }
    }
    void pipelinePromise.then(clearActiveCompletion, clearActiveCompletion)
  }

  private async executeJobPipeline(
    initialJob: BackupJobRecord,
    dest: BackupDestinationRecord,
    verifiedStaging: CaptureConsistentBackupSnapshotResult | null,
    signal: AbortSignal,
    options?: StartBackupOptions
  ): Promise<BackupJobRecord | null> {
    const repo = this.catalog.getBackupRepository()
    const { sourceRoots, vaultRoots } = this.getSourceAndVaultRoots()
    const rateLimiter = new TransferRateLimiter({
      maxBytesPerSecond: dest.maxBytesPerSecond
    })
    const verifiedChunkIds = new Set<string>()
    let writtenChunks = 0
    let reusedChunks = 0
    let transferredBytes = 0

    let result: RunLocalBackupResult
    try {
      const recoverySecret = this.resolveRecoverySecret(dest, options?.recoverySecret)
      const kdfParams = options?.kdfParams ?? this.kdfParams
      const hooks = options?.hooks
      const sharedOptions = {
        jobId: initialJob.id,
        snapshotId: initialJob.snapshotId,
        catalogPath: this.catalog.getCatalogPath(),
        annotationsDir: join(this.userDataDir, 'annotations'),
        userDataDir: this.userDataDir,
        sourceRoots,
        vaultRoots,
        appVersion: this.appVersion,
        rateLimiter,
        encryptionMode: dest.encryptionMode,
        recoverySecret,
        kdfParams,
        signal,
        workerScriptPath: this.workerScriptPath,
        appPath: this.appPath,
        isPackaged: this.isPackaged,
        onRepositoryResolved: (repositoryId: string) => {
          repo.updateJobState(initialJob.id, { repositoryId })
          if (dest.repositoryId !== repositoryId) {
            repo.updateDestination(dest.id, { repositoryId })
          }
        },
        onChunkVerified: (chunk: BackupChunkRef, action: 'written' | 'reused') => {
          if (!verifiedChunkIds.has(chunk.objectId)) {
            verifiedChunkIds.add(chunk.objectId)
            if (action === 'written') {
              writtenChunks += 1
              transferredBytes += chunk.storedByteSize
            } else {
              reusedChunks += 1
            }
          }
          repo.upsertJobUnit({
            jobId: initialJob.id,
            unitKind: 'chunk',
            objectId: chunk.objectId,
            plaintextSha256: chunk.plaintextSha256,
            plaintextByteSize: chunk.plaintextByteSize,
            storedByteSize: chunk.storedByteSize,
            status: action === 'reused' ? 'reused' : 'verified'
          })
          repo.upsertDestinationObject({
            destinationId: dest.id,
            objectId: chunk.objectId,
            storedByteSize: chunk.storedByteSize,
            plaintextSha256: chunk.plaintextSha256,
            lastSnapshotId: initialJob.snapshotId
          })
          const progress = repo.updateJobState(initialJob.id, {
            completedObjectCount: verifiedChunkIds.size,
            writtenChunkCount: writtenChunks,
            reusedChunkCount: reusedChunks,
            transferredBytes
          })
          this.emitProgress(progress)
        }
      }

      if (dest.kind === 'google_drive') {
        const transport = this.createGoogleDriveTransport(dest, initialJob.id, rateLimiter, hooks)
        if (verifiedStaging) {
          result = await resumeBackupWithTransport({ ...sharedOptions, transport }, verifiedStaging)
        } else {
          const runningJob = repo.updateJobState(initialJob.id, { status: 'running' })
          this.emitProgress(runningJob)
          result = await this.captureGuard.runExclusive(() =>
            runBackupWithTransport({ ...sharedOptions, transport }, hooks)
          )
        }
      } else {
        const localOptions = {
          ...sharedOptions,
          backupRepoDir: dest.targetPath!
        }
        if (verifiedStaging) {
          result = await resumeLocalBackupFromStaging(localOptions, verifiedStaging, hooks)
        } else {
          const runningJob = repo.updateJobState(initialJob.id, { status: 'running' })
          this.emitProgress(runningJob)
          result = await this.captureGuard.runExclusive(() => runLocalBackup(localOptions, hooks))
        }
      }
    } catch (err) {
      const intent = this.abortIntent
      if (intent === 'pause') {
        const paused = repo.updateJobState(initialJob.id, {
          status: 'paused',
          pauseReason: 'user_paused'
        })
        this.emitProgress(paused)
        return paused
      }
      if (intent === 'shutdown') {
        const interrupted = repo.updateJobState(initialJob.id, {
          status: 'interrupted'
        })
        this.emitProgress(interrupted)
        return interrupted
      }
      if (intent === 'cancel') {
        this.cleanupStagingDirBestEffort(initialJob.stagingDir)
        const cancelled = repo.updateJobState(initialJob.id, {
          status: 'cancelled',
          errorCode: 'backup_cancelled',
          errorMessage: 'Backup cancelled by user',
          completedAtMs: Date.now()
        })
        this.emitProgress(cancelled)
        return cancelled
      }

      const classifiedCode =
        err instanceof BackupSnapshotError || err instanceof BackupRestoreError
          ? err.code
          : classifyBackupDestinationFsError(err)
      const message = err instanceof Error ? err.message : String(err)

      if (
        classifiedCode === 'recovery_secret_required' ||
        classifiedCode === 'wrong_recovery_secret'
      ) {
        this.secretCache.delete(dest.id)
        const paused = repo.updateJobState(initialJob.id, {
          status: 'paused',
          pauseReason: 'user_paused',
          errorCode: classifiedCode,
          errorMessage: message
        })
        this.emitProgress(paused)
        return paused
      }

      if (classifiedCode === 'destination_unavailable') {
        const paused = repo.updateJobState(initialJob.id, {
          status: 'paused',
          pauseReason: 'destination_unavailable',
          errorCode: 'destination_unavailable',
          errorMessage: message
        })
        this.emitProgress(paused)
        return paused
      }

      if (classifiedCode === 'daily_budget_exhausted') {
        const paused = repo.updateJobState(initialJob.id, {
          status: 'paused',
          pauseReason: 'daily_budget_exhausted',
          errorCode: 'daily_budget_exhausted',
          errorMessage: message
        })
        this.emitProgress(paused)
        return paused
      }

      if (classifiedCode === 'destination_access_denied') {
        const paused = repo.updateJobState(initialJob.id, {
          status: 'paused',
          pauseReason: 'destination_unavailable',
          errorCode: 'destination_access_denied',
          errorMessage: message
        })
        this.emitProgress(paused)
        return paused
      }

      this.cleanupStagingDirBestEffort(initialJob.stagingDir)
      const failed = repo.updateJobState(initialJob.id, {
        status: 'failed',
        errorCode: classifiedCode,
        errorMessage: message,
        completedAtMs: Date.now()
      })
      this.emitProgress(failed)
      return failed
    } finally {
      this.activeJobId = null
      this.abortController = null
      this.abortIntent = null
    }

    const completed = repo.completeJobAndUpdateDestinationAtomically({
      jobId: initialJob.id,
      destinationId: dest.id,
      repositoryId: result.repositoryId,
      snapshotId: result.snapshotId,
      verificationScope: result.verificationScope,
      totalObjectCount: result.totalObjectCount,
      writtenChunkCount: result.writtenChunkCount,
      reusedChunkCount: result.reusedChunkCount,
      totalLogicalBytes: result.totalLogicalBytes,
      totalStoredBytes: result.totalStoredBytes,
      manifestSha256: result.manifestSha256,
      completedAtMs: Date.now()
    })
    this.emitProgress(completed)
    return completed
  }

  public pauseBackup(jobId: string): boolean {
    if (!this.activeJobId || this.activeJobId !== jobId || !this.abortController) {
      return false
    }
    this.abortIntent = 'pause'
    this.abortController.abort()
    return true
  }

  public cancelBackup(jobId: string): boolean {
    if (this.activeJobId === jobId && this.abortController) {
      this.abortIntent = 'cancel'
      this.abortController.abort()
      return true
    }

    const repo = this.catalog.getBackupRepository()
    const job = repo.getJob(jobId)
    if (
      job &&
      (job.status === 'queued_destination_unavailable' ||
        job.status === 'paused' ||
        job.status === 'interrupted')
    ) {
      this.cleanupStagingDirBestEffort(job.stagingDir)
      const cancelled = repo.updateJobState(job.id, {
        status: 'cancelled',
        pauseReason: null,
        errorCode: 'backup_cancelled',
        errorMessage: 'Backup cancelled by user',
        completedAtMs: Date.now()
      })
      this.emitProgress(cancelled)
      return true
    }
    return false
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    if (this.abortController) {
      this.abortIntent = 'shutdown'
      this.abortController.abort()
    }
    if (this.completionPromise) {
      try {
        await this.completionPromise
      } catch {
        // ignore shutdown errors from interrupted backup
      }
    }
  }
}
