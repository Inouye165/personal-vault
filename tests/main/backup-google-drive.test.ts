// @vitest-environment node
/**
 * Personal Vault — Stage 8B Slice 3: Google Drive Transport (Mocked Drive API v3) Tests
 *
 * Covers:
 * - Official Google Drive v3 resumable upload protocol (POST uploadType=resumable -> Location,
 *   256 KiB-aligned PUT chunks, 308 Resume Incomplete + Range tracking, 200 OK completion)
 * - Transient 503 / network interruption recovery via `Content-Range: bytes * /<total>` query
 * - Encrypted remote backup, listing, verification, and isolated restore from a completed snapshot
 * - Partial/aborted snapshot upload never appears as completed while earlier snapshot stays restorable
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BackupEncryptionKdfParams } from '../../src/shared/validation/backup-schemas'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { initializeVault } from '../../src/main/services/vault/identity'
import { writeVaultManifest } from '../../src/main/services/vault/manifest'
import type { VaultManifest } from '../../src/main/services/vault/types'
import { BackupCoordinator } from '../../src/main/services/backup/coordinator'
import {
  resumeBackupWithTransport,
  runBackupWithTransport
} from '../../src/main/services/backup/engine'
import { captureConsistentBackupSnapshot } from '../../src/main/services/backup/snapshot-capture'
import { BackupRestoreError, BackupSnapshotError } from '../../src/main/services/backup/errors'
import {
  createSqlDriveBandwidthMeter,
  createSqlDriveUploadStateStore,
  DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
  GoogleDriveTransport
} from '../../src/main/services/backup/google-drive-transport'
import {
  inspectRemoteRecoveryPointStatus,
  inspectRestoredProfileStatus,
  listRemoteRecoveryPoints,
  restoreRemoteRecoveryPointToIsolatedProfile,
  verifyRemoteRecoveryPoint
} from '../../src/main/services/backup/restore'

const TEST_KDF_PARAMS: BackupEncryptionKdfParams = {
  N: 1024,
  r: 8,
  p: 1,
  keyLenBytes: 32
}
const TEST_SECRET = 'drive-transport-test-secret-8b'
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

interface MockDriveFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  bytes: Buffer
  trashed: boolean
}

interface MockResumableSession {
  id: string
  name: string
  mimeType: string
  parents: string[]
  existingFileId?: string
  pregeneratedId?: string
  totalLength: number
  receivedBytes: number
  chunks: Buffer[]
}

class MockGoogleDriveServer {
  public readonly rootFolderId = 'root-drive-folder-1'
  public readonly files = new Map<string, MockDriveFile>()
  public readonly sessions = new Map<string, MockResumableSession>()
  public readonly hiddenFromListIds = new Set<string>()
  public readonly callLog: string[] = []
  public failNextChunkPutWith503 = false
  public dropNextChunkPutNetwork = false

  public constructor() {
    this.files.set(this.rootFolderId, {
      id: this.rootFolderId,
      name: 'Personal Vault Backup',
      mimeType: DRIVE_FOLDER_MIME,
      parents: [],
      bytes: Buffer.alloc(0),
      trashed: false
    })
  }

  public createFetch(): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const url = new URL(urlStr)
      const method = (init?.method ?? 'GET').toUpperCase()
      this.callLog.push(`${method} ${url.pathname}${url.search}`)

      // 1. Resumable session chunk PUT or status query
      if (url.pathname.startsWith('/upload/session/')) {
        const sessionId = url.pathname.slice('/upload/session/'.length)
        const session = this.sessions.get(sessionId)
        if (!session) {
          return new Response('Session not found', { status: 404 })
        }

        const headers = new Headers(init?.headers)
        const contentRange = headers.get('content-range')

        // Status query: Content-Range: bytes */<total>
        if (contentRange && contentRange.startsWith('bytes */')) {
          if (session.receivedBytes === 0) {
            return new Response(null, { status: 308 })
          }
          return new Response(null, {
            status: 308,
            headers: { Range: `bytes=0-${session.receivedBytes - 1}` }
          })
        }

        if (this.dropNextChunkPutNetwork) {
          this.dropNextChunkPutNetwork = false
          throw new Error('ECONNRESET simulated network drop')
        }
        if (this.failNextChunkPutWith503) {
          this.failNextChunkPutWith503 = false
          return new Response('Service Unavailable', { status: 503 })
        }

        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? '')
        if (!match) {
          return new Response('Missing or invalid Content-Range', { status: 400 })
        }
        const start = Number(match[1])
        const end = Number(match[2])
        const total = Number(match[3])
        if (total !== session.totalLength || start !== session.receivedBytes) {
          return new Response('Range mismatch', { status: 400 })
        }

        const chunkLen = end - start + 1
        const isFinal = end + 1 === total
        if (!isFinal && chunkLen % DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES !== 0) {
          return new Response('Non-final chunk must be a multiple of 256 KiB', { status: 400 })
        }

        const bodyBuf = Buffer.from(init?.body as Uint8Array)
        if (bodyBuf.length !== chunkLen) {
          return new Response('Content-Length mismatch', { status: 400 })
        }
        session.chunks.push(bodyBuf)
        session.receivedBytes += bodyBuf.length

        if (!isFinal) {
          return new Response(null, {
            status: 308,
            headers: { Range: `bytes=0-${session.receivedBytes - 1}` }
          })
        }

        // Finalize file in Drive only after all bytes are committed
        const fullBytes = Buffer.concat(session.chunks)
        const fileId = session.existingFileId ?? session.pregeneratedId ?? `file_${randomUUID()}`
        if (!session.existingFileId && this.files.has(fileId)) {
          return new Response('Duplicate file ID', { status: 409 })
        }
        this.files.set(fileId, {
          id: fileId,
          name: session.name,
          mimeType: session.mimeType,
          parents: session.parents,
          bytes: fullBytes,
          trashed: false
        })
        this.sessions.delete(sessionId)
        return new Response(
          JSON.stringify({
            id: fileId,
            name: session.name,
            mimeType: session.mimeType,
            size: String(fullBytes.length)
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      // 2. Upload endpoint: /upload/drive/v3/files
      if (url.pathname.startsWith('/upload/drive/v3/files')) {
        const uploadType = url.searchParams.get('uploadType')
        const existingFileId = method === 'PATCH' ? url.pathname.split('/').pop() : undefined

        if (uploadType === 'resumable') {
          const headers = new Headers(init?.headers)
          const totalLength = Number(headers.get('x-upload-content-length') ?? '0')
          const mimeType = headers.get('x-upload-content-type') ?? 'application/octet-stream'
          const meta = JSON.parse(String(init?.body ?? '{}')) as {
            id?: string
            name?: string
            parents?: string[]
          }
          if (!existingFileId && meta.id && this.files.has(meta.id)) {
            return new Response('Duplicate file ID', { status: 409 })
          }
          const existing = existingFileId ? this.files.get(existingFileId) : undefined
          const sessionId = randomUUID()
          this.sessions.set(sessionId, {
            id: sessionId,
            name: meta.name ?? existing?.name ?? 'unnamed',
            mimeType,
            parents: meta.parents ?? existing?.parents ?? [this.rootFolderId],
            existingFileId,
            pregeneratedId: meta.id,
            totalLength,
            receivedBytes: 0,
            chunks: []
          })
          return new Response(null, {
            status: 200,
            headers: {
              Location: `https://mock-drive.local/upload/session/${sessionId}`
            }
          })
        }

        if (uploadType === 'multipart') {
          const headers = new Headers(init?.headers)
          const ct = headers.get('content-type') ?? ''
          const boundaryMatch = /boundary=([^\s;]+)/.exec(ct)
          if (!boundaryMatch) {
            return new Response('Missing multipart boundary', { status: 400 })
          }
          const boundary = boundaryMatch[1]!
          const raw = Buffer.from(init?.body as Uint8Array)
          const marker = Buffer.from(`--${boundary}`)
          const parts: Buffer[] = []
          let pos = raw.indexOf(marker)
          while (pos !== -1) {
            const next = raw.indexOf(marker, pos + marker.length)
            if (next === -1) break
            parts.push(raw.subarray(pos + marker.length, next))
            pos = next
          }
          const metaPart = parts[0]!.toString('utf8')
          const metaJson = JSON.parse(metaPart.split('\r\n\r\n')[1]!.trim()) as {
            id?: string
            name?: string
            parents?: string[]
            mimeType?: string
          }
          if (!existingFileId && metaJson.id && this.files.has(metaJson.id)) {
            return new Response('Duplicate file ID', { status: 409 })
          }
          const dataPart = parts[1]!
          const headerEnd = dataPart.indexOf(Buffer.from('\r\n\r\n'))
          // Strip leading CRLFCRLF and trailing CRLF before next boundary
          const fileBytes = dataPart.subarray(headerEnd + 4, dataPart.length - 2)
          const existing = existingFileId ? this.files.get(existingFileId) : undefined
          const fileId = existingFileId ?? metaJson.id ?? `file_${randomUUID()}`
          this.files.set(fileId, {
            id: fileId,
            name: metaJson.name ?? existing?.name ?? 'unnamed',
            mimeType: metaJson.mimeType ?? existing?.mimeType ?? 'application/octet-stream',
            parents: metaJson.parents ?? existing?.parents ?? [this.rootFolderId],
            bytes: Buffer.from(fileBytes),
            trashed: false
          })
          return new Response(
            JSON.stringify({
              id: fileId,
              name: metaJson.name ?? existing?.name,
              mimeType: metaJson.mimeType,
              size: String(fileBytes.length)
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
      }

      // 3. Metadata & Media endpoints: /drive/v3/files
      if (url.pathname === '/drive/v3/files/generateIds' && method === 'GET') {
        const count = Number(url.searchParams.get('count') ?? '1')
        const ids = Array.from({ length: count }, () => `pv_${randomUUID()}`)
        return new Response(JSON.stringify({ kind: 'drive#generatedIds', space: 'drive', ids }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      if (url.pathname === '/drive/v3/files' && method === 'GET') {
        const q = url.searchParams.get('q') ?? ''
        const parentMatch = /'([^']+)' in parents/.exec(q)
        const nameMatch = /name = '([^']+)'/.exec(q)
        const mimeMatch = /mimeType = '([^']+)'/.exec(q)

        const matched = [...this.files.values()].filter((f) => {
          if (f.trashed) return false
          if (this.hiddenFromListIds.has(f.id)) return false
          if (parentMatch && !f.parents.includes(parentMatch[1]!)) return false
          if (nameMatch && f.name !== nameMatch[1]) return false
          if (mimeMatch && f.mimeType !== mimeMatch[1]) return false
          return true
        })

        return new Response(
          JSON.stringify({
            files: matched.map((f) => ({
              id: f.id,
              name: f.name,
              mimeType: f.mimeType,
              size: String(f.bytes.length)
            }))
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      if (url.pathname === '/drive/v3/files' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          id?: string
          name: string
          mimeType: string
          parents?: string[]
        }
        const id = body.id ?? `folder_${randomUUID()}`
        if (this.files.has(id)) {
          return new Response('Duplicate folder ID', { status: 409 })
        }
        this.files.set(id, {
          id,
          name: body.name,
          mimeType: body.mimeType,
          parents: body.parents ?? [],
          bytes: Buffer.alloc(0),
          trashed: false
        })
        return new Response(JSON.stringify({ id, name: body.name, mimeType: body.mimeType }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      if (url.pathname.startsWith('/drive/v3/files/')) {
        const fileId = decodeURIComponent(url.pathname.slice('/drive/v3/files/'.length))
        const file = this.files.get(fileId)
        if (!file || file.trashed) {
          return new Response('Not Found', { status: 404 })
        }
        if (method === 'GET' && url.searchParams.get('alt') === 'media') {
          return new Response(new Uint8Array(file.bytes), { status: 200 })
        }
        if (method === 'GET') {
          return new Response(
            JSON.stringify({
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              size: String(file.bytes.length),
              trashed: file.trashed
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (method === 'DELETE') {
          this.files.delete(fileId)
          return new Response(null, { status: 204 })
        }
      }

      return new Response(`Unhandled mock Drive route: ${method} ${urlStr}`, { status: 404 })
    }) as typeof fetch
  }
}

interface DriveFixture {
  rootDir: string
  userDataDir: string
  catalogPath: string
  annotationsDir: string
  sourceDir: string
  vaultDir: string
  catalog: CatalogDatabase
  journal: AnnotationJournal
  vaultId: string
  payloadSha256: string
  payloadBytes: Buffer
}

async function createDriveFixture(): Promise<DriveFixture> {
  const rootDir = mkdtempSync(join(tmpdir(), 'pv-8b-drive-'))
  const userDataDir = join(rootDir, 'userData')
  const catalogPath = join(userDataDir, 'vault-catalog.db')
  const annotationsDir = join(userDataDir, 'annotations')
  const sourceDir = join(rootDir, 'sources')
  const vaultDir = join(rootDir, 'vault')

  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })

  // ~640 KiB payload so 256 KiB Drive resumable upload splits into 3 chunks (256 KiB + 256 KiB + 128 KiB)
  const payloadBytes = Buffer.alloc(640 * 1024, 0x5a)
  payloadBytes.write('DRIVE-VAULT-START', 0)
  payloadBytes.write('DRIVE-VAULT-END', payloadBytes.length - 15)
  const payloadSha256 = sha256Hex(payloadBytes)
  const sourceFile = join(sourceDir, 'archive-photo.jpg')
  writeFileSync(sourceFile, payloadBytes)

  const journal = new AnnotationJournal({
    storageDir: annotationsDir,
    sourceRoots: () => [sourceDir],
    vaultPath: () => vaultDir
  })
  await journal.initialize()

  const catalog = CatalogDatabase.open({ catalogPath, journal })
  const now = Date.now()
  catalog.persistDiscoveryBatch(sourceDir, [
    {
      originalPath: sourceFile,
      fileName: 'archive-photo.jpg',
      extension: '.jpg',
      category: 'photo',
      byteSize: payloadBytes.length,
      birthtimeMs: now - 2000,
      mtimeMs: now - 2000,
      discoveredAtMs: now
    }
  ])

  const loc = catalog.queryFileLocations({ limit: 10 }).items[0]!
  catalog.recordHashObservationsBatch([
    {
      originalPath: sourceFile,
      sha256: payloadSha256,
      observedByteSize: payloadBytes.length,
      observedMtimeMs: loc.filesystemMtimeMs,
      hashedAtMs: now
    }
  ])
  const hashObs = catalog.getHashObservationsForFile(loc.id).items[0]!

  const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Drive Backup Vault' })
  catalog.registerVault({
    vaultId: identity.vaultId,
    vaultPath: vaultDir,
    name: identity.vaultName,
    createdAtMs: identity.createdAtMs
  })

  const prefix = payloadSha256.slice(0, 2)
  const payloadRel = `files/${prefix}/${payloadSha256}/archive-photo.jpg`
  const manifestRel = `files/${prefix}/${payloadSha256}/manifest.json`
  mkdirSync(join(vaultDir, 'files', prefix, payloadSha256), { recursive: true })
  writeFileSync(join(vaultDir, payloadRel), payloadBytes)

  const importJobId = randomUUID()
  const manifest: VaultManifest = {
    formatVersion: 1,
    vaultId: identity.vaultId,
    sha256: payloadSha256,
    byteSize: payloadBytes.length,
    managedCopy: {
      relativePath: payloadRel,
      fileName: 'archive-photo.jpg',
      publishedAtMs: now,
      verifiedSha256: payloadSha256,
      verifiedByteSize: payloadBytes.length
    },
    sources: [
      {
        fileLocationId: loc.id,
        originalPath: sourceFile,
        fileName: 'archive-photo.jpg',
        extension: '.jpg',
        category: 'photo',
        recordedFacts: {
          byteSize: payloadBytes.length,
          filesystemBirthtimeMs: loc.filesystemBirthtimeMs,
          filesystemMtimeMs: loc.filesystemMtimeMs,
          firstDiscoveredAtMs: loc.firstDiscoveredAtMs,
          lastSeenAtMs: loc.lastSeenAtMs,
          discoveryObservationId: loc.discoveryObservationId,
          hashObservationId: hashObs.id,
          hashVerifiedAtMs: hashObs.hashedAtMs
        },
        inferredMetadata: { inferredCaptureTimeMs: null },
        reviewDecisions: { isPreferred: false, duplicateReviewStatus: null },
        importResult: {
          importJobId,
          importedAtMs: now,
          verifiedSourceSha256: payloadSha256,
          verifiedSourceByteSize: payloadBytes.length,
          sourceStability: {
            preCopyMtimeMs: loc.filesystemMtimeMs ?? 0,
            postCopyMtimeMs: loc.filesystemMtimeMs ?? 0,
            preCopyByteSize: payloadBytes.length,
            postCopyByteSize: payloadBytes.length
          }
        }
      }
    ]
  }
  writeVaultManifest(vaultDir, manifest, importJobId)

  const copyRecord = catalog.recordVaultCopy({
    vaultId: identity.vaultId,
    sha256: payloadSha256,
    byteSize: payloadBytes.length,
    relativePath: payloadRel,
    manifestRelativePath: manifestRel,
    verifiedAtMs: now
  })
  catalog.createVaultImportJob({
    jobId: importJobId,
    vaultId: identity.vaultId,
    totalFiles: 1,
    totalBytes: payloadBytes.length,
    items: [
      {
        fileLocationId: loc.id,
        discoveryObservationId: loc.discoveryObservationId,
        hashObservationId: hashObs.id,
        sha256: payloadSha256,
        byteSize: payloadBytes.length
      }
    ]
  })
  catalog.updateVaultImportItem({
    jobId: importJobId,
    fileLocationId: loc.id,
    status: 'completed',
    vaultCopyId: copyRecord.id,
    completedAtMs: now
  })
  catalog.updateVaultImportStatus(importJobId, 'completed')

  catalog.setPhotoAnnotation({
    fileLocationId: loc.id,
    expectedRevision: `rev:${loc.discoveryObservationId}:${payloadBytes.length}:${loc.filesystemMtimeMs}:${payloadSha256}`,
    expectedVersion: 0,
    rating: 4,
    flag: 'pick'
  })

  return {
    rootDir,
    userDataDir,
    catalogPath,
    annotationsDir,
    sourceDir,
    vaultDir,
    catalog,
    journal,
    vaultId: identity.vaultId,
    payloadSha256,
    payloadBytes
  }
}

describe('Stage 8B Slice 3: Google Drive Transport (Mocked Drive API v3)', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()!()
    }
  })

  it('performs encrypted backup via Drive v3 resumable uploads, lists, verifies, and restores to an isolated profile', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const mockDrive = new MockGoogleDriveServer()
    const transport = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: mockDrive.createFetch(),
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES, // 256 KiB
      resumableThresholdBytes: 0,
      retryDelaysMs: [10, 20]
    })

    const snap1 = 'snap-drive-001'
    const result = await runBackupWithTransport({
      jobId: 'job-drive-1',
      snapshotId: snap1,
      transport,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    expect(result.writtenChunkCount).toBeGreaterThan(0)
    expect(mockDrive.callLog.some((c) => c.includes('uploadType=resumable'))).toBe(true)
    expect(mockDrive.callLog.some((c) => c.startsWith('PUT /upload/session/'))).toBe(true)
    expect(mockDrive.sessions.size).toBe(0)

    const listed = await listRemoteRecoveryPoints(transport)
    expect(listed.recoveryPoints).toHaveLength(1)
    expect(listed.recoveryPoints[0]?.snapshotId).toBe(snap1)
    expect(listed.recoveryPoints[0]?.isComplete).toBe(true)
    expect(listed.recoveryPoints[0]?.integrityStatus).toBe('sealed_unverified')

    const verified = await verifyRemoteRecoveryPoint({
      transport,
      snapshotId: snap1,
      recoverySecret: TEST_SECRET
    })
    expect(verified.snapshotId).toBe(snap1)
    expect(verified.hasVault).toBe(true)
    expect(verified.hasAnnotations).toBe(true)

    const targetProfileDir = join(fx.rootDir, 'drive-restored-profile')
    const targetVaultDir = join(fx.rootDir, 'drive-restored-vault')
    const restored = await restoreRemoteRecoveryPointToIsolatedProfile({
      transport,
      snapshotId: snap1,
      targetProfileDir,
      targetVaultDir,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir],
      recoverySecret: TEST_SECRET
    })

    expect(restored.snapshotId).toBe(snap1)
    expect(inspectRestoredProfileStatus(targetProfileDir, targetVaultDir).status).toBe('complete')
    const restoredFile = join(
      targetVaultDir,
      'files',
      fx.payloadSha256.slice(0, 2),
      fx.payloadSha256,
      'archive-photo.jpg'
    )
    expect(sha256Hex(readFileSync(restoredFile))).toBe(fx.payloadSha256)
  })

  it('recovers interrupted resumable chunk uploads via 308 Range status query without restarting from byte 0', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const mockDrive = new MockGoogleDriveServer()
    const baseFetch = mockDrive.createFetch()
    let injected503 = false
    let injectedDrop = false

    // Inject a 503 on the second chunk PUT of the first multi-chunk upload,
    // and a network drop on the second chunk PUT of the next upload
    const faultFetch: typeof fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      const range = headers.get('content-range') ?? ''
      if (urlStr.includes('/upload/session/') && range.startsWith('bytes 262144-')) {
        if (!injected503) {
          injected503 = true
          mockDrive.failNextChunkPutWith503 = true
        } else if (!injectedDrop) {
          injectedDrop = true
          mockDrive.dropNextChunkPutNetwork = true
        }
      }
      return baseFetch(input, init)
    }

    const transport = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: faultFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      retryDelaysMs: [5, 10]
    })

    const snap1 = 'snap-drive-retry-1'
    await runBackupWithTransport({
      jobId: 'job-drive-retry-1',
      snapshotId: snap1,
      transport,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    expect(injected503).toBe(true)
    const verified = await verifyRemoteRecoveryPoint({
      transport,
      snapshotId: snap1,
      recoverySecret: TEST_SECRET
    })
    expect(verified.snapshotId).toBe(snap1)
  })

  it('never lists a partial upload as complete and keeps earlier completed snapshots restorable', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const mockDrive = new MockGoogleDriveServer()
    const baseOptions = {
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: mockDrive.createFetch(),
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      retryDelaysMs: [5, 10]
    }

    const transport1 = new GoogleDriveTransport(baseOptions)
    const snap1 = 'snap-drive-complete-1'
    await runBackupWithTransport({
      jobId: 'job-drive-c1',
      snapshotId: snap1,
      transport: transport1,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    // Start snap2 and fail right before complete.json is published
    const snap2 = 'snap-drive-partial-2'
    const transport2 = new GoogleDriveTransport({
      ...baseOptions,
      hooks: {
        onBeforeCompleteMarker() {
          throw new BackupSnapshotError(
            'destination_unavailable',
            'Simulated disconnect before complete.json'
          )
        }
      }
    })

    await expect(
      runBackupWithTransport({
        jobId: 'job-drive-p2',
        snapshotId: snap2,
        transport: transport2,
        catalogPath: fx.catalogPath,
        annotationsDir: fx.annotationsDir,
        userDataDir: fx.userDataDir,
        sourceRoots: [fx.sourceDir],
        vaultRoots: [fx.vaultDir],
        appVersion: '0.1.0-test',
        encryptionMode: 'aes-256-gcm-v1',
        recoverySecret: TEST_SECRET,
        kdfParams: TEST_KDF_PARAMS
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'destination_unavailable'
    )

    // Partial snap2 must NOT appear as completed, and must be rejected by verify/restore
    const listed = await listRemoteRecoveryPoints(transport1)
    const entry1 = listed.recoveryPoints.find((r) => r.snapshotId === snap1)!
    const entry2 = listed.recoveryPoints.find((r) => r.snapshotId === snap2)!
    expect(entry1.isComplete).toBe(true)
    expect(entry1.integrityStatus).toBe('sealed_unverified')
    expect(entry2.isComplete).toBe(false)
    expect(entry2.integrityStatus).toBe('incomplete')

    const partialInspection = await inspectRemoteRecoveryPointStatus(transport1, snap2)
    expect(partialInspection.isComplete).toBe(false)
    expect(partialInspection.reasons).toContain('in_progress_marker_present')
    expect(partialInspection.reasons).toContain('completion_marker_missing')

    await expect(
      verifyRemoteRecoveryPoint({
        transport: transport1,
        snapshotId: snap2,
        recoverySecret: TEST_SECRET
      })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof BackupRestoreError && err.code === 'recovery_point_incomplete'
    )

    // Earlier completed snapshot snap1 remains fully restorable
    const targetProfileDir = join(fx.rootDir, 'drive-prior-profile')
    const targetVaultDir = join(fx.rootDir, 'drive-prior-vault')
    const restored = await restoreRemoteRecoveryPointToIsolatedProfile({
      transport: transport1,
      snapshotId: snap1,
      targetProfileDir,
      targetVaultDir,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir],
      recoverySecret: TEST_SECRET
    })
    expect(restored.snapshotId).toBe(snap1)
    expect(inspectRestoredProfileStatus(targetProfileDir, targetVaultDir).status).toBe('complete')
  })

  it('enforces encryption on Google Drive writes (rejects omitted mode and existing plaintext repositories)', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const mockDrive = new MockGoogleDriveServer()
    const transport = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: mockDrive.createFetch(),
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      retryDelaysMs: [5, 10]
    })

    // 1. Omitted encryptionMode on a new Google Drive repository must be rejected
    await expect(
      runBackupWithTransport({
        jobId: 'job-drive-noenc',
        snapshotId: 'snap-drive-noenc',
        transport,
        catalogPath: fx.catalogPath,
        annotationsDir: fx.annotationsDir,
        userDataDir: fx.userDataDir,
        sourceRoots: [fx.sourceDir],
        vaultRoots: [fx.vaultDir],
        appVersion: '0.1.0-test'
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'destination_corrupt'
    )
    expect([...mockDrive.files.values()].some((f) => f.name === 'repository.json')).toBe(false)

    // 2. Existing plaintext repository.json on Drive must be rejected before uploading any payload
    mockDrive.files.set('plain-repo-json', {
      id: 'plain-repo-json',
      name: 'repository.json',
      mimeType: 'application/json',
      parents: [mockDrive.rootFolderId],
      bytes: Buffer.from(
        JSON.stringify({
          formatVersion: 1,
          repositoryId: randomUUID(),
          createdAtMs: Date.now(),
          appVersion: '0.1.0-test',
          chunkSizeBytes: 4 * 1024 * 1024,
          encryptionMode: 'none',
          encryption: null
        }),
        'utf8'
      ),
      trashed: false
    })

    await expect(
      runBackupWithTransport({
        jobId: 'job-drive-existing-plain',
        snapshotId: 'snap-drive-existing-plain',
        transport,
        catalogPath: fx.catalogPath,
        annotationsDir: fx.annotationsDir,
        userDataDir: fx.userDataDir,
        sourceRoots: [fx.sourceDir],
        vaultRoots: [fx.vaultDir],
        appVersion: '0.1.0-test',
        encryptionMode: 'aes-256-gcm-v1',
        recoverySecret: TEST_SECRET,
        kdfParams: TEST_KDF_PARAMS
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'destination_corrupt'
    )
    expect(await transport.listSnapshotIds()).toEqual([])
  })

  it('handles 308 without Range, bounds repeated no-progress retries, and recovers a lost final PUT response', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    // Part A: 308 without Range header resets to confirmed offset 0 (no skipped bytes),
    // and lost final PUT response is recovered via status probe
    const mockDriveA = new MockGoogleDriveServer()
    const baseFetchA = mockDriveA.createFetch()
    let returned308NoRange = false
    let droppedFinalPut = false

    const edgeFetchA: typeof fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      const range = headers.get('content-range') ?? ''
      const method = (init?.method ?? 'GET').toUpperCase()

      if (
        urlStr.includes('/upload/session/') &&
        method === 'PUT' &&
        !range.startsWith('bytes */')
      ) {
        if (!returned308NoRange && range.startsWith('bytes 0-')) {
          returned308NoRange = true
          // Return 308 with NO Range header without storing the chunk
          return new Response(null, { status: 308 })
        }
        // On a final chunk PUT (where end + 1 === total), commit on server then drop the response
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)
        if (m && Number(m[2]) + 1 === Number(m[3]) && Number(m[3]) > 262144 && !droppedFinalPut) {
          droppedFinalPut = true
          await baseFetchA(input, init)
          throw new Error('ECONNRESET lost final PUT response')
        }
      }
      return baseFetchA(input, init)
    }

    const transportA = new GoogleDriveTransport({
      rootFolderId: mockDriveA.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: edgeFetchA,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      retryDelaysMs: [5, 10]
    })

    const snapA = 'snap-drive-edge-a'
    await runBackupWithTransport({
      jobId: 'job-drive-edge-a',
      snapshotId: snapA,
      transport: transportA,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    expect(returned308NoRange).toBe(true)
    expect(droppedFinalPut).toBe(true)
    const verifiedA = await verifyRemoteRecoveryPoint({
      transport: transportA,
      snapshotId: snapA,
      recoverySecret: TEST_SECRET
    })
    expect(verifiedA.snapshotId).toBe(snapA)

    // Part B: Repeated no-progress 308-without-Range failures fail closed after bounded retries
    const mockDriveB = new MockGoogleDriveServer()
    const baseFetchB = mockDriveB.createFetch()
    let stuckPutCount = 0
    const stuckFetchB: typeof fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      const range = headers.get('content-range') ?? ''
      if (urlStr.includes('/upload/session/') && !range.startsWith('bytes */')) {
        stuckPutCount += 1
        return new Response(null, { status: 308 })
      }
      return baseFetchB(input, init)
    }

    const transportB = new GoogleDriveTransport({
      rootFolderId: mockDriveB.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: stuckFetchB,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      retryDelaysMs: [1, 1]
    })

    await expect(
      transportB.writeObjectAtomic('a'.repeat(64), Buffer.alloc(300 * 1024, 0x11), 'job-stuck')
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'destination_unavailable'
    )
    expect(stuckPutCount).toBe(3) // 1 initial + 2 retries
  })

  it('safely reconciles lost POST responses on snapshot folders and complete.json, and rejects conflicting duplicates', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const mockDrive = new MockGoogleDriveServer()
    const baseFetch = mockDrive.createFetch()
    let droppedSnapshotFolderPost = false
    let droppedCompletePost = false

    const baseTransport = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: baseFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      retryDelaysMs: [5, 10]
    })

    // 1. First completed snapshot snap1
    const snap1 = 'snap-drive-dup-1'
    await runBackupWithTransport({
      jobId: 'job-drive-dup-1',
      snapshotId: snap1,
      transport: baseTransport,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    // 2. Snapshot 2 experiences lost POST responses on both snapshot folder creation and complete.json upload
    const snap2 = 'snap-drive-reconcile-2'
    const reconcilingFetch: typeof fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (urlStr.endsWith('/drive/v3/files') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string }
        if (body.name === snap2 && !droppedSnapshotFolderPost) {
          droppedSnapshotFolderPost = true
          await baseFetch(input, init)
          throw new Error('ECONNRESET lost folder POST response')
        }
      }
      if (
        (urlStr.includes('uploadType=multipart') || urlStr.includes('uploadType=resumable')) &&
        method === 'POST'
      ) {
        const raw =
          typeof init?.body === 'string'
            ? init.body
            : Buffer.from(init?.body as Uint8Array).toString('utf8')
        if (raw.includes('"name":"complete.json"') && !droppedCompletePost) {
          droppedCompletePost = true
          await baseFetch(input, init)
          throw new Error('ECONNRESET lost complete.json POST response')
        }
      }
      return baseFetch(input, init)
    }

    const transport2 = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: reconcilingFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      retryDelaysMs: [5, 10]
    })

    await runBackupWithTransport({
      jobId: 'job-drive-reconcile-2',
      snapshotId: snap2,
      transport: transport2,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    expect(droppedSnapshotFolderPost).toBe(true)
    expect(droppedCompletePost).toBe(true)
    // Reconciled without creating duplicate snapshot folders or duplicate complete.json
    const snap2Folders = [...mockDrive.files.values()].filter(
      (f) => f.name === snap2 && f.mimeType === DRIVE_FOLDER_MIME
    )
    expect(snap2Folders).toHaveLength(1)
    const snap2Completes = [...mockDrive.files.values()].filter(
      (f) => f.name === 'complete.json' && f.parents.includes(snap2Folders[0]!.id)
    )
    expect(snap2Completes).toHaveLength(1)

    // 3. Inject a conflicting duplicate complete.json into snap2 -> rejected with destination_corrupt,
    // while earlier completed snapshot snap1 remains restorable
    mockDrive.files.set('dup-complete-json', {
      id: 'dup-complete-json',
      name: 'complete.json',
      mimeType: 'application/json',
      parents: [snap2Folders[0]!.id],
      bytes: Buffer.from('{"corrupt":"duplicate"}', 'utf8'),
      trashed: false
    })

    await expect(inspectRemoteRecoveryPointStatus(baseTransport, snap2)).resolves.toMatchObject({
      isComplete: false,
      integrityStatus: 'incomplete'
    })

    // Duplicate snapshot folder is rejected with destination_corrupt
    const snapshotsFolder = [...mockDrive.files.values()].find(
      (f) => f.name === 'snapshots' && f.mimeType === DRIVE_FOLDER_MIME
    )!
    mockDrive.files.set('dup-snap2-folder', {
      id: 'dup-snap2-folder',
      name: snap2,
      mimeType: DRIVE_FOLDER_MIME,
      parents: [snapshotsFolder.id],
      bytes: Buffer.alloc(0),
      trashed: false
    })

    await expect(baseTransport.listSnapshotIds()).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'destination_corrupt'
    )

    // Earlier completed snapshot snap1 remains restorable directly by snapshotId
    const targetProfileDir = join(fx.rootDir, 'dup-prior-profile')
    const targetVaultDir = join(fx.rootDir, 'dup-prior-vault')
    const restored = await restoreRemoteRecoveryPointToIsolatedProfile({
      transport: baseTransport,
      snapshotId: snap1,
      targetProfileDir,
      targetVaultDir,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir],
      recoverySecret: TEST_SECRET
    })
    expect(restored.snapshotId).toBe(snap1)
    expect(inspectRestoredProfileStatus(targetProfileDir, targetVaultDir).status).toBe('complete')
  })

  it('binds resumable sessions to exact ciphertext bytes when resuming an interrupted encrypted backup', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const mockDrive = new MockGoogleDriveServer()
    const baseFetch = mockDrive.createFetch()
    const sessionStore = new Map<string, string>()

    // Interrupt on the second 256 KiB chunk PUT of the multi-chunk vault payload (after chunk 0 is uploaded)
    let aborted = false
    const abortController = new AbortController()
    const interruptFetch: typeof fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      const range = headers.get('content-range') ?? ''
      if (urlStr.includes('/upload/session/') && range.startsWith('bytes 262144-') && !aborted) {
        aborted = true
        abortController.abort()
        throw new Error('Aborted mid-ciphertext chunk upload')
      }
      return baseFetch(input, init)
    }

    const jobId = 'job-drive-cipher-resume'
    const snapshotId = 'snap-drive-cipher-resume'
    const stagingDir = join(fx.userDataDir, '.backup-staging', jobId)
    const captured = await captureConsistentBackupSnapshot({
      jobId,
      snapshotId,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      stagingDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir]
    })

    const transport1 = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: interruptFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      sessionStore,
      retryDelaysMs: [5, 10]
    })

    await expect(
      resumeBackupWithTransport(
        {
          jobId,
          snapshotId,
          transport: transport1,
          catalogPath: fx.catalogPath,
          annotationsDir: fx.annotationsDir,
          userDataDir: fx.userDataDir,
          sourceRoots: [fx.sourceDir],
          vaultRoots: [fx.vaultDir],
          appVersion: '0.1.0-test',
          encryptionMode: 'aes-256-gcm-v1',
          recoverySecret: TEST_SECRET,
          kdfParams: TEST_KDF_PARAMS,
          signal: abortController.signal
        },
        captured
      )
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'backup_cancelled'
    )

    // Old ciphertext session remains in sessionStore
    expect(aborted).toBe(true)
    expect(sessionStore.size).toBeGreaterThan(0)
    const staleSessionCount = sessionStore.size

    // Recreate transport with the SAME sessionStore and resume through the engine;
    // Aes256GcmObjectCodec generates fresh nonces -> different ciphertext SHA-256 -> fresh sessions!
    const transport2 = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: baseFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      sessionStore,
      retryDelaysMs: [5, 10]
    })

    await resumeBackupWithTransport(
      {
        jobId,
        snapshotId,
        transport: transport2,
        catalogPath: fx.catalogPath,
        annotationsDir: fx.annotationsDir,
        userDataDir: fx.userDataDir,
        sourceRoots: [fx.sourceDir],
        vaultRoots: [fx.vaultDir],
        appVersion: '0.1.0-test',
        encryptionMode: 'aes-256-gcm-v1',
        recoverySecret: TEST_SECRET,
        kdfParams: TEST_KDF_PARAMS
      },
      captured
    )

    // Stale session key was not cleared/spliced; new ciphertext completed cleanly
    expect(sessionStore.size).toBe(staleSessionCount)

    const targetProfileDir = join(fx.rootDir, 'cipher-resume-profile')
    const targetVaultDir = join(fx.rootDir, 'cipher-resume-vault')
    const restored = await restoreRemoteRecoveryPointToIsolatedProfile({
      transport: transport2,
      snapshotId,
      targetProfileDir,
      targetVaultDir,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir],
      recoverySecret: TEST_SECRET
    })
    expect(restored.snapshotId).toBe(snapshotId)
    expect(inspectRestoredProfileStatus(targetProfileDir, targetVaultDir).status).toBe('complete')
    const restoredFile = join(
      targetVaultDir,
      'files',
      fx.payloadSha256.slice(0, 2),
      fx.payloadSha256,
      'archive-photo.jpg'
    )
    expect(sha256Hex(readFileSync(restoredFile))).toBe(fx.payloadSha256)
  })

  it('treats 308 at final byte without a committed file as incomplete instead of complete', async () => {
    const mockDrive = new MockGoogleDriveServer()
    const baseFetch = mockDrive.createFetch()

    const uncommittedFinal308Fetch: typeof fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      const range = headers.get('content-range') ?? ''
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)
      if (urlStr.includes('/upload/session/') && m && Number(m[2]) + 1 === Number(m[3])) {
        // Respond 308 reaching the final byte WITHOUT committing the file in Drive
        return new Response(null, {
          status: 308,
          headers: { Range: `bytes=0-${Number(m[3]) - 1}` }
        })
      }
      return baseFetch(input, init)
    }

    const transport = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: uncommittedFinal308Fetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      retryDelaysMs: [1, 1]
    })

    const objId = 'b'.repeat(64)
    await expect(
      transport.writeObjectAtomic(objId, Buffer.alloc(300 * 1024, 0x22), 'job-308-final')
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'destination_unavailable'
    )
    expect(await transport.statObject(objId)).toEqual({ exists: false, byteSize: 0 })
  })

  it('reconciles lost POST responses via pregenerated IDs under delayed listing visibility while keeping earlier snapshots restorable', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const mockDrive = new MockGoogleDriveServer()
    const baseFetch = mockDrive.createFetch()
    const baseTransport = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: baseFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      retryDelaysMs: [5, 10]
    })

    // 1. Completed snapshot 1
    const snap1 = 'snap-drive-delayed-1'
    await runBackupWithTransport({
      jobId: 'job-drive-delayed-1',
      snapshotId: snap1,
      transport: baseTransport,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    // 2. Snapshot 2: simulate lost POST response + delayed listing visibility (hiddenFromListIds)
    // for BOTH the snapshot folder and complete.json
    const snap2 = 'snap-drive-delayed-2'
    let droppedFolderPost = false
    let droppedCompletePost = false
    let hiddenFolderId: string | null = null
    let hiddenCompleteId: string | null = null

    const delayedListFetch: typeof fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (urlStr.endsWith('/drive/v3/files') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { id?: string; name?: string }
        if (body.name === snap2 && !droppedFolderPost) {
          droppedFolderPost = true
          const res = await baseFetch(input, init)
          const created = (await res.json()) as { id: string }
          hiddenFolderId = created.id
          mockDrive.hiddenFromListIds.add(created.id)
          throw new Error('ECONNRESET lost folder POST with delayed list visibility')
        }
      }
      if (urlStr.includes('uploadType=resumable') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { id?: string; name?: string }
        if (body.name === 'complete.json' && !droppedCompletePost) {
          droppedCompletePost = true
          // Let initiate + PUTs succeed, then hide complete.json from list and drop response?
          // Also test direct multipart lost POST below; for resumable complete.json we use multipartThreshold > complete.json size
        }
      }
      if (urlStr.includes('uploadType=multipart') && method === 'POST') {
        const raw = Buffer.from(init?.body as Uint8Array).toString('utf8')
        if (raw.includes('"name":"complete.json"') && !droppedCompletePost) {
          droppedCompletePost = true
          const res = await baseFetch(input, init)
          const created = (await res.json()) as { id: string }
          hiddenCompleteId = created.id
          mockDrive.hiddenFromListIds.add(created.id)
          throw new Error('ECONNRESET lost complete.json POST with delayed list visibility')
        }
      }
      return baseFetch(input, init)
    }

    const transport2 = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: delayedListFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 16 * 1024, // multipart for small complete.json, resumable for chunks
      retryDelaysMs: [5, 10]
    })

    await runBackupWithTransport({
      jobId: 'job-drive-delayed-2',
      snapshotId: snap2,
      transport: transport2,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    expect(droppedFolderPost).toBe(true)
    expect(droppedCompletePost).toBe(true)
    expect(hiddenFolderId).not.toBeNull()
    expect(hiddenCompleteId).not.toBeNull()

    // Unhide after eventual consistency catches up, and verify zero duplicates were created
    mockDrive.hiddenFromListIds.clear()
    const snap2Folders = [...mockDrive.files.values()].filter(
      (f) => f.name === snap2 && f.mimeType === DRIVE_FOLDER_MIME
    )
    expect(snap2Folders).toHaveLength(1)
    const snap2Completes = [...mockDrive.files.values()].filter(
      (f) => f.name === 'complete.json' && f.parents.includes(snap2Folders[0]!.id)
    )
    expect(snap2Completes).toHaveLength(1)

    // Both snap1 and snap2 restore cleanly
    const targetProfile1 = join(fx.rootDir, 'delayed-restore-1-profile')
    const targetVault1 = join(fx.rootDir, 'delayed-restore-1-vault')
    const restored1 = await restoreRemoteRecoveryPointToIsolatedProfile({
      transport: baseTransport,
      snapshotId: snap1,
      targetProfileDir: targetProfile1,
      targetVaultDir: targetVault1,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir],
      recoverySecret: TEST_SECRET
    })
    expect(restored1.snapshotId).toBe(snap1)
    expect(inspectRestoredProfileStatus(targetProfile1, targetVault1).status).toBe('complete')

    const targetProfile2 = join(fx.rootDir, 'delayed-restore-2-profile')
    const targetVault2 = join(fx.rootDir, 'delayed-restore-2-vault')
    const restored2 = await restoreRemoteRecoveryPointToIsolatedProfile({
      transport: baseTransport,
      snapshotId: snap2,
      targetProfileDir: targetProfile2,
      targetVaultDir: targetVault2,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir],
      recoverySecret: TEST_SECRET
    })
    expect(restored2.snapshotId).toBe(snap2)
    expect(inspectRestoredProfileStatus(targetProfile2, targetVault2).status).toBe('complete')
  })

  it('persists pregenerated Drive ID and resumable session across DB close/reopen, recovers lost final PUT without duplicates, and rejects mismatched bytes', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const mockDrive = new MockGoogleDriveServer()
    const baseFetch = mockDrive.createFetch()

    const repo1 = fx.catalog.getBackupRepository()
    const dest = repo1.createDestination({
      id: 'dest-drive-durable',
      name: 'Google Drive Durable',
      kind: 'google_drive',
      targetPath: null,
      encryptionMode: 'aes-256-gcm-v1',
      dailyBudgetBytes: 50 * 1024 * 1024
    })
    const job1 = repo1.createJob({
      id: 'job-durable-1',
      destinationId: dest.id,
      snapshotId: 'snap-durable-1',
      status: 'running'
    })

    // 1. Interrupt after chunk 0 of a 400 KiB object upload
    const payloadA = Buffer.alloc(400 * 1024, 0x33)
    const objIdA = sha256Hex(payloadA)
    const ac1 = new AbortController()
    let chunk0Uploaded = false
    const interruptAfterChunk0Fetch: typeof fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      const range = headers.get('content-range') ?? ''
      if (urlStr.includes('/upload/session/') && range.startsWith('bytes 262144-')) {
        chunk0Uploaded = true
        ac1.abort()
        throw new Error('Simulated crash after chunk 0')
      }
      return baseFetch(input, init)
    }

    const transport1 = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: interruptAfterChunk0Fetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      uploadStateStore: createSqlDriveUploadStateStore(repo1, dest.id, job1.id),
      retryDelaysMs: [5, 10]
    })

    await expect(
      transport1.writeObjectAtomic(objIdA, payloadA, job1.id, { signal: ac1.signal })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'backup_cancelled'
    )
    expect(chunk0Uploaded).toBe(true)

    // Close DB and reopen to prove durable state survives process/DB restart
    fx.catalog.close()
    fx.catalog = CatalogDatabase.open({ catalogPath: fx.catalogPath, journal: fx.journal })
    const repo2 = fx.catalog.getBackupRepository()

    // Verify mismatched upload bytes do NOT resume the stale session
    const payloadDifferent = Buffer.alloc(400 * 1024, 0x44)
    const diffTransport = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: baseFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      uploadStateStore: createSqlDriveUploadStateStore(repo2, dest.id, job1.id),
      retryDelaysMs: [5, 10]
    })
    // Put a different object with the same name/parent only if we test same objIdA with altered bytes:
    // Re-run objIdA with payloadDifferent -> must NOT splice old session; must start fresh session & overwrite/upload payloadDifferent
    const callsBeforeMismatch = mockDrive.callLog.length
    await diffTransport.writeObjectAtomic(objIdA, payloadDifferent, job1.id)
    const mismatchCalls = mockDrive.callLog.slice(callsBeforeMismatch)
    expect(mismatchCalls.some((c) => c.includes('uploadType=resumable'))).toBe(true)
    expect(sha256Hex(await diffTransport.readObject(objIdA))).toBe(sha256Hex(payloadDifferent))

    // 2. Now test lost final PUT response across DB close & reopen on a fresh object objIdB
    const payloadB = Buffer.alloc(400 * 1024, 0x55)
    const objIdB = sha256Hex(payloadB)
    const ac2 = new AbortController()
    let droppedFinalPut = false
    const dropFinalPutFetch: typeof fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      const range = headers.get('content-range') ?? ''
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)
      if (urlStr.includes('/upload/session/') && m && Number(m[2]) + 1 === Number(m[3])) {
        droppedFinalPut = true
        const res = await baseFetch(input, init)
        const committed = (await res.json()) as { id: string }
        // Hide from files.list AND abort so transport crashes before seeing 200 OK
        mockDrive.hiddenFromListIds.add(committed.id)
        ac2.abort()
        throw new Error('Simulated process crash after final PUT committed')
      }
      return baseFetch(input, init)
    }

    const transport2 = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: dropFinalPutFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      uploadStateStore: createSqlDriveUploadStateStore(repo2, dest.id, job1.id),
      retryDelaysMs: [5, 10]
    })

    await expect(
      transport2.writeObjectAtomic(objIdB, payloadB, job1.id, { signal: ac2.signal })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'backup_cancelled'
    )
    expect(droppedFinalPut).toBe(true)

    // Close DB and reopen again
    fx.catalog.close()
    fx.catalog = CatalogDatabase.open({ catalogPath: fx.catalogPath, journal: fx.journal })
    const repo3 = fx.catalog.getBackupRepository()

    const callsBeforeReconcile = mockDrive.callLog.length
    const transport3 = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: baseFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      uploadStateStore: createSqlDriveUploadStateStore(repo3, dest.id, job1.id),
      retryDelaysMs: [5, 10]
    })

    await transport3.writeObjectAtomic(objIdB, payloadB, job1.id)
    const reconcileCalls = mockDrive.callLog.slice(callsBeforeReconcile)
    // Reconciled via persisted pregeneratedFileId without initiating a new upload
    expect(reconcileCalls.some((c) => c.includes('uploadType=resumable'))).toBe(false)

    mockDrive.hiddenFromListIds.clear()
    const matchingFiles = [...mockDrive.files.values()].filter(
      (f) => f.name === `${objIdB}.pvchunk`
    )
    expect(matchingFiles).toHaveLength(1)
    expect(sha256Hex(await transport3.readObject(objIdB))).toBe(objIdB)
  })

  it('reserves rolling bandwidth before each upload attempt including retries, persists budget across DB restart, and restores completed snapshot', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const mockDrive = new MockGoogleDriveServer()
    const baseFetch = mockDrive.createFetch()
    const nowMs = 1_700_000_000_000

    const repo1 = fx.catalog.getBackupRepository()
    const dest = repo1.createDestination({
      id: 'dest-drive-budget',
      name: 'Google Drive Budgeted',
      kind: 'google_drive',
      targetPath: null,
      encryptionMode: 'aes-256-gcm-v1',
      dailyBudgetBytes: 16 * 1024 * 1024 // minimum 16 MiB destination budget
    })
    const job1 = repo1.createJob({
      id: 'job-budget-1',
      destinationId: dest.id,
      snapshotId: 'snap-budget-1',
      status: 'running'
    })
    // Pre-reserve all but 400 KiB of the 16 MiB rolling 24h budget
    const preReservedBytes = 16 * 1024 * 1024 - 400 * 1024
    repo1.recordBandwidthReservation({
      destinationId: dest.id,
      jobId: job1.id,
      bytesReserved: preReservedBytes,
      recordedAtMs: nowMs
    })

    // Inject a 503 on the first 256 KiB chunk PUT so the retry consumes another 256 KiB (512 KiB > 400 KiB budget)
    let injected503 = false
    const retry503Fetch: typeof fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      const range = headers.get('content-range') ?? ''
      if (urlStr.includes('/upload/session/') && range.startsWith('bytes 0-') && !injected503) {
        injected503 = true
        return new Response('Service Unavailable', { status: 503 })
      }
      return baseFetch(input, init)
    }

    const transport1 = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: retry503Fetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      uploadStateStore: createSqlDriveUploadStateStore(repo1, dest.id, job1.id),
      bandwidthMeter: createSqlDriveBandwidthMeter(
        repo1,
        dest.id,
        dest.dailyBudgetBytes,
        job1.id,
        () => nowMs
      ),
      retryDelaysMs: [5, 10]
    })

    const objId = 'c'.repeat(64)
    await expect(
      transport1.writeObjectAtomic(objId, Buffer.alloc(300 * 1024, 0x66), job1.id)
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'daily_budget_exhausted'
    )
    expect(injected503).toBe(true)

    // Close DB and reopen: preReservedBytes + 256 KiB from the failed attempt survived restart!
    fx.catalog.close()
    fx.catalog = CatalogDatabase.open({ catalogPath: fx.catalogPath, journal: fx.journal })
    const repo2 = fx.catalog.getBackupRepository()
    expect(repo2.getRolling24hBandwidthBytes(dest.id, nowMs)).toBe(preReservedBytes + 256 * 1024)

    // Remaining budget is 144 KiB; a 200 KiB upload must still be rejected after restart
    const transport2 = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: baseFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      uploadStateStore: createSqlDriveUploadStateStore(repo2, dest.id, job1.id),
      bandwidthMeter: createSqlDriveBandwidthMeter(
        repo2,
        dest.id,
        dest.dailyBudgetBytes,
        job1.id,
        () => nowMs
      ),
      retryDelaysMs: [5, 10]
    })
    await expect(
      transport2.writeObjectAtomic('d'.repeat(64), Buffer.alloc(200 * 1024, 0x77), job1.id)
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'daily_budget_exhausted'
    )

    // Advance past 24h rolling window so earlier reservations expire, leaving full 16 MiB budget
    const laterMs = nowMs + 86_400_001
    const transport3 = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: baseFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      uploadStateStore: createSqlDriveUploadStateStore(repo2, dest.id, job1.id),
      bandwidthMeter: createSqlDriveBandwidthMeter(
        repo2,
        dest.id,
        dest.dailyBudgetBytes,
        job1.id,
        () => laterMs
      ),
      retryDelaysMs: [5, 10]
    })

    const snapId = 'snap-budget-complete'
    await runBackupWithTransport({
      jobId: job1.id,
      snapshotId: snapId,
      transport: transport3,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir],
      appVersion: '0.1.0-test',
      encryptionMode: 'aes-256-gcm-v1',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS
    })

    expect(repo2.getRolling24hBandwidthBytes(dest.id, laterMs)).toBeGreaterThan(640 * 1024)

    const targetProfileDir = join(fx.rootDir, 'budget-restored-profile')
    const targetVaultDir = join(fx.rootDir, 'budget-restored-vault')
    const restored = await restoreRemoteRecoveryPointToIsolatedProfile({
      transport: transport3,
      snapshotId: snapId,
      targetProfileDir,
      targetVaultDir,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir],
      recoverySecret: TEST_SECRET
    })
    expect(restored.snapshotId).toBe(snapId)
    expect(inspectRestoredProfileStatus(targetProfileDir, targetVaultDir).status).toBe('complete')
    const restoredFile = join(
      targetVaultDir,
      'files',
      fx.payloadSha256.slice(0, 2),
      fx.payloadSha256,
      'archive-photo.jpg'
    )
    expect(sha256Hex(readFileSync(restoredFile))).toBe(fx.payloadSha256)
  })

  it('reconciles a hidden committed encrypted chunk by persisted Drive ID across DB reopen and engine resume with fresh ciphertext', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const mockDrive = new MockGoogleDriveServer()
    const baseFetch = mockDrive.createFetch()

    const repo1 = fx.catalog.getBackupRepository()
    const dest = repo1.createDestination({
      id: 'dest-engine-reconcile',
      name: 'Google Drive Engine Reconcile',
      kind: 'google_drive',
      targetPath: null,
      encryptionMode: 'aes-256-gcm-v1',
      dailyBudgetBytes: 50 * 1024 * 1024
    })
    const jobId = 'job-engine-reconcile-1'
    const snapshotId = 'snap-engine-reconcile-1'
    repo1.createJob({
      id: jobId,
      destinationId: dest.id,
      snapshotId,
      status: 'running'
    })

    const stagingDir = join(fx.userDataDir, '.backup-staging', jobId)
    const captured = await captureConsistentBackupSnapshot({
      jobId,
      snapshotId,
      catalogPath: fx.catalogPath,
      annotationsDir: fx.annotationsDir,
      stagingDir,
      userDataDir: fx.userDataDir,
      sourceRoots: [fx.sourceDir],
      vaultRoots: [fx.vaultDir]
    })

    // Commit the multi-chunk encrypted vault payload on Drive, hide it from files.list,
    // and crash before the final PUT response returns
    let hiddenChunkName: string | null = null
    const ac = new AbortController()
    const crashOnFinalPutFetch: typeof fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      const range = headers.get('content-range') ?? ''
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)
      if (
        urlStr.includes('/upload/session/') &&
        m &&
        Number(m[2]) + 1 === Number(m[3]) &&
        Number(m[3]) > 262144 &&
        hiddenChunkName === null
      ) {
        const res = await baseFetch(input, init)
        const committed = (await res.json()) as { id: string; name: string }
        hiddenChunkName = committed.name
        mockDrive.hiddenFromListIds.add(committed.id)
        ac.abort()
        throw new Error('Simulated crash after final encrypted chunk PUT committed')
      }
      return baseFetch(input, init)
    }

    const transport1 = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: crashOnFinalPutFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      uploadStateStore: createSqlDriveUploadStateStore(repo1, dest.id, jobId),
      bandwidthMeter: createSqlDriveBandwidthMeter(repo1, dest.id, dest.dailyBudgetBytes, jobId),
      retryDelaysMs: [5, 10]
    })

    await expect(
      resumeBackupWithTransport(
        {
          jobId,
          snapshotId,
          transport: transport1,
          catalogPath: fx.catalogPath,
          annotationsDir: fx.annotationsDir,
          userDataDir: fx.userDataDir,
          sourceRoots: [fx.sourceDir],
          vaultRoots: [fx.vaultDir],
          appVersion: '0.1.0-test',
          encryptionMode: 'aes-256-gcm-v1',
          recoverySecret: TEST_SECRET,
          kdfParams: TEST_KDF_PARAMS,
          signal: ac.signal
        },
        captured
      )
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'backup_cancelled'
    )
    expect(hiddenChunkName).not.toBeNull()

    // Close and reopen SQLite while the committed chunk remains hidden from files.list
    fx.catalog.close()
    fx.catalog = CatalogDatabase.open({ catalogPath: fx.catalogPath, journal: fx.journal })
    const repo2 = fx.catalog.getBackupRepository()

    const transport2 = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: baseFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 0,
      uploadStateStore: createSqlDriveUploadStateStore(repo2, dest.id, jobId),
      bandwidthMeter: createSqlDriveBandwidthMeter(repo2, dest.id, dest.dailyBudgetBytes, jobId),
      retryDelaysMs: [5, 10]
    })

    // Resume through the engine: Aes256GcmObjectCodec generates fresh nonces (different ciphertext!),
    // transport reconciles the hidden chunk via persisted Drive ID, and engine validates it via decodeChunk
    const resumed = await resumeBackupWithTransport(
      {
        jobId,
        snapshotId,
        transport: transport2,
        catalogPath: fx.catalogPath,
        annotationsDir: fx.annotationsDir,
        userDataDir: fx.userDataDir,
        sourceRoots: [fx.sourceDir],
        vaultRoots: [fx.vaultDir],
        appVersion: '0.1.0-test',
        encryptionMode: 'aes-256-gcm-v1',
        recoverySecret: TEST_SECRET,
        kdfParams: TEST_KDF_PARAMS
      },
      captured
    )
    expect(resumed.reusedChunkCount).toBeGreaterThanOrEqual(1)

    // Unhide and prove there is exactly ONE Drive file for that chunk
    mockDrive.hiddenFromListIds.clear()
    const chunkFiles = [...mockDrive.files.values()].filter((f) => f.name === hiddenChunkName)
    expect(chunkFiles).toHaveLength(1)

    const targetProfileDir = join(fx.rootDir, 'engine-reconcile-profile')
    const targetVaultDir = join(fx.rootDir, 'engine-reconcile-vault')
    const restored = await restoreRemoteRecoveryPointToIsolatedProfile({
      transport: transport2,
      snapshotId,
      targetProfileDir,
      targetVaultDir,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir],
      recoverySecret: TEST_SECRET
    })
    expect(restored.snapshotId).toBe(snapshotId)
    expect(inspectRestoredProfileStatus(targetProfileDir, targetVaultDir).status).toBe('complete')
    const restoredFile = join(
      targetVaultDir,
      'files',
      fx.payloadSha256.slice(0, 2),
      fx.payloadSha256,
      'archive-photo.jpg'
    )
    expect(sha256Hex(readFileSync(restoredFile))).toBe(fx.payloadSha256)
  })

  it('pauses a Drive job on rolling budget exhaustion with staging intact, survives restart, and resumes when budget clears', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const mockDrive = new MockGoogleDriveServer()
    const baseFetch = mockDrive.createFetch()
    let currentTimeMs = 1_700_000_000_000

    const coordinator1 = new BackupCoordinator({
      catalog: fx.catalog,
      userDataDir: fx.userDataDir,
      appVersion: '0.1.0-test',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS,
      googleDrive: {
        rootFolderId: mockDrive.rootFolderId,
        getAccessToken: () => 'mock-access-token',
        fetchFn: baseFetch,
        apiBaseUrl: 'https://mock-drive.local/drive/v3',
        uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
        uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
        resumableThresholdBytes: 0,
        retryDelaysMs: [5, 10],
        nowMs: () => currentTimeMs
      }
    })
    await coordinator1.initialize()

    const dest = coordinator1.configureDestination({
      name: 'Google Drive Coordinator Budget',
      kind: 'google_drive',
      targetPath: mockDrive.rootFolderId,
      dailyBudgetBytes: 16 * 1024 * 1024,
      encryptionMode: 'aes-256-gcm-v1'
    })

    // Pre-reserve all but 400 KiB of the 16 MiB rolling 24h budget
    fx.catalog.getBackupRepository().recordBandwidthReservation({
      destinationId: dest.id,
      bytesReserved: 16 * 1024 * 1024 - 400 * 1024,
      recordedAtMs: currentTimeMs
    })

    const snapId = 'snap-coord-budget-1'
    const started = await coordinator1.startBackup(dest.id, { snapshotId: snapId })
    const paused = await coordinator1.waitForCompletion()

    expect(paused?.id).toBe(started.id)
    expect(paused?.status).toBe('paused')
    expect(paused?.pauseReason).toBe('daily_budget_exhausted')
    expect(paused?.stagingDir).toBeTruthy()
    expect(existsSync(paused!.stagingDir!)).toBe(true)

    // Shut down coordinator and close/reopen SQLite
    await coordinator1.shutdown()
    fx.catalog.close()
    fx.catalog = CatalogDatabase.open({ catalogPath: fx.catalogPath, journal: fx.journal })

    const coordinator2 = new BackupCoordinator({
      catalog: fx.catalog,
      userDataDir: fx.userDataDir,
      appVersion: '0.1.0-test',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS,
      googleDrive: {
        rootFolderId: mockDrive.rootFolderId,
        getAccessToken: () => 'mock-access-token',
        fetchFn: baseFetch,
        apiBaseUrl: 'https://mock-drive.local/drive/v3',
        uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
        uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
        resumableThresholdBytes: 0,
        retryDelaysMs: [5, 10],
        nowMs: () => currentTimeMs
      }
    })
    await coordinator2.initialize()

    const persistedJob = coordinator2.getJob(started.id)
    expect(persistedJob?.status).toBe('paused')
    expect(persistedJob?.pauseReason).toBe('daily_budget_exhausted')
    expect(existsSync(persistedJob!.stagingDir!)).toBe(true)

    // Advance past 24h rolling window so budget becomes available, then resume
    currentTimeMs += 86_400_001
    await coordinator2.resumeBackup(started.id)
    const completed = await coordinator2.waitForCompletion()
    expect(completed?.status).toBe('completed')
    expect(completed?.snapshotId).toBe(snapId)
    expect(existsSync(persistedJob!.stagingDir!)).toBe(false)

    // Restore completed snapshot into a fresh isolated profile
    const verifyTransport = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: baseFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3'
    })
    const targetProfileDir = join(fx.rootDir, 'coord-budget-profile')
    const targetVaultDir = join(fx.rootDir, 'coord-budget-vault')
    const restored = await restoreRemoteRecoveryPointToIsolatedProfile({
      transport: verifyTransport,
      snapshotId: snapId,
      targetProfileDir,
      targetVaultDir,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir],
      recoverySecret: TEST_SECRET
    })
    expect(restored.snapshotId).toBe(snapId)
    expect(inspectRestoredProfileStatus(targetProfileDir, targetVaultDir).status).toBe('complete')
    const restoredFile = join(
      targetVaultDir,
      'files',
      fx.payloadSha256.slice(0, 2),
      fx.payloadSha256,
      'archive-photo.jpg'
    )
    expect(sha256Hex(readFileSync(restoredFile))).toBe(fx.payloadSha256)
    await coordinator2.shutdown()
  })

  it('reconciles a remotely committed Drive completion marker across restart when SQLite commit was lost and restores the snapshot', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const mockDrive = new MockGoogleDriveServer()
    const baseFetch = mockDrive.createFetch()
    let coordinator1Ref: BackupCoordinator | null = null
    let committedCompleteMarker = false

    // Commit complete.json on Drive and delete .pv-snapshot-in-progress.json, then trigger
    // coordinator shutdown before SQLite records completion (job ends up 'interrupted')
    const crashAfterRemoteCompleteFetch: typeof fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (urlStr.includes('uploadType=multipart') && method === 'POST') {
        const raw = Buffer.from(init?.body as Uint8Array).toString('utf8')
        if (raw.includes('"name":"complete.json"')) {
          committedCompleteMarker = true
          return baseFetch(input, init)
        }
      }
      if (committedCompleteMarker && method === 'DELETE' && urlStr.includes('/drive/v3/files/')) {
        await baseFetch(input, init)
        if (coordinator1Ref) {
          void coordinator1Ref.shutdown()
        }
        throw new Error('Simulated crash after remote complete.json commit before SQLite commit')
      }
      return baseFetch(input, init)
    }

    const coordinator1 = new BackupCoordinator({
      catalog: fx.catalog,
      userDataDir: fx.userDataDir,
      appVersion: '0.1.0-test',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS,
      googleDrive: {
        rootFolderId: mockDrive.rootFolderId,
        getAccessToken: () => 'mock-access-token',
        fetchFn: crashAfterRemoteCompleteFetch,
        apiBaseUrl: 'https://mock-drive.local/drive/v3',
        uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
        uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
        resumableThresholdBytes: 16 * 1024, // multipart for small complete.json, resumable for chunks
        retryDelaysMs: [5, 10]
      }
    })
    coordinator1Ref = coordinator1
    await coordinator1.initialize()

    const dest = coordinator1.configureDestination({
      name: 'Google Drive Reconcile',
      kind: 'google_drive',
      targetPath: mockDrive.rootFolderId,
      encryptionMode: 'aes-256-gcm-v1'
    })

    const snapId = 'snap-coord-remote-reconcile'
    const started = await coordinator1.startBackup(dest.id, { snapshotId: snapId })
    const interrupted = await coordinator1.waitForCompletion()

    expect(committedCompleteMarker).toBe(true)
    expect(interrupted?.status).toBe('interrupted')

    // Close and reopen SQLite
    fx.catalog.close()
    fx.catalog = CatalogDatabase.open({ catalogPath: fx.catalogPath, journal: fx.journal })

    const coordinator2 = new BackupCoordinator({
      catalog: fx.catalog,
      userDataDir: fx.userDataDir,
      appVersion: '0.1.0-test',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS,
      googleDrive: {
        rootFolderId: mockDrive.rootFolderId,
        getAccessToken: () => 'mock-access-token',
        fetchFn: baseFetch,
        apiBaseUrl: 'https://mock-drive.local/drive/v3',
        uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
        uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
        resumableThresholdBytes: 16 * 1024,
        retryDelaysMs: [5, 10]
      }
    })
    await coordinator2.initialize()

    const reconciled = await coordinator2.resumeBackup(started.id)
    expect(reconciled.status).toBe('completed')
    expect(reconciled.snapshotId).toBe(snapId)
    expect(existsSync(join(fx.userDataDir, '.backup-staging', started.id))).toBe(false)

    // Restore reconciled snapshot into a fresh isolated profile
    const verifyTransport = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: baseFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3'
    })
    const targetProfileDir = join(fx.rootDir, 'coord-reconcile-profile')
    const targetVaultDir = join(fx.rootDir, 'coord-reconcile-vault')
    const restored = await restoreRemoteRecoveryPointToIsolatedProfile({
      transport: verifyTransport,
      snapshotId: snapId,
      targetProfileDir,
      targetVaultDir,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir],
      recoverySecret: TEST_SECRET
    })
    expect(restored.snapshotId).toBe(snapId)
    expect(inspectRestoredProfileStatus(targetProfileDir, targetVaultDir).status).toBe('complete')
    const restoredFile = join(
      targetVaultDir,
      'files',
      fx.payloadSha256.slice(0, 2),
      fx.payloadSha256,
      'archive-photo.jpg'
    )
    expect(sha256Hex(readFileSync(restoredFile))).toBe(fx.payloadSha256)
    await coordinator2.shutdown()
  })

  it('recovers a markerless snapshot folder created before budget exhaustion via durable ownership, while still rejecting unrelated markerless folders', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const mockDrive = new MockGoogleDriveServer()
    const baseFetch = mockDrive.createFetch()
    let currentTimeMs = 1_700_000_000_000

    const coordinator1 = new BackupCoordinator({
      catalog: fx.catalog,
      userDataDir: fx.userDataDir,
      appVersion: '0.1.0-test',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS,
      googleDrive: {
        rootFolderId: mockDrive.rootFolderId,
        getAccessToken: () => 'mock-access-token',
        fetchFn: baseFetch,
        apiBaseUrl: 'https://mock-drive.local/drive/v3',
        uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
        uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
        resumableThresholdBytes: 16 * 1024,
        retryDelaysMs: [5, 10],
        nowMs: () => currentTimeMs
      }
    })
    await coordinator1.initialize()

    const dest = coordinator1.configureDestination({
      name: 'Google Drive Markerless Recovery',
      kind: 'google_drive',
      targetPath: mockDrive.rootFolderId,
      dailyBudgetBytes: 16 * 1024 * 1024,
      encryptionMode: 'aes-256-gcm-v1'
    })

    // Reserve exact budget so repository.json succeeds (~1 KiB), snapshots/<snapId> folder is created,
    // and .pv-snapshot-in-progress.json (~200 B) exhausts the rolling budget immediately before upload!
    const snapId = 'snap-coord-markerless-1'
    let exhaustNext = false
    const repo1 = fx.catalog.getBackupRepository()

    const budgetOnMarkerFetch: typeof fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      const res = await baseFetch(input, init)
      if (!exhaustNext && urlStr.endsWith('/drive/v3/files') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string }
        if (body.name === snapId) {
          exhaustNext = true
          // Fill remaining budget so the very next upload (.pv-snapshot-in-progress.json) hits daily_budget_exhausted
          const used = repo1.getRolling24hBandwidthBytes(dest.id, currentTimeMs)
          repo1.recordBandwidthReservation({
            destinationId: dest.id,
            bytesReserved: 16 * 1024 * 1024 - used,
            recordedAtMs: currentTimeMs
          })
        }
      }
      return res
    }

    // Re-create coordinator1 with budgetOnMarkerFetch
    await coordinator1.shutdown()
    const coordinator1b = new BackupCoordinator({
      catalog: fx.catalog,
      userDataDir: fx.userDataDir,
      appVersion: '0.1.0-test',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS,
      googleDrive: {
        rootFolderId: mockDrive.rootFolderId,
        getAccessToken: () => 'mock-access-token',
        fetchFn: budgetOnMarkerFetch,
        apiBaseUrl: 'https://mock-drive.local/drive/v3',
        uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
        uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
        resumableThresholdBytes: 16 * 1024,
        retryDelaysMs: [5, 10],
        nowMs: () => currentTimeMs
      }
    })
    await coordinator1b.initialize()

    const started = await coordinator1b.startBackup(dest.id, { snapshotId: snapId })
    const paused = await coordinator1b.waitForCompletion()

    expect(exhaustNext).toBe(true)
    expect(paused?.status).toBe('paused')
    expect(paused?.pauseReason).toBe('daily_budget_exhausted')

    // Confirm snapshots/<snapId> exists on Drive WITHOUT .pv-snapshot-in-progress.json
    const snapFolder = [...mockDrive.files.values()].find(
      (f) => f.name === snapId && f.mimeType === DRIVE_FOLDER_MIME
    )
    expect(snapFolder).toBeDefined()
    const inProgOnDrive = [...mockDrive.files.values()].find(
      (f) => f.name === '.pv-snapshot-in-progress.json' && f.parents.includes(snapFolder!.id)
    )
    expect(inProgOnDrive).toBeUndefined()

    // Also prove an unrelated markerless folder in snapshots/ is still rejected
    const snapshotsFolder = [...mockDrive.files.values()].find(
      (f) => f.name === 'snapshots' && f.mimeType === DRIVE_FOLDER_MIME
    )!
    mockDrive.files.set('foreign-markerless-folder', {
      id: 'foreign-markerless-folder',
      name: 'snap-foreign-markerless',
      mimeType: DRIVE_FOLDER_MIME,
      parents: [snapshotsFolder.id],
      bytes: Buffer.alloc(0),
      trashed: false
    })
    const checkTransport = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: baseFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadStateStore: createSqlDriveUploadStateStore(repo1, dest.id, started.id)
    })
    await expect(
      checkTransport.claimOrResumeSnapshotInProgress('snap-foreign-markerless', {
        formatVersion: 1,
        schema: 'pv_backup_in_progress_v1',
        jobId: started.id,
        snapshotId: 'snap-foreign-markerless',
        repositoryId: paused!.repositoryId!,
        startedAtMs: currentTimeMs
      })
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BackupSnapshotError && err.code === 'destination_collision'
    )

    // Close and reopen SQLite, roll over budget past 24h, and resume the SAME job
    await coordinator1b.shutdown()
    fx.catalog.close()
    fx.catalog = CatalogDatabase.open({ catalogPath: fx.catalogPath, journal: fx.journal })

    currentTimeMs += 86_400_001
    const coordinator2 = new BackupCoordinator({
      catalog: fx.catalog,
      userDataDir: fx.userDataDir,
      appVersion: '0.1.0-test',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS,
      googleDrive: {
        rootFolderId: mockDrive.rootFolderId,
        getAccessToken: () => 'mock-access-token',
        fetchFn: baseFetch,
        apiBaseUrl: 'https://mock-drive.local/drive/v3',
        uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
        uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
        resumableThresholdBytes: 16 * 1024,
        retryDelaysMs: [5, 10],
        nowMs: () => currentTimeMs
      }
    })
    await coordinator2.initialize()

    await coordinator2.resumeBackup(started.id)
    const completed = await coordinator2.waitForCompletion()
    expect(completed?.id).toBe(started.id)
    expect(completed?.snapshotId).toBe(snapId)
    expect(completed?.status).toBe('completed')

    const targetProfileDir = join(fx.rootDir, 'markerless-recover-profile')
    const targetVaultDir = join(fx.rootDir, 'markerless-recover-vault')
    const restored = await restoreRemoteRecoveryPointToIsolatedProfile({
      transport: new GoogleDriveTransport({
        rootFolderId: mockDrive.rootFolderId,
        getAccessToken: () => 'mock-access-token',
        fetchFn: baseFetch,
        apiBaseUrl: 'https://mock-drive.local/drive/v3',
        uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3'
      }),
      snapshotId: snapId,
      targetProfileDir,
      targetVaultDir,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir],
      recoverySecret: TEST_SECRET
    })
    expect(restored.snapshotId).toBe(snapId)
    expect(inspectRestoredProfileStatus(targetProfileDir, targetVaultDir).status).toBe('complete')
    const restoredFile = join(
      targetVaultDir,
      'files',
      fx.payloadSha256.slice(0, 2),
      fx.payloadSha256,
      'archive-photo.jpg'
    )
    expect(sha256Hex(readFileSync(restoredFile))).toBe(fx.payloadSha256)
    await coordinator2.shutdown()
  })

  it('reconciles a Drive snapshot when complete.json committed and response was lost before clearing in-progress marker', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })

    const mockDrive = new MockGoogleDriveServer()
    const baseFetch = mockDrive.createFetch()
    let coordinator1Ref: BackupCoordinator | null = null
    let committedCompleteMarker = false

    // Commit complete.json on Drive, then crash/shutdown BEFORE .pv-snapshot-in-progress.json is deleted,
    // leaving BOTH markers on Drive!
    const crashBeforeDeleteMarkerFetch: typeof fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (urlStr.includes('uploadType=multipart') && method === 'POST') {
        const raw = Buffer.from(init?.body as Uint8Array).toString('utf8')
        if (raw.includes('"name":"complete.json"') && !committedCompleteMarker) {
          committedCompleteMarker = true
          await baseFetch(input, init)
          if (coordinator1Ref) {
            void coordinator1Ref.shutdown()
          }
          throw new Error(
            'Simulated crash after complete.json commit before deleting in-progress marker'
          )
        }
      }
      return baseFetch(input, init)
    }

    const coordinator1 = new BackupCoordinator({
      catalog: fx.catalog,
      userDataDir: fx.userDataDir,
      appVersion: '0.1.0-test',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS,
      googleDrive: {
        rootFolderId: mockDrive.rootFolderId,
        getAccessToken: () => 'mock-access-token',
        fetchFn: crashBeforeDeleteMarkerFetch,
        apiBaseUrl: 'https://mock-drive.local/drive/v3',
        uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
        uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
        resumableThresholdBytes: 16 * 1024,
        retryDelaysMs: [5, 10]
      }
    })
    coordinator1Ref = coordinator1
    await coordinator1.initialize()

    const dest = coordinator1.configureDestination({
      name: 'Google Drive Both Markers',
      kind: 'google_drive',
      targetPath: mockDrive.rootFolderId,
      encryptionMode: 'aes-256-gcm-v1'
    })

    const snapId = 'snap-coord-both-markers'
    const started = await coordinator1.startBackup(dest.id, { snapshotId: snapId })
    const interrupted = await coordinator1.waitForCompletion()

    expect(committedCompleteMarker).toBe(true)
    expect(interrupted?.status).toBe('interrupted')

    // Confirm BOTH complete.json and .pv-snapshot-in-progress.json exist on Drive
    const checkTransport = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: baseFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3'
    })
    expect(await checkTransport.hasSnapshotInProgress(snapId)).toBe(true)
    expect(await checkTransport.readSnapshotCompleteMarker(snapId)).not.toBeNull()

    // Close and reopen SQLite
    fx.catalog.close()
    fx.catalog = CatalogDatabase.open({ catalogPath: fx.catalogPath, journal: fx.journal })

    const coordinator2 = new BackupCoordinator({
      catalog: fx.catalog,
      userDataDir: fx.userDataDir,
      appVersion: '0.1.0-test',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS,
      googleDrive: {
        rootFolderId: mockDrive.rootFolderId,
        getAccessToken: () => 'mock-access-token',
        fetchFn: baseFetch,
        apiBaseUrl: 'https://mock-drive.local/drive/v3',
        uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
        uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
        resumableThresholdBytes: 16 * 1024,
        retryDelaysMs: [5, 10]
      }
    })
    await coordinator2.initialize()

    // Reconciles ownership + completed snapshot, clears stale in-progress marker, finishes SAME job
    const reconciled = await coordinator2.resumeBackup(started.id)
    expect(reconciled.id).toBe(started.id)
    expect(reconciled.status).toBe('completed')
    expect(reconciled.snapshotId).toBe(snapId)
    expect(await checkTransport.hasSnapshotInProgress(snapId)).toBe(false)
    expect(await checkTransport.listSnapshotIds()).toEqual([snapId])

    const targetProfileDir = join(fx.rootDir, 'both-markers-profile')
    const targetVaultDir = join(fx.rootDir, 'both-markers-vault')
    const restored = await restoreRemoteRecoveryPointToIsolatedProfile({
      transport: checkTransport,
      snapshotId: snapId,
      targetProfileDir,
      targetVaultDir,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir],
      recoverySecret: TEST_SECRET
    })
    expect(restored.snapshotId).toBe(snapId)
    expect(inspectRestoredProfileStatus(targetProfileDir, targetVaultDir).status).toBe('complete')
    const restoredFile = join(
      targetVaultDir,
      'files',
      fx.payloadSha256.slice(0, 2),
      fx.payloadSha256,
      'archive-photo.jpg'
    )
    expect(sha256Hex(readFileSync(restoredFile))).toBe(fx.payloadSha256)
    await coordinator2.shutdown()
  })

  it('keeps job, staging, and upload state retryable across restart when resuming a budget-paused Drive job with missing or wrong recovery secret, then completes with the correct secret', async () => {
    const fx = await createDriveFixture()
    cleanups.push(() => {
      try {
        fx.catalog.close()
      } catch {
        // ignore
      }
      rmSync(fx.rootDir, { recursive: true, force: true })
    })
    const mockDrive = new MockGoogleDriveServer()
    const baseFetch = mockDrive.createFetch()

    let currentTimeMs = 1_730_000_000_000
    const coordinator1 = new BackupCoordinator({
      catalog: fx.catalog,
      userDataDir: fx.userDataDir,
      appVersion: '0.1.0-test',
      recoverySecret: TEST_SECRET,
      kdfParams: TEST_KDF_PARAMS,
      googleDrive: {
        rootFolderId: mockDrive.rootFolderId,
        getAccessToken: () => 'mock-access-token',
        fetchFn: baseFetch,
        apiBaseUrl: 'https://mock-drive.local/drive/v3',
        uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
        uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
        resumableThresholdBytes: 16 * 1024,
        retryDelaysMs: [5, 10],
        nowMs: () => currentTimeMs
      }
    })
    await coordinator1.initialize()

    const dest = coordinator1.configureDestination({
      name: 'Google Drive Retryable Secret',
      kind: 'google_drive',
      targetPath: mockDrive.rootFolderId,
      dailyBudgetBytes: 16 * 1024 * 1024,
      encryptionMode: 'aes-256-gcm-v1'
    })

    // Pre-reserve all but 400 KiB so the backup pauses for daily_budget_exhausted mid-transfer
    fx.catalog.getBackupRepository().recordBandwidthReservation({
      destinationId: dest.id,
      bytesReserved: 16 * 1024 * 1024 - 400 * 1024,
      recordedAtMs: currentTimeMs
    })

    const snapId = 'snap-coord-retry-secret-1'
    const started = await coordinator1.startBackup(dest.id, { snapshotId: snapId })
    const paused = await coordinator1.waitForCompletion()

    expect(paused?.id).toBe(started.id)
    expect(paused?.status).toBe('paused')
    expect(paused?.pauseReason).toBe('daily_budget_exhausted')
    expect(paused?.stagingDir).toBeTruthy()
    expect(existsSync(paused!.stagingDir!)).toBe(true)

    const uploadStateBeforeRestart = fx.catalog
      .getRawDb()
      .prepare('SELECT * FROM backup_drive_upload_state WHERE destination_id = ?')
      .all(dest.id) as Array<Record<string, unknown>>
    expect(uploadStateBeforeRestart.length).toBeGreaterThan(0)

    // Shut down coordinator and close/reopen SQLite without supplying recoverySecret
    await coordinator1.shutdown()
    fx.catalog.close()
    fx.catalog = CatalogDatabase.open({ catalogPath: fx.catalogPath, journal: fx.journal })

    // Advance 25 hours so the rolling 24h budget clears
    currentTimeMs += 25 * 60 * 60 * 1000

    const coordinator2 = new BackupCoordinator({
      catalog: fx.catalog,
      userDataDir: fx.userDataDir,
      appVersion: '0.1.0-test',
      kdfParams: TEST_KDF_PARAMS,
      googleDrive: {
        rootFolderId: mockDrive.rootFolderId,
        getAccessToken: () => 'mock-access-token',
        fetchFn: baseFetch,
        apiBaseUrl: 'https://mock-drive.local/drive/v3',
        uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
        uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
        resumableThresholdBytes: 16 * 1024,
        retryDelaysMs: [5, 10],
        nowMs: () => currentTimeMs
      }
    })
    await coordinator2.initialize()

    // 1. Resume with missing secret -> stays paused & retryable with staging + upload state intact
    const resumedMissing = await coordinator2.resumeBackup(started.id)
    const missingSecretJob =
      (await coordinator2.waitForCompletion()) ??
      fx.catalog.getBackupRepository().getJob(started.id) ??
      resumedMissing
    expect(missingSecretJob.id).toBe(started.id)
    expect(missingSecretJob.status).toBe('paused')
    expect(missingSecretJob.errorCode).toBe('recovery_secret_required')
    expect(existsSync(paused!.stagingDir!)).toBe(true)
    expect(
      fx.catalog
        .getRawDb()
        .prepare('SELECT * FROM backup_drive_upload_state WHERE destination_id = ?')
        .all(dest.id)
    ).toEqual(uploadStateBeforeRestart)

    // 2. Resume with wrong secret -> stays paused & retryable with staging + upload state intact
    const resumedWrong = await coordinator2.resumeBackup(started.id, {
      recoverySecret: 'wrong-secret-attempt'
    })
    const wrongSecretJob =
      (await coordinator2.waitForCompletion()) ??
      fx.catalog.getBackupRepository().getJob(started.id) ??
      resumedWrong
    expect(wrongSecretJob.id).toBe(started.id)
    expect(wrongSecretJob.status).toBe('paused')
    expect(wrongSecretJob.errorCode).toBe('wrong_recovery_secret')
    expect(existsSync(paused!.stagingDir!)).toBe(true)
    expect(
      fx.catalog
        .getRawDb()
        .prepare('SELECT * FROM backup_drive_upload_state WHERE destination_id = ?')
        .all(dest.id)
    ).toEqual(uploadStateBeforeRestart)

    // 3. Resume with correct secret -> completes the SAME job and restores cleanly
    const resumedCorrect = await coordinator2.resumeBackup(started.id, {
      recoverySecret: TEST_SECRET
    })
    const completed =
      (await coordinator2.waitForCompletion()) ??
      fx.catalog.getBackupRepository().getJob(started.id) ??
      resumedCorrect
    expect(completed.id).toBe(started.id)
    expect(completed.status).toBe('completed')
    expect(completed.snapshotId).toBe(snapId)

    const checkTransport = new GoogleDriveTransport({
      rootFolderId: mockDrive.rootFolderId,
      getAccessToken: () => 'mock-access-token',
      fetchFn: baseFetch,
      apiBaseUrl: 'https://mock-drive.local/drive/v3',
      uploadBaseUrl: 'https://mock-drive.local/upload/drive/v3',
      uploadChunkSizeBytes: DRIVE_RESUMABLE_CHUNK_ALIGN_BYTES,
      resumableThresholdBytes: 16 * 1024,
      retryDelaysMs: [5, 10]
    })
    const targetProfileDir = join(fx.rootDir, 'retry-secret-profile')
    const targetVaultDir = join(fx.rootDir, 'retry-secret-vault')
    const restored = await restoreRemoteRecoveryPointToIsolatedProfile({
      transport: checkTransport,
      snapshotId: snapId,
      targetProfileDir,
      targetVaultDir,
      activeUserDataDir: fx.userDataDir,
      activeSourceRoots: [fx.sourceDir],
      activeVaultRoots: [fx.vaultDir],
      recoverySecret: TEST_SECRET
    })
    expect(restored.snapshotId).toBe(snapId)
    expect(inspectRestoredProfileStatus(targetProfileDir, targetVaultDir).status).toBe('complete')
    const restoredFile = join(
      targetVaultDir,
      'files',
      fx.payloadSha256.slice(0, 2),
      fx.payloadSha256,
      'archive-photo.jpg'
    )
    expect(sha256Hex(readFileSync(restoredFile))).toBe(fx.payloadSha256)
    await coordinator2.shutdown()
  })
})
