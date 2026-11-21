/**
 * Personal Vault — Stage 8B Sub-slice 1A-2: Backup Transport & LocalFsTransport
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import {
  BackupRepositoryIdentityV1Schema,
  BackupSnapshotCompleteMarkerV1Schema,
  BackupSnapshotInProgressMarkerV1Schema,
  type BackupRepositoryIdentityV1,
  type BackupSnapshotCompleteMarkerV1,
  type BackupSnapshotInProgressMarkerV1
} from '../../../shared/validation/backup-schemas'
import { BackupSnapshotError, classifyBackupDestinationFsError } from './errors'
import { RATE_LIMIT_SLICE_BYTES, TransferRateLimiter } from './rate-limiter'

export const BACKUP_REPO_IDENTITY_FILE = 'repository.json'
export const BACKUP_TEMP_DIR = '.pv-backup-temp'
export const BACKUP_OBJECTS_DIR = 'objects'
export const BACKUP_SNAPSHOTS_DIR = 'snapshots'
export const BACKUP_SNAPSHOT_IN_PROGRESS_FILE = '.pv-snapshot-in-progress.json'
export const BACKUP_SNAPSHOT_MANIFEST_FILE = 'snapshot.json'
export const BACKUP_SNAPSHOT_ENCRYPTED_MANIFEST_FILE = 'snapshot.pvenc'
export const BACKUP_SNAPSHOT_COMPLETE_FILE = 'complete.json'

export interface LocalBackupTestHooks {
  readonly onAfterSnapshotCapture?: (snapshotId: string) => Promise<void> | void
  readonly onBeforeChunkWrite?: (objectId: string) => Promise<void> | void
  readonly onAfterChunkWrite?: (objectId: string) => Promise<void> | void
  readonly onBeforeSnapshotManifest?: (snapshotId: string) => Promise<void> | void
  readonly onBeforeCompleteMarker?: (snapshotId: string) => Promise<void> | void
}

export interface BackupTransport {
  ensureRepositoryLayout(): Promise<void>
  readRepositoryIdentity(): Promise<BackupRepositoryIdentityV1 | null>
  writeRepositoryIdentity(identity: BackupRepositoryIdentityV1, signal?: AbortSignal): Promise<void>
  statObject(objectId: string): Promise<{ exists: boolean; byteSize: number }>
  readObject(objectId: string, signal?: AbortSignal): Promise<Buffer>
  writeObjectAtomic(
    objectId: string,
    data: Buffer,
    jobId: string,
    options?: { readonly replaceIfCorrupt?: boolean; readonly signal?: AbortSignal }
  ): Promise<void>
  writeSnapshotInProgress(
    snapshotId: string,
    marker: BackupSnapshotInProgressMarkerV1,
    signal?: AbortSignal
  ): Promise<void>
  claimOrResumeSnapshotInProgress(
    snapshotId: string,
    marker: BackupSnapshotInProgressMarkerV1,
    signal?: AbortSignal
  ): Promise<void>
  removeSnapshotInProgress(snapshotId: string): Promise<void>
  writeSnapshotManifest(
    snapshotId: string,
    manifestBytes: Buffer,
    jobId: string,
    signal?: AbortSignal,
    fileName?: string
  ): Promise<void>
  readSnapshotManifest(
    snapshotId: string,
    signal?: AbortSignal,
    fileName?: string
  ): Promise<Buffer | null>
  writeSnapshotCompleteMarker(
    snapshotId: string,
    marker: BackupSnapshotCompleteMarkerV1,
    signal?: AbortSignal
  ): Promise<void>
  listSnapshotIds(): Promise<string[]>
  cleanupTempDir(): Promise<void>
}

export interface LocalFsTransportOptions {
  readonly repositoryDir: string
  readonly rateLimiter?: TransferRateLimiter
  readonly hooks?: LocalBackupTestHooks
}

export class LocalFsTransport implements BackupTransport {
  private readonly repositoryDir: string
  private readonly rateLimiter: TransferRateLimiter
  private readonly hooks?: LocalBackupTestHooks

  public constructor(options: LocalFsTransportOptions) {
    this.repositoryDir = options.repositoryDir
    this.rateLimiter = options.rateLimiter ?? new TransferRateLimiter({ maxBytesPerSecond: null })
    this.hooks = options.hooks
  }

  private getTempDir(): string {
    return join(this.repositoryDir, BACKUP_TEMP_DIR)
  }

  private getObjectPath(objectId: string): string {
    const lower = objectId.toLowerCase()
    return join(this.repositoryDir, BACKUP_OBJECTS_DIR, lower.slice(0, 2), `${lower}.pvchunk`)
  }

  private getSnapshotDir(snapshotId: string): string {
    return join(this.repositoryDir, BACKUP_SNAPSHOTS_DIR, snapshotId)
  }

  private wrapFsError(err: unknown): never {
    if (err instanceof BackupSnapshotError) {
      throw err
    }
    const code = classifyBackupDestinationFsError(err)
    throw new BackupSnapshotError(
      code,
      err instanceof Error ? err.message : `Destination I/O error: ${String(err)}`
    )
  }

  private async writePacedFileFsync(
    targetPath: string,
    data: Buffer,
    flag: 'wx' | 'w',
    signal?: AbortSignal
  ): Promise<void> {
    let fd: number | null = null
    try {
      fd = openSync(targetPath, flag)
      let offset = 0
      while (offset < data.length) {
        if (signal?.aborted) {
          throw new BackupSnapshotError('backup_cancelled', 'Transfer cancelled')
        }
        const sliceLen = Math.min(RATE_LIMIT_SLICE_BYTES, data.length - offset)
        await this.rateLimiter.consume(sliceLen, signal)
        const written = writeSync(fd, data, offset, sliceLen)
        if (written <= 0) {
          throw new Error('Zero bytes written to destination file')
        }
        offset += written
      }
      fsyncSync(fd)
    } catch (err) {
      return this.wrapFsError(err)
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // ignore close error
        }
      }
    }
  }

  private async readPacedFile(targetPath: string, signal?: AbortSignal): Promise<Buffer> {
    let fd: number | null = null
    try {
      const st = statSync(targetPath)
      const out = Buffer.allocUnsafe(st.size)
      fd = openSync(targetPath, 'r')
      let offset = 0
      while (offset < st.size) {
        if (signal?.aborted) {
          throw new BackupSnapshotError('backup_cancelled', 'Transfer cancelled')
        }
        const sliceLen = Math.min(RATE_LIMIT_SLICE_BYTES, st.size - offset)
        await this.rateLimiter.consume(sliceLen, signal)
        const bytesRead = readSync(fd, out, offset, sliceLen, offset)
        if (bytesRead <= 0) break
        offset += bytesRead
      }
      return offset === st.size ? out : out.subarray(0, offset)
    } catch (err) {
      return this.wrapFsError(err)
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // ignore close error
        }
      }
    }
  }

  public async ensureRepositoryLayout(): Promise<void> {
    try {
      mkdirSync(this.repositoryDir, { recursive: true })
      mkdirSync(this.getTempDir(), { recursive: true })
      mkdirSync(join(this.repositoryDir, BACKUP_OBJECTS_DIR), { recursive: true })
      mkdirSync(join(this.repositoryDir, BACKUP_SNAPSHOTS_DIR), { recursive: true })
    } catch (err) {
      this.wrapFsError(err)
    }
  }

  public async readRepositoryIdentity(): Promise<BackupRepositoryIdentityV1 | null> {
    const identityPath = join(this.repositoryDir, BACKUP_REPO_IDENTITY_FILE)
    if (!existsSync(identityPath)) {
      return null
    }
    try {
      const raw = readFileSync(identityPath, 'utf8')
      return BackupRepositoryIdentityV1Schema.parse(JSON.parse(raw))
    } catch (err) {
      throw new BackupSnapshotError(
        'destination_corrupt',
        `Invalid repository.json: ${(err as Error).message}`
      )
    }
  }

  public async writeRepositoryIdentity(
    identity: BackupRepositoryIdentityV1,
    signal?: AbortSignal
  ): Promise<void> {
    const validated = BackupRepositoryIdentityV1Schema.parse(identity)
    const identityPath = join(this.repositoryDir, BACKUP_REPO_IDENTITY_FILE)
    const tempPath = join(this.getTempDir(), `repo_${randomUUID()}.tmp`)
    const bytes = Buffer.from(JSON.stringify(validated, null, 2), 'utf8')
    try {
      await this.writePacedFileFsync(tempPath, bytes, 'wx', signal)
      renameSync(tempPath, identityPath)
    } catch (err) {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath)
      } catch {
        // ignore cleanup
      }
      this.wrapFsError(err)
    }
  }

  public async statObject(objectId: string): Promise<{ exists: boolean; byteSize: number }> {
    const objPath = this.getObjectPath(objectId)
    try {
      if (!existsSync(objPath)) {
        return { exists: false, byteSize: 0 }
      }
      const st = statSync(objPath)
      return { exists: true, byteSize: st.size }
    } catch (err) {
      this.wrapFsError(err)
    }
  }

  public async readObject(objectId: string, signal?: AbortSignal): Promise<Buffer> {
    return this.readPacedFile(this.getObjectPath(objectId), signal)
  }

  public async writeObjectAtomic(
    objectId: string,
    data: Buffer,
    jobId: string,
    options?: { readonly replaceIfCorrupt?: boolean; readonly signal?: AbortSignal }
  ): Promise<void> {
    const lower = objectId.toLowerCase()
    const objPath = this.getObjectPath(lower)
    const objParent = join(this.repositoryDir, BACKUP_OBJECTS_DIR, lower.slice(0, 2))
    const tempPath = join(this.getTempDir(), `chunk_${jobId}_${lower}_${randomUUID()}.tmp`)

    try {
      await this.hooks?.onBeforeChunkWrite?.(lower)
      mkdirSync(objParent, { recursive: true })
      mkdirSync(this.getTempDir(), { recursive: true })

      await this.writePacedFileFsync(tempPath, data, 'wx', options?.signal)

      if (existsSync(objPath) && options?.replaceIfCorrupt) {
        unlinkSync(objPath)
      }
      renameSync(tempPath, objPath)
      await this.hooks?.onAfterChunkWrite?.(lower)
    } catch (err) {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath)
      } catch {
        // ignore cleanup
      }
      this.wrapFsError(err)
    }
  }

  public async writeSnapshotInProgress(
    snapshotId: string,
    marker: BackupSnapshotInProgressMarkerV1,
    signal?: AbortSignal
  ): Promise<void> {
    const snapDir = this.getSnapshotDir(snapshotId)
    const markerPath = join(snapDir, BACKUP_SNAPSHOT_IN_PROGRESS_FILE)
    try {
      // Claim the new snapshot directory exclusively (fails with EEXIST -> destination_collision)
      mkdirSync(snapDir)
      const bytes = Buffer.from(JSON.stringify(marker, null, 2), 'utf8')
      await this.writePacedFileFsync(markerPath, bytes, 'wx', signal)
    } catch (err) {
      this.wrapFsError(err)
    }
  }

  public async claimOrResumeSnapshotInProgress(
    snapshotId: string,
    marker: BackupSnapshotInProgressMarkerV1,
    signal?: AbortSignal
  ): Promise<void> {
    const snapDir = this.getSnapshotDir(snapshotId)
    if (!existsSync(snapDir)) {
      await this.writeSnapshotInProgress(snapshotId, marker, signal)
      return
    }

    const completePath = join(snapDir, BACKUP_SNAPSHOT_COMPLETE_FILE)
    if (existsSync(completePath)) {
      throw new BackupSnapshotError(
        'destination_collision',
        `Cannot resume snapshot "${snapshotId}": complete.json already exists`
      )
    }

    const markerPath = join(snapDir, BACKUP_SNAPSHOT_IN_PROGRESS_FILE)
    if (!existsSync(markerPath)) {
      throw new BackupSnapshotError(
        'destination_collision',
        `Cannot resume snapshot "${snapshotId}": missing ownership marker .pv-snapshot-in-progress.json`
      )
    }

    let existing: BackupSnapshotInProgressMarkerV1
    try {
      existing = BackupSnapshotInProgressMarkerV1Schema.parse(
        JSON.parse(readFileSync(markerPath, 'utf8'))
      )
    } catch (err) {
      if (err instanceof BackupSnapshotError) throw err
      throw new BackupSnapshotError(
        'destination_collision',
        `Cannot resume snapshot "${snapshotId}": invalid ownership marker (${err instanceof Error ? err.message : String(err)})`
      )
    }

    if (
      existing.jobId !== marker.jobId ||
      existing.snapshotId !== marker.snapshotId ||
      existing.repositoryId !== marker.repositoryId
    ) {
      throw new BackupSnapshotError(
        'destination_collision',
        `Cannot resume snapshot "${snapshotId}": snapshot directory is owned by another job/repository`
      )
    }
  }

  public async removeSnapshotInProgress(snapshotId: string): Promise<void> {
    const markerPath = join(this.getSnapshotDir(snapshotId), BACKUP_SNAPSHOT_IN_PROGRESS_FILE)
    try {
      if (existsSync(markerPath)) {
        unlinkSync(markerPath)
      }
    } catch (err) {
      this.wrapFsError(err)
    }
  }

  public async writeSnapshotManifest(
    snapshotId: string,
    manifestBytes: Buffer,
    jobId: string,
    signal?: AbortSignal,
    fileName = BACKUP_SNAPSHOT_MANIFEST_FILE
  ): Promise<void> {
    const snapDir = this.getSnapshotDir(snapshotId)
    const manifestPath = join(snapDir, fileName)
    const tempPath = join(this.getTempDir(), `snap_${jobId}_${snapshotId}_${randomUUID()}.tmp`)
    try {
      await this.hooks?.onBeforeSnapshotManifest?.(snapshotId)
      mkdirSync(snapDir, { recursive: true })
      await this.writePacedFileFsync(tempPath, manifestBytes, 'wx', signal)
      renameSync(tempPath, manifestPath)
    } catch (err) {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath)
      } catch {
        // ignore cleanup
      }
      this.wrapFsError(err)
    }
  }

  public async readSnapshotManifest(
    snapshotId: string,
    signal?: AbortSignal,
    fileName = BACKUP_SNAPSHOT_MANIFEST_FILE
  ): Promise<Buffer | null> {
    const manifestPath = join(this.getSnapshotDir(snapshotId), fileName)
    if (!existsSync(manifestPath)) {
      return null
    }
    return this.readPacedFile(manifestPath, signal)
  }

  public async writeSnapshotCompleteMarker(
    snapshotId: string,
    marker: BackupSnapshotCompleteMarkerV1,
    signal?: AbortSignal
  ): Promise<void> {
    const validated = BackupSnapshotCompleteMarkerV1Schema.parse(marker)
    const snapDir = this.getSnapshotDir(snapshotId)
    const completePath = join(snapDir, BACKUP_SNAPSHOT_COMPLETE_FILE)
    const tempPath = join(this.getTempDir(), `complete_${snapshotId}_${randomUUID()}.tmp`)
    const bytes = Buffer.from(JSON.stringify(validated, null, 2), 'utf8')
    try {
      await this.hooks?.onBeforeCompleteMarker?.(snapshotId)
      await this.writePacedFileFsync(tempPath, bytes, 'wx', signal)
      renameSync(tempPath, completePath)
    } catch (err) {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath)
      } catch {
        // ignore cleanup
      }
      this.wrapFsError(err)
    }
  }

  public async listSnapshotIds(): Promise<string[]> {
    const snapsDir = join(this.repositoryDir, BACKUP_SNAPSHOTS_DIR)
    try {
      if (!existsSync(snapsDir)) return []
      return readdirSync(snapsDir)
    } catch (err) {
      this.wrapFsError(err)
    }
  }

  public async cleanupTempDir(): Promise<void> {
    const tempDir = this.getTempDir()
    try {
      if (existsSync(tempDir) && readdirSync(tempDir).length === 0) {
        rmdirSync(tempDir)
      }
    } catch {
      // best-effort temp dir cleanup
    }
  }
}
