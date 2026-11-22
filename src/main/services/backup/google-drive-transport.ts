/**
 * Personal Vault — Stage 8B Slice 3: Google Drive Backup Transport
 *
 * Implements `BackupTransport` over Google Drive REST API v3:
 * - Requires encrypted (`aes-256-gcm-v1`) repositories
 * - Folder layout mirroring `pv-backup-v1` under a dedicated Drive root folder
 * - Duplicate-rejecting lookups and idempotent create-reconciliation on lost POST responses
 * - Multipart uploads (`uploadType=multipart`) for small metadata files
 * - Resumable uploads (`uploadType=resumable`) with 256 KiB-aligned chunks,
 *   server-confirmed `308` Range tracking, bounded no-progress retries, and
 *   `Content-Range: bytes * /<total>` status recovery (including lost final-PUT responses)
 * - `TransferRateLimiter` pacing and `AbortSignal` cancellation
 */

import { createHash } from 'node:crypto'
import {
  BACKUP_FORMAT_VERSION,
  BackupRepositoryIdentityV1Schema,
  BackupSnapshotCompleteMarkerV1Schema,
  BackupSnapshotInProgressMarkerV1Schema,
  type BackupRepositoryIdentityV1,
  type BackupSnapshotCompleteMarkerV1,
  type BackupSnapshotInProgressMarkerV1
} from '../../../shared/validation/backup-schemas'
import { BackupSnapshotError } from './errors'
import { TransferRateLimiter } from './rate-limiter'
import {
  BACKUP_OBJECTS_DIR,
  BACKUP_REPO_IDENTITY_FILE,
  BACKUP_SNAPSHOT_COMPLETE_FILE,
  BACKUP_SNAPSHOT_IN_PROGRESS_FILE,
  BACKUP_SNAPSHOT_MANIFEST_FILE,
  BACKUP_SNAPSHOTS_DIR,
  type BackupTransport,
  type LocalBackupTestHooks
} from './transport'

export const DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES = 256 * 1024 // 262,144 bytes (Google Drive API v3 rule)
export const DEFAULT_DRIVE_UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024 // 2 MiB (8 * 256 KiB)
export const DEFAULT_DRIVE_RESUMABLE_THRESHOLD_BYTES = 256 * 1024 // 256 KiB
export const GOOGLE_DRIVE_API_BASE_URL = 'https://www.googleapis.com/drive/v3'
export const GOOGLE_DRIVE_UPLOAD_BASE_URL = 'https://www.googleapis.com/upload/drive/v3'
const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'

export interface DriveFileMetadata {
  readonly id: string
  readonly name: string
  readonly mimeType?: string
  readonly size?: string
}

export interface GoogleDriveResumableSessionStore {
  get(key: string): string | undefined
  set(key: string, sessionUri: string): void
  delete(key: string): void
}

export interface GoogleDriveTransportOptions {
  readonly rootFolderId: string
  readonly getAccessToken: () => Promise<string> | string
  readonly fetchFn?: typeof fetch
  readonly apiBaseUrl?: string
  readonly uploadBaseUrl?: string
  readonly uploadChunkSizeBytes?: number
  readonly resumableThresholdBytes?: number
  readonly retryDelaysMs?: readonly number[]
  readonly rateLimiter?: TransferRateLimiter
  readonly sessionStore?: GoogleDriveResumableSessionStore
  readonly hooks?: LocalBackupTestHooks
}

function escapeDriveQueryString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function parseDriveRangeEndByte(rangeHeader: string | null): number | null {
  if (!rangeHeader) return null
  const match = /^bytes=0-(\d+)$/i.exec(rangeHeader.trim())
  if (!match) return null
  const endByte = Number(match[1])
  return Number.isSafeInteger(endByte) && endByte >= 0 ? endByte : null
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new BackupSnapshotError('backup_cancelled', 'Backup cancelled')
  }
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new BackupSnapshotError('backup_cancelled', 'Backup cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class GoogleDriveTransport implements BackupTransport {
  public readonly requiresEncryption = true

  private readonly rootFolderId: string
  private readonly getAccessToken: () => Promise<string> | string
  private readonly fetchFn: typeof fetch
  private readonly apiBaseUrl: string
  private readonly uploadBaseUrl: string
  private readonly uploadChunkSizeBytes: number
  private readonly resumableThresholdBytes: number
  private readonly retryDelaysMs: readonly number[]
  private readonly rateLimiter: TransferRateLimiter
  private readonly sessionStore: GoogleDriveResumableSessionStore
  private readonly hooks?: LocalBackupTestHooks
  private readonly folderCache = new Map<string, string>()
  private readonly pregeneratedIdPool: string[] = []

  public constructor(options: GoogleDriveTransportOptions) {
    const chunkSize = options.uploadChunkSizeBytes ?? DEFAULT_DRIVE_UPLOAD_CHUNK_BYTES
    if (chunkSize <= 0 || chunkSize % DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES !== 0) {
      throw new BackupSnapshotError(
        'backup_staging_error',
        `Google Drive uploadChunkSizeBytes (${chunkSize}) must be a positive multiple of ${DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES} bytes`
      )
    }
    this.rootFolderId = options.rootFolderId
    this.getAccessToken = options.getAccessToken
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.apiBaseUrl = (options.apiBaseUrl ?? GOOGLE_DRIVE_API_BASE_URL).replace(/\/+$/, '')
    this.uploadBaseUrl = (options.uploadBaseUrl ?? GOOGLE_DRIVE_UPLOAD_BASE_URL).replace(/\/+$/, '')
    this.uploadChunkSizeBytes = chunkSize
    this.resumableThresholdBytes =
      options.resumableThresholdBytes ?? DEFAULT_DRIVE_RESUMABLE_THRESHOLD_BYTES
    this.retryDelaysMs = options.retryDelaysMs ?? [250, 750, 1500]
    this.rateLimiter = options.rateLimiter ?? new TransferRateLimiter({ maxBytesPerSecond: null })
    this.sessionStore = options.sessionStore ?? new Map<string, string>()
    this.hooks = options.hooks
  }

  private checkCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new BackupSnapshotError('backup_cancelled', 'Backup cancelled')
    }
  }

  private async authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const token = await this.getAccessToken()
    return {
      Authorization: `Bearer ${token}`,
      ...extra
    }
  }

  private mapHttpError(status: number, bodyText: string, context: string): BackupSnapshotError {
    if (status === 401 || status === 403) {
      if (bodyText.includes('storageQuotaExceeded')) {
        return new BackupSnapshotError(
          'destination_disk_full',
          `Google Drive storage quota exceeded during ${context}`
        )
      }
      return new BackupSnapshotError(
        'destination_access_denied',
        `Google Drive access denied (${status}) during ${context}: ${bodyText}`
      )
    }
    if (status === 507) {
      return new BackupSnapshotError(
        'destination_disk_full',
        `Google Drive storage quota exceeded (${status}) during ${context}`
      )
    }
    if (status === 404) {
      return new BackupSnapshotError(
        'destination_unavailable',
        `Google Drive resource not found (${status}) during ${context}`
      )
    }
    if (isRetryableStatus(status)) {
      return new BackupSnapshotError(
        'destination_unavailable',
        `Google Drive transient failure (${status}) during ${context}: ${bodyText}`
      )
    }
    return new BackupSnapshotError(
      'destination_write_failed',
      `Google Drive request failed (${status}) during ${context}: ${bodyText}`
    )
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    context: string,
    signal?: AbortSignal
  ): Promise<Response> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      this.checkCancelled(signal)
      try {
        const res = await this.fetchFn(url, { ...init, signal })
        if (!isRetryableStatus(res.status) || attempt === this.retryDelaysMs.length) {
          return res
        }
        await sleepWithAbort(this.retryDelaysMs[attempt]!, signal)
      } catch (err) {
        if (err instanceof BackupSnapshotError) throw err
        if (signal?.aborted) {
          throw new BackupSnapshotError('backup_cancelled', 'Backup cancelled')
        }
        lastError = err
        if (attempt === this.retryDelaysMs.length) {
          throw new BackupSnapshotError(
            'destination_unavailable',
            `Network failure during ${context}: ${(err as Error).message}`
          )
        }
        await sleepWithAbort(this.retryDelaysMs[attempt]!, signal)
      }
    }
    throw new BackupSnapshotError(
      'destination_unavailable',
      `Failed during ${context}: ${String(lastError)}`
    )
  }

  private async listChildren(
    parentId: string,
    extraQuery?: string,
    signal?: AbortSignal
  ): Promise<DriveFileMetadata[]> {
    const items: DriveFileMetadata[] = []
    let pageToken: string | undefined
    do {
      const qParts = [`'${escapeDriveQueryString(parentId)}' in parents`, 'trashed = false']
      if (extraQuery) qParts.push(extraQuery)
      const params = new URLSearchParams({
        q: qParts.join(' and '),
        fields: 'files(id,name,mimeType,size),nextPageToken',
        spaces: 'drive',
        pageSize: '1000'
      })
      if (pageToken) params.set('pageToken', pageToken)

      const res = await this.fetchWithRetry(
        `${this.apiBaseUrl}/files?${params.toString()}`,
        { method: 'GET', headers: await this.authHeaders() },
        'list Drive folder',
        signal
      )
      if (!res.ok) {
        throw this.mapHttpError(res.status, await res.text(), 'list Drive folder')
      }
      const data = (await res.json()) as {
        files?: DriveFileMetadata[]
        nextPageToken?: string
      }
      if (Array.isArray(data.files)) {
        items.push(...data.files)
      }
      pageToken = data.nextPageToken
    } while (pageToken)
    return items
  }

  private async findSingleChild(
    parentId: string,
    name: string,
    signal?: AbortSignal
  ): Promise<DriveFileMetadata | null> {
    const results = await this.listChildren(
      parentId,
      `name = '${escapeDriveQueryString(name)}'`,
      signal
    )
    if (results.length > 1) {
      throw new BackupSnapshotError(
        'destination_corrupt',
        `Ambiguous duplicate Drive entries (${results.length}) found for "${name}" in parent "${parentId}"`
      )
    }
    return results[0] ?? null
  }

  private async findSingleFolder(
    parentId: string,
    name: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    const cacheKey = `${parentId}/${name}`
    const cached = this.folderCache.get(cacheKey)
    if (cached) return cached

    const existing = await this.listChildren(
      parentId,
      `name = '${escapeDriveQueryString(name)}' and mimeType = '${DRIVE_FOLDER_MIME_TYPE}'`,
      signal
    )
    if (existing.length > 1) {
      throw new BackupSnapshotError(
        'destination_corrupt',
        `Ambiguous duplicate Drive folders (${existing.length}) found for "${name}" in parent "${parentId}"`
      )
    }
    if (existing[0]) {
      this.folderCache.set(cacheKey, existing[0].id)
      return existing[0].id
    }
    return null
  }

  private async allocateFileId(signal?: AbortSignal): Promise<string> {
    const pooled = this.pregeneratedIdPool.shift()
    if (pooled) return pooled

    const params = new URLSearchParams({
      count: '10',
      space: 'drive',
      type: 'files'
    })
    const res = await this.fetchWithRetry(
      `${this.apiBaseUrl}/files/generateIds?${params.toString()}`,
      { method: 'GET', headers: await this.authHeaders() },
      'generate Drive file IDs',
      signal
    )
    if (!res.ok) {
      throw this.mapHttpError(res.status, await res.text(), 'generate Drive file IDs')
    }
    const data = (await res.json()) as { ids?: string[] }
    if (!Array.isArray(data.ids) || data.ids.length === 0) {
      throw new BackupSnapshotError(
        'destination_write_failed',
        'Google Drive files.generateIds returned no IDs'
      )
    }
    this.pregeneratedIdPool.push(...data.ids.slice(1))
    return data.ids[0]!
  }

  private async getFileMetadataById(
    fileId: string,
    signal?: AbortSignal
  ): Promise<DriveFileMetadata | null> {
    const params = new URLSearchParams({ fields: 'id,name,mimeType,size,trashed' })
    const res = await this.fetchWithRetry(
      `${this.apiBaseUrl}/files/${encodeURIComponent(fileId)}?${params.toString()}`,
      { method: 'GET', headers: await this.authHeaders() },
      `get Drive file metadata ${fileId}`,
      signal
    )
    if (res.status === 404) {
      return null
    }
    if (!res.ok) {
      throw this.mapHttpError(res.status, await res.text(), `get Drive file metadata ${fileId}`)
    }
    const data = (await res.json()) as DriveFileMetadata & { trashed?: boolean }
    if (data.trashed) {
      return null
    }
    return data
  }

  private async ensureFolder(
    parentId: string,
    name: string,
    signal?: AbortSignal
  ): Promise<string> {
    const existingId = await this.findSingleFolder(parentId, name, signal)
    if (existingId) return existingId

    const cacheKey = `${parentId}/${name}`
    const pregeneratedId = await this.allocateFileId(signal)
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      this.checkCancelled(signal)
      let res: Response | null = null
      let transientFailure = false
      try {
        res = await this.fetchFn(`${this.apiBaseUrl}/files`, {
          method: 'POST',
          headers: await this.authHeaders({ 'Content-Type': 'application/json; charset=UTF-8' }),
          body: JSON.stringify({
            id: pregeneratedId,
            name,
            mimeType: DRIVE_FOLDER_MIME_TYPE,
            parents: [parentId]
          }),
          signal
        })
      } catch (err) {
        if (signal?.aborted) {
          throw new BackupSnapshotError('backup_cancelled', 'Backup cancelled')
        }
        if (attempt === this.retryDelaysMs.length) {
          // Even on final attempt, check direct ID before failing
          const direct = await this.getFileMetadataById(pregeneratedId, signal)
          if (direct) {
            this.folderCache.set(cacheKey, direct.id)
            return direct.id
          }
          throw new BackupSnapshotError(
            'destination_unavailable',
            `Network failure creating Drive folder "${name}": ${(err as Error).message}`
          )
        }
        transientFailure = true
      }

      if (res && res.ok) {
        const created = (await res.json()) as DriveFileMetadata
        this.folderCache.set(cacheKey, created.id)
        return created.id
      }

      if (res && res.status === 409) {
        const direct = await this.getFileMetadataById(pregeneratedId, signal)
        if (direct) {
          this.folderCache.set(cacheKey, direct.id)
          return direct.id
        }
      }

      if (res && !isRetryableStatus(res.status)) {
        throw this.mapHttpError(res.status, await res.text(), `create Drive folder "${name}"`)
      }

      // Lost response or retryable error: check direct pre-generated ID first (immune to delayed listing),
      // then check folder listing before retrying POST with the same pregeneratedId
      if (transientFailure || (res && isRetryableStatus(res.status))) {
        const direct = await this.getFileMetadataById(pregeneratedId, signal)
        if (direct) {
          this.folderCache.set(cacheKey, direct.id)
          return direct.id
        }
        const reconciledId = await this.findSingleFolder(parentId, name, signal)
        if (reconciledId) {
          return reconciledId
        }
        if (attempt === this.retryDelaysMs.length) {
          if (res) {
            throw this.mapHttpError(res.status, await res.text(), `create Drive folder "${name}"`)
          }
          throw new BackupSnapshotError(
            'destination_unavailable',
            `Failed to create Drive folder "${name}" after retries`
          )
        }
        await sleepWithAbort(this.retryDelaysMs[attempt]!, signal)
      }
    }

    throw new BackupSnapshotError(
      'destination_unavailable',
      `Failed to create Drive folder "${name}"`
    )
  }

  private async downloadFileBytes(fileId: string, signal?: AbortSignal): Promise<Buffer> {
    this.checkCancelled(signal)
    const res = await this.fetchWithRetry(
      `${this.apiBaseUrl}/files/${encodeURIComponent(fileId)}?alt=media`,
      { method: 'GET', headers: await this.authHeaders() },
      `download Drive file ${fileId}`,
      signal
    )
    if (!res.ok) {
      throw this.mapHttpError(res.status, await res.text(), `download Drive file ${fileId}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    await this.rateLimiter.consume(buf.length, signal)
    return buf
  }

  private async deleteFile(fileId: string, signal?: AbortSignal): Promise<void> {
    const res = await this.fetchWithRetry(
      `${this.apiBaseUrl}/files/${encodeURIComponent(fileId)}`,
      { method: 'DELETE', headers: await this.authHeaders() },
      `delete Drive file ${fileId}`,
      signal
    )
    if (!res.ok && res.status !== 404) {
      throw this.mapHttpError(res.status, await res.text(), `delete Drive file ${fileId}`)
    }
  }

  private async uploadMultipart(
    parentId: string,
    name: string,
    data: Buffer,
    mimeType: string,
    existingFileId?: string,
    signal?: AbortSignal,
    reconcileOnLostCreate?: (existing: DriveFileMetadata) => Promise<boolean>
  ): Promise<DriveFileMetadata> {
    this.checkCancelled(signal)

    const pregeneratedId = existingFileId ? undefined : await this.allocateFileId(signal)
    const boundary = `pv_drive_boundary_${Date.now()}_${Math.random().toString(16).slice(2)}`
    const metadata = existingFileId
      ? { name, mimeType }
      : { id: pregeneratedId, name, parents: [parentId], mimeType }
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
        metadata
      )}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      'utf8'
    )
    const epilogue = Buffer.from(`\r\n--${boundary}--`, 'utf8')
    const body = Buffer.concat([preamble, data, epilogue])

    const url = existingFileId
      ? `${this.uploadBaseUrl}/files/${encodeURIComponent(existingFileId)}?uploadType=multipart`
      : `${this.uploadBaseUrl}/files?uploadType=multipart`

    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      this.checkCancelled(signal)
      await this.rateLimiter.consume(data.length, signal)

      let res: Response | null = null
      let networkErr: unknown = null
      try {
        res = await this.fetchFn(url, {
          method: existingFileId ? 'PATCH' : 'POST',
          headers: await this.authHeaders({
            'Content-Type': `multipart/related; boundary=${boundary}`,
            'Content-Length': String(body.length)
          }),
          body: new Uint8Array(body),
          signal
        })
      } catch (err) {
        if (signal?.aborted) {
          throw new BackupSnapshotError('backup_cancelled', 'Backup cancelled')
        }
        networkErr = err
      }

      if (res && res.ok) {
        return (await res.json()) as DriveFileMetadata
      }

      if (res && res.status === 409 && pregeneratedId) {
        const direct = await this.getFileMetadataById(pregeneratedId, signal)
        if (direct) {
          return direct
        }
      }

      if (res && !isRetryableStatus(res.status)) {
        throw this.mapHttpError(res.status, await res.text(), `multipart upload "${name}"`)
      }

      // If this was a create (POST), reconcile by pregeneratedId first (immune to delayed listing),
      // then by listing before retrying POST with the same pregeneratedId
      if (!existingFileId && pregeneratedId) {
        const direct = await this.getFileMetadataById(pregeneratedId, signal)
        if (direct) {
          return direct
        }
        const existing = await this.findSingleChild(parentId, name, signal)
        if (existing) {
          if (reconcileOnLostCreate) {
            const matches = await reconcileOnLostCreate(existing)
            if (matches) {
              return existing
            }
            throw new BackupSnapshotError(
              'destination_collision',
              `Conflicting Drive file "${name}" already exists after lost create response`
            )
          }
          // Safe overwrite via PATCH if caller didn't restrict collision
          return this.uploadMultipart(parentId, name, data, mimeType, existing.id, signal)
        }
      }

      if (attempt === this.retryDelaysMs.length) {
        if (res) {
          throw this.mapHttpError(res.status, await res.text(), `multipart upload "${name}"`)
        }
        throw new BackupSnapshotError(
          'destination_unavailable',
          `Network failure during multipart upload "${name}": ${String((networkErr as Error)?.message ?? networkErr)}`
        )
      }
      await sleepWithAbort(this.retryDelaysMs[attempt]!, signal)
    }

    throw new BackupSnapshotError(
      'destination_write_failed',
      `Multipart upload "${name}" failed unexpectedly`
    )
  }

  private async initiateResumableSession(
    parentId: string,
    name: string,
    totalLength: number,
    mimeType: string,
    existingFileId?: string,
    pregeneratedId?: string,
    signal?: AbortSignal
  ): Promise<string> {
    const metadata = existingFileId
      ? { name, mimeType }
      : { ...(pregeneratedId ? { id: pregeneratedId } : {}), name, parents: [parentId], mimeType }
    const url = existingFileId
      ? `${this.uploadBaseUrl}/files/${encodeURIComponent(existingFileId)}?uploadType=resumable`
      : `${this.uploadBaseUrl}/files?uploadType=resumable`

    const res = await this.fetchWithRetry(
      url,
      {
        method: existingFileId ? 'PATCH' : 'POST',
        headers: await this.authHeaders({
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(totalLength)
        }),
        body: JSON.stringify(metadata)
      },
      `initiate resumable upload "${name}"`,
      signal
    )
    if (!res.ok) {
      throw this.mapHttpError(res.status, await res.text(), `initiate resumable upload "${name}"`)
    }
    const location = res.headers.get('location')
    if (!location) {
      throw new BackupSnapshotError(
        'destination_write_failed',
        `Google Drive resumable upload initiation for "${name}" omitted Location header`
      )
    }
    return location
  }

  private async queryResumableOffset(
    sessionUri: string,
    totalLength: number,
    signal?: AbortSignal
  ): Promise<{
    readonly active: boolean
    readonly nextOffset: number
    readonly completedFile?: DriveFileMetadata
  }> {
    const res = await this.fetchWithRetry(
      sessionUri,
      {
        method: 'PUT',
        headers: {
          'Content-Length': '0',
          'Content-Range': `bytes */${totalLength}`
        }
      },
      'query resumable upload status',
      signal
    )
    if (res.status === 404 || res.status === 410) {
      return { active: false, nextOffset: 0 }
    }
    if (res.status === 308) {
      const rangeEnd = parseDriveRangeEndByte(res.headers.get('range'))
      const nextOffset = rangeEnd === null ? 0 : Math.min(rangeEnd + 1, totalLength)
      return { active: true, nextOffset }
    }
    if (res.ok) {
      let completedFile: DriveFileMetadata | undefined
      try {
        const text = await res.text()
        if (text.trim().length > 0) {
          completedFile = JSON.parse(text) as DriveFileMetadata
        }
      } catch {
        // ignore if empty body
      }
      return { active: true, nextOffset: totalLength, completedFile }
    }
    throw this.mapHttpError(res.status, await res.text(), 'query resumable upload status')
  }

  private async verifyCommittedFile(
    parentId: string,
    name: string,
    expectedLength: number,
    expectedSha256: string,
    preferredFileId?: string,
    signal?: AbortSignal
  ): Promise<DriveFileMetadata | null> {
    const candidate =
      (preferredFileId ? await this.getFileMetadataById(preferredFileId, signal) : null) ??
      (await this.findSingleChild(parentId, name, signal))
    if (!candidate) {
      return null
    }
    if (candidate.size !== undefined && Number(candidate.size) !== expectedLength) {
      return null
    }
    const downloaded = await this.downloadFileBytes(candidate.id, signal)
    const actualSha = createHash('sha256').update(downloaded).digest('hex')
    if (downloaded.length !== expectedLength || actualSha !== expectedSha256) {
      return null
    }
    return candidate
  }

  private async uploadResumable(
    parentId: string,
    name: string,
    data: Buffer,
    mimeType: string,
    existingFileId?: string,
    signal?: AbortSignal,
    reconcileOnLostCreate?: (existing: DriveFileMetadata) => Promise<boolean>
  ): Promise<DriveFileMetadata> {
    if (data.length === 0) {
      return this.uploadMultipart(
        parentId,
        name,
        data,
        mimeType,
        existingFileId,
        signal,
        reconcileOnLostCreate
      )
    }

    const contentSha256 = createHash('sha256').update(data).digest('hex')
    const sessionKey = `${parentId}/${name}/${contentSha256}`
    let sessionUri = this.sessionStore.get(sessionKey)
    let offset = 0

    if (sessionUri) {
      const status = await this.queryResumableOffset(sessionUri, data.length, signal)
      if (!status.active) {
        this.sessionStore.delete(sessionKey)
        sessionUri = undefined
      } else if (status.nextOffset >= data.length) {
        if (status.completedFile?.id) {
          this.sessionStore.delete(sessionKey)
          return status.completedFile
        }
        const verified = await this.verifyCommittedFile(
          parentId,
          name,
          data.length,
          contentSha256,
          existingFileId,
          signal
        )
        if (verified) {
          this.sessionStore.delete(sessionKey)
          return verified
        }
        this.sessionStore.delete(sessionKey)
        sessionUri = undefined
      } else {
        offset = status.nextOffset
      }
    }

    const pregeneratedId = existingFileId ? undefined : await this.allocateFileId(signal)
    if (!sessionUri) {
      sessionUri = await this.initiateResumableSession(
        parentId,
        name,
        data.length,
        mimeType,
        existingFileId,
        pregeneratedId,
        signal
      )
      this.sessionStore.set(sessionKey, sessionUri)
      offset = 0
    }

    let noProgressAttempts = 0
    const maxNoProgressAttempts = this.retryDelaysMs.length

    while (offset < data.length) {
      this.checkCancelled(signal)
      const endExclusive = Math.min(offset + this.uploadChunkSizeBytes, data.length)
      const slice = data.subarray(offset, endExclusive)
      await this.rateLimiter.consume(slice.length, signal)

      let res: Response | null = null
      let networkError: unknown = null
      try {
        res = await this.fetchFn(sessionUri, {
          method: 'PUT',
          headers: {
            'Content-Length': String(slice.length),
            'Content-Range': `bytes ${offset}-${endExclusive - 1}/${data.length}`
          },
          body: new Uint8Array(slice),
          signal
        })
      } catch (err) {
        if (signal?.aborted) {
          throw new BackupSnapshotError('backup_cancelled', 'Backup cancelled')
        }
        networkError = err
      }

      if (res && (res.status === 200 || res.status === 201)) {
        this.sessionStore.delete(sessionKey)
        return (await res.json()) as DriveFileMetadata
      }

      if (res && res.status === 308) {
        const rangeEnd = parseDriveRangeEndByte(res.headers.get('range'))
        const confirmedOffset = rangeEnd === null ? 0 : Math.min(rangeEnd + 1, data.length)
        // A 308 is never terminal completion even when Range reaches the final byte.
        // Only accept if we independently verify the committed file; otherwise treat as no-progress.
        if (confirmedOffset >= data.length) {
          const verified = await this.verifyCommittedFile(
            parentId,
            name,
            data.length,
            contentSha256,
            existingFileId ?? pregeneratedId,
            signal
          )
          if (verified) {
            this.sessionStore.delete(sessionKey)
            return verified
          }
          noProgressAttempts += 1
          if (noProgressAttempts > maxNoProgressAttempts) {
            throw new BackupSnapshotError(
              'destination_unavailable',
              `Google Drive resumable upload returned 308 at final byte without committing "${name}"`
            )
          }
          await sleepWithAbort(this.retryDelaysMs[noProgressAttempts - 1] ?? 250, signal)
          continue
        }
        if (confirmedOffset > offset) {
          noProgressAttempts = 0
          offset = confirmedOffset
          continue
        }
        // Server returned 308 without advancing offset (e.g. missing Range header)
        noProgressAttempts += 1
        if (noProgressAttempts > maxNoProgressAttempts) {
          throw new BackupSnapshotError(
            'destination_unavailable',
            `Google Drive resumable upload made no progress for "${name}" at byte ${offset}`
          )
        }
        offset = confirmedOffset
        await sleepWithAbort(this.retryDelaysMs[noProgressAttempts - 1] ?? 250, signal)
        continue
      }

      if (res && (res.status === 404 || res.status === 410)) {
        this.sessionStore.delete(sessionKey)
        throw new BackupSnapshotError(
          'destination_unavailable',
          `Google Drive resumable upload session expired (${res.status}) for "${name}"`
        )
      }

      if (networkError !== null || (res && isRetryableStatus(res.status))) {
        noProgressAttempts += 1
        const recovery = await this.queryResumableOffset(sessionUri, data.length, signal)
        if (!recovery.active) {
          this.sessionStore.delete(sessionKey)
          throw new BackupSnapshotError(
            'destination_unavailable',
            `Google Drive resumable upload session lost for "${name}"`
          )
        }
        if (recovery.nextOffset >= data.length) {
          if (recovery.completedFile?.id) {
            this.sessionStore.delete(sessionKey)
            return recovery.completedFile
          }
          const verified = await this.verifyCommittedFile(
            parentId,
            name,
            data.length,
            contentSha256,
            existingFileId ?? pregeneratedId,
            signal
          )
          if (verified) {
            this.sessionStore.delete(sessionKey)
            return verified
          }
        }
        if (recovery.nextOffset > offset && recovery.nextOffset < data.length) {
          noProgressAttempts = 0
          offset = recovery.nextOffset
          continue
        }
        if (noProgressAttempts > maxNoProgressAttempts) {
          if (res) {
            throw this.mapHttpError(res.status, await res.text(), `resumable upload "${name}"`)
          }
          throw new BackupSnapshotError(
            'destination_unavailable',
            `Google Drive resumable upload failed after ${maxNoProgressAttempts} no-progress retries for "${name}": ${String((networkError as Error)?.message ?? networkError)}`
          )
        }
        if (recovery.nextOffset < data.length) {
          offset = recovery.nextOffset
        }
        await sleepWithAbort(this.retryDelaysMs[noProgressAttempts - 1] ?? 250, signal)
        continue
      }

      if (res) {
        throw this.mapHttpError(res.status, await res.text(), `resumable upload "${name}"`)
      }
    }

    throw new BackupSnapshotError(
      'destination_write_failed',
      `Resumable upload loop terminated unexpectedly for "${name}"`
    )
  }

  private async uploadFile(
    parentId: string,
    name: string,
    data: Buffer,
    mimeType: string,
    existingFileId?: string,
    signal?: AbortSignal,
    reconcileOnLostCreate?: (existing: DriveFileMetadata) => Promise<boolean>
  ): Promise<DriveFileMetadata> {
    if (data.length >= this.resumableThresholdBytes && data.length > 0) {
      return this.uploadResumable(
        parentId,
        name,
        data,
        mimeType,
        existingFileId,
        signal,
        reconcileOnLostCreate
      )
    }
    return this.uploadMultipart(
      parentId,
      name,
      data,
      mimeType,
      existingFileId,
      signal,
      reconcileOnLostCreate
    )
  }

  public async ensureRepositoryLayout(): Promise<void> {
    await this.ensureFolder(this.rootFolderId, BACKUP_OBJECTS_DIR)
    await this.ensureFolder(this.rootFolderId, BACKUP_SNAPSHOTS_DIR)
  }

  public async readRepositoryIdentity(): Promise<BackupRepositoryIdentityV1 | null> {
    const file = await this.findSingleChild(this.rootFolderId, BACKUP_REPO_IDENTITY_FILE)
    if (!file) return null
    const bytes = await this.downloadFileBytes(file.id)
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch (err) {
      throw new BackupSnapshotError(
        'destination_corrupt',
        `Invalid Drive repository.json: ${(err as Error).message}`
      )
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'formatVersion' in parsed &&
      (parsed as { formatVersion?: unknown }).formatVersion !== BACKUP_FORMAT_VERSION
    ) {
      throw new BackupSnapshotError(
        'destination_corrupt',
        `Unsupported backup formatVersion: ${String((parsed as { formatVersion?: unknown }).formatVersion)}`
      )
    }
    const result = BackupRepositoryIdentityV1Schema.safeParse(parsed)
    if (!result.success) {
      throw new BackupSnapshotError(
        'destination_corrupt',
        `Schema-invalid Drive repository.json: ${result.error.message}`
      )
    }
    return result.data
  }

  public async writeRepositoryIdentity(
    identity: BackupRepositoryIdentityV1,
    signal?: AbortSignal
  ): Promise<void> {
    const validated = BackupRepositoryIdentityV1Schema.parse(identity)
    if (validated.encryptionMode !== 'aes-256-gcm-v1') {
      throw new BackupSnapshotError(
        'destination_corrupt',
        `Google Drive transport requires aes-256-gcm-v1 encryption (got "${validated.encryptionMode}")`
      )
    }
    const existing = await this.findSingleChild(
      this.rootFolderId,
      BACKUP_REPO_IDENTITY_FILE,
      signal
    )
    if (existing) {
      throw new BackupSnapshotError('destination_collision', 'Drive repository.json already exists')
    }
    const bytes = Buffer.from(JSON.stringify(validated, null, 2), 'utf8')
    await this.uploadFile(
      this.rootFolderId,
      BACKUP_REPO_IDENTITY_FILE,
      bytes,
      'application/json',
      undefined,
      signal,
      async (found) => {
        const downloaded = await this.downloadFileBytes(found.id, signal)
        const parsed = BackupRepositoryIdentityV1Schema.safeParse(
          JSON.parse(downloaded.toString('utf8'))
        )
        return parsed.success && parsed.data.repositoryId === validated.repositoryId
      }
    )
  }

  public async statObject(objectId: string): Promise<{ exists: boolean; byteSize: number }> {
    const lower = objectId.toLowerCase()
    const objectsFolderId = await this.findSingleFolder(this.rootFolderId, BACKUP_OBJECTS_DIR)
    if (!objectsFolderId) return { exists: false, byteSize: 0 }
    const prefixFolderId = await this.findSingleFolder(objectsFolderId, lower.slice(0, 2))
    if (!prefixFolderId) return { exists: false, byteSize: 0 }
    const file = await this.findSingleChild(prefixFolderId, `${lower}.pvchunk`)
    if (!file) return { exists: false, byteSize: 0 }
    return { exists: true, byteSize: Number(file.size ?? 0) }
  }

  public async readObject(objectId: string, signal?: AbortSignal): Promise<Buffer> {
    const lower = objectId.toLowerCase()
    const objectsFolderId = await this.findSingleFolder(
      this.rootFolderId,
      BACKUP_OBJECTS_DIR,
      signal
    )
    if (!objectsFolderId) {
      throw new BackupSnapshotError('destination_corrupt', `Missing backup object ${lower}`)
    }
    const prefixFolderId = await this.findSingleFolder(objectsFolderId, lower.slice(0, 2), signal)
    if (!prefixFolderId) {
      throw new BackupSnapshotError('destination_corrupt', `Missing backup object ${lower}`)
    }
    const file = await this.findSingleChild(prefixFolderId, `${lower}.pvchunk`, signal)
    if (!file) {
      throw new BackupSnapshotError('destination_corrupt', `Missing backup object ${lower}`)
    }
    return this.downloadFileBytes(file.id, signal)
  }

  public async writeObjectAtomic(
    objectId: string,
    data: Buffer,
    _jobId: string,
    options?: { readonly replaceIfCorrupt?: boolean; readonly signal?: AbortSignal }
  ): Promise<void> {
    const lower = objectId.toLowerCase()
    const objectsFolderId = await this.ensureFolder(
      this.rootFolderId,
      BACKUP_OBJECTS_DIR,
      options?.signal
    )
    const prefixFolderId = await this.ensureFolder(
      objectsFolderId,
      lower.slice(0, 2),
      options?.signal
    )
    const fileName = `${lower}.pvchunk`
    const existing = await this.findSingleChild(prefixFolderId, fileName, options?.signal)
    if (existing && !options?.replaceIfCorrupt) {
      return
    }
    await this.uploadFile(
      prefixFolderId,
      fileName,
      data,
      'application/octet-stream',
      existing?.id,
      options?.signal
    )
  }

  public async writeSnapshotInProgress(
    snapshotId: string,
    marker: BackupSnapshotInProgressMarkerV1,
    signal?: AbortSignal
  ): Promise<void> {
    const snapshotsFolderId = await this.ensureFolder(
      this.rootFolderId,
      BACKUP_SNAPSHOTS_DIR,
      signal
    )
    const existingSnapFolder = await this.findSingleFolder(snapshotsFolderId, snapshotId, signal)
    if (existingSnapFolder) {
      throw new BackupSnapshotError(
        'destination_collision',
        `Snapshot directory "${snapshotId}" already exists on Google Drive`
      )
    }
    const snapFolderId = await this.ensureFolder(snapshotsFolderId, snapshotId, signal)
    const bytes = Buffer.from(JSON.stringify(marker, null, 2), 'utf8')
    await this.uploadFile(
      snapFolderId,
      BACKUP_SNAPSHOT_IN_PROGRESS_FILE,
      bytes,
      'application/json',
      undefined,
      signal,
      async (found) => {
        const downloaded = await this.downloadFileBytes(found.id, signal)
        const parsed = BackupSnapshotInProgressMarkerV1Schema.safeParse(
          JSON.parse(downloaded.toString('utf8'))
        )
        return (
          parsed.success &&
          parsed.data.jobId === marker.jobId &&
          parsed.data.snapshotId === marker.snapshotId &&
          parsed.data.repositoryId === marker.repositoryId
        )
      }
    )
  }

  public async claimOrResumeSnapshotInProgress(
    snapshotId: string,
    marker: BackupSnapshotInProgressMarkerV1,
    signal?: AbortSignal
  ): Promise<void> {
    const snapshotsFolderId = await this.ensureFolder(
      this.rootFolderId,
      BACKUP_SNAPSHOTS_DIR,
      signal
    )
    const snapFolderId = await this.findSingleFolder(snapshotsFolderId, snapshotId, signal)
    if (!snapFolderId) {
      await this.writeSnapshotInProgress(snapshotId, marker, signal)
      return
    }
    const completeFile = await this.findSingleChild(
      snapFolderId,
      BACKUP_SNAPSHOT_COMPLETE_FILE,
      signal
    )
    if (completeFile) {
      throw new BackupSnapshotError(
        'destination_collision',
        `Cannot resume snapshot "${snapshotId}": complete.json already exists`
      )
    }
    const markerFile = await this.findSingleChild(
      snapFolderId,
      BACKUP_SNAPSHOT_IN_PROGRESS_FILE,
      signal
    )
    if (!markerFile) {
      throw new BackupSnapshotError(
        'destination_collision',
        `Cannot resume snapshot "${snapshotId}": missing .pv-snapshot-in-progress.json`
      )
    }
    const bytes = await this.downloadFileBytes(markerFile.id, signal)
    let existing: BackupSnapshotInProgressMarkerV1
    try {
      existing = BackupSnapshotInProgressMarkerV1Schema.parse(JSON.parse(bytes.toString('utf8')))
    } catch (err) {
      throw new BackupSnapshotError(
        'destination_collision',
        `Cannot resume snapshot "${snapshotId}": invalid ownership marker (${(err as Error).message})`
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
    const snapshotsFolderId = await this.findSingleFolder(this.rootFolderId, BACKUP_SNAPSHOTS_DIR)
    if (!snapshotsFolderId) return
    const snapFolderId = await this.findSingleFolder(snapshotsFolderId, snapshotId)
    if (!snapFolderId) return
    const markerFile = await this.findSingleChild(snapFolderId, BACKUP_SNAPSHOT_IN_PROGRESS_FILE)
    if (markerFile) {
      await this.deleteFile(markerFile.id)
    }
  }

  public async hasSnapshotInProgress(snapshotId: string, signal?: AbortSignal): Promise<boolean> {
    const snapshotsFolderId = await this.findSingleFolder(
      this.rootFolderId,
      BACKUP_SNAPSHOTS_DIR,
      signal
    )
    if (!snapshotsFolderId) return false
    const snapFolderId = await this.findSingleFolder(snapshotsFolderId, snapshotId, signal)
    if (!snapFolderId) return false
    const markerFile = await this.findSingleChild(
      snapFolderId,
      BACKUP_SNAPSHOT_IN_PROGRESS_FILE,
      signal
    )
    return markerFile !== null
  }

  public async writeSnapshotManifest(
    snapshotId: string,
    manifestBytes: Buffer,
    _jobId: string,
    signal?: AbortSignal,
    fileName = BACKUP_SNAPSHOT_MANIFEST_FILE
  ): Promise<void> {
    await this.hooks?.onBeforeSnapshotManifest?.(snapshotId)
    const snapshotsFolderId = await this.ensureFolder(
      this.rootFolderId,
      BACKUP_SNAPSHOTS_DIR,
      signal
    )
    const snapFolderId = await this.ensureFolder(snapshotsFolderId, snapshotId, signal)
    const existing = await this.findSingleChild(snapFolderId, fileName, signal)
    await this.uploadFile(
      snapFolderId,
      fileName,
      manifestBytes,
      fileName.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      existing?.id,
      signal
    )
  }

  public async readSnapshotManifest(
    snapshotId: string,
    signal?: AbortSignal,
    fileName = BACKUP_SNAPSHOT_MANIFEST_FILE
  ): Promise<Buffer | null> {
    const snapshotsFolderId = await this.findSingleFolder(
      this.rootFolderId,
      BACKUP_SNAPSHOTS_DIR,
      signal
    )
    if (!snapshotsFolderId) return null
    const snapFolderId = await this.findSingleFolder(snapshotsFolderId, snapshotId, signal)
    if (!snapFolderId) return null
    const file = await this.findSingleChild(snapFolderId, fileName, signal)
    if (!file) return null
    return this.downloadFileBytes(file.id, signal)
  }

  public async readSnapshotCompleteMarker(
    snapshotId: string,
    signal?: AbortSignal
  ): Promise<BackupSnapshotCompleteMarkerV1 | null> {
    const snapshotsFolderId = await this.findSingleFolder(
      this.rootFolderId,
      BACKUP_SNAPSHOTS_DIR,
      signal
    )
    if (!snapshotsFolderId) return null
    const snapFolderId = await this.findSingleFolder(snapshotsFolderId, snapshotId, signal)
    if (!snapFolderId) return null
    const file = await this.findSingleChild(snapFolderId, BACKUP_SNAPSHOT_COMPLETE_FILE, signal)
    if (!file) return null
    const bytes = await this.downloadFileBytes(file.id, signal)
    return BackupSnapshotCompleteMarkerV1Schema.parse(JSON.parse(bytes.toString('utf8')))
  }

  public async writeSnapshotCompleteMarker(
    snapshotId: string,
    marker: BackupSnapshotCompleteMarkerV1,
    signal?: AbortSignal
  ): Promise<void> {
    const validated = BackupSnapshotCompleteMarkerV1Schema.parse(marker)
    await this.hooks?.onBeforeCompleteMarker?.(snapshotId)
    const snapshotsFolderId = await this.ensureFolder(
      this.rootFolderId,
      BACKUP_SNAPSHOTS_DIR,
      signal
    )
    const snapFolderId = await this.ensureFolder(snapshotsFolderId, snapshotId, signal)
    const existing = await this.findSingleChild(snapFolderId, BACKUP_SNAPSHOT_COMPLETE_FILE, signal)
    if (existing) {
      throw new BackupSnapshotError(
        'destination_collision',
        `Snapshot "${snapshotId}" complete.json already exists on Google Drive`
      )
    }
    const bytes = Buffer.from(JSON.stringify(validated, null, 2), 'utf8')
    await this.uploadFile(
      snapFolderId,
      BACKUP_SNAPSHOT_COMPLETE_FILE,
      bytes,
      'application/json',
      undefined,
      signal,
      async (found) => {
        const downloaded = await this.downloadFileBytes(found.id, signal)
        const parsed = BackupSnapshotCompleteMarkerV1Schema.safeParse(
          JSON.parse(downloaded.toString('utf8'))
        )
        return (
          parsed.success &&
          parsed.data.snapshotId === validated.snapshotId &&
          parsed.data.repositoryId === validated.repositoryId &&
          parsed.data.manifestSha256 === validated.manifestSha256 &&
          parsed.data.completedAtMs === validated.completedAtMs
        )
      }
    )
  }

  public async listSnapshotIds(): Promise<string[]> {
    const snapshotsFolderId = await this.findSingleFolder(this.rootFolderId, BACKUP_SNAPSHOTS_DIR)
    if (!snapshotsFolderId) return []
    const children = await this.listChildren(
      snapshotsFolderId,
      `mimeType = '${DRIVE_FOLDER_MIME_TYPE}'`
    )
    const seen = new Set<string>()
    for (const child of children) {
      if (seen.has(child.name)) {
        throw new BackupSnapshotError(
          'destination_corrupt',
          `Ambiguous duplicate snapshot folders found on Google Drive for "${child.name}"`
        )
      }
      seen.add(child.name)
    }
    return children.map((c) => c.name)
  }

  public async cleanupTempDir(): Promise<void> {
    // Google Drive resumable sessions are server-managed; no remote temp folder to clean up.
  }
}
