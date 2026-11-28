// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import { registerBackupIpcHandlers } from '../../src/main/ipc/backup-handlers'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import { BackupCoordinator } from '../../src/main/services/backup/coordinator'
import { GoogleDriveAuthService } from '../../src/main/services/backup/google-drive-auth'
import { GoogleDriveTransport } from '../../src/main/services/backup/google-drive-transport'
import { inspectRestoredProfileStatus } from '../../src/main/services/backup/restore'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { initializeVault } from '../../src/main/services/vault/identity'
import { writeVaultManifest } from '../../src/main/services/vault/manifest'
import type { VaultManifest } from '../../src/main/services/vault/types'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

async function createPopulatedProfile(baseDir: string) {
  const userDataDir = join(baseDir, 'userData')
  const sourceDir = join(baseDir, 'source')
  const vaultDir = join(baseDir, 'vault')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })

  const photoBytes = Buffer.from('stage-8b-1c-ipc-test-photo-payload')
  const photoSha = createHash('sha256').update(photoBytes).digest('hex')
  const sourcePath = join(sourceDir, 'sample.jpg')
  writeFileSync(sourcePath, photoBytes)

  const journal = new AnnotationJournal({
    storageDir: join(userDataDir, 'annotations'),
    sourceRoots: () => [sourceDir],
    vaultPath: () => vaultDir
  })
  await journal.initialize()

  const catalog = CatalogDatabase.open({
    catalogPath: join(userDataDir, 'vault-catalog.db'),
    journal
  })

  const now = Date.now()
  catalog.persistDiscoveryBatch(sourceDir, [
    {
      originalPath: sourcePath,
      fileName: 'sample.jpg',
      extension: '.jpg',
      category: 'photo',
      byteSize: photoBytes.length,
      birthtimeMs: now - 5000,
      mtimeMs: now - 5000,
      discoveredAtMs: now
    }
  ])

  const importedLoc = catalog.queryFileLocations({ limit: 10 }).items[0]!
  catalog.recordHashObservationsBatch([
    {
      originalPath: sourcePath,
      sha256: photoSha,
      observedByteSize: photoBytes.length,
      observedMtimeMs: importedLoc.filesystemMtimeMs,
      hashedAtMs: now
    }
  ])
  const hashObs = catalog.getHashObservationsForFile(importedLoc.id).items[0]!

  const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Primary Vault' })
  const vaultId = identity.vaultId
  catalog.registerVault({
    vaultId,
    vaultPath: vaultDir,
    name: identity.vaultName,
    createdAtMs: identity.createdAtMs
  })

  const importJob = catalog.createVaultImportJob({
    jobId: randomUUID(),
    vaultId,
    totalFiles: 1,
    totalBytes: photoBytes.length,
    items: [
      {
        fileLocationId: importedLoc.id,
        discoveryObservationId: importedLoc.discoveryObservationId,
        hashObservationId: hashObs.id,
        sha256: photoSha,
        byteSize: photoBytes.length
      }
    ]
  })

  const prefix = photoSha.slice(0, 2)
  const payloadRel = `files/${prefix}/${photoSha}/sample.jpg`
  const manifestRel = `files/${prefix}/${photoSha}/manifest.json`
  mkdirSync(join(vaultDir, 'files', prefix, photoSha), { recursive: true })
  writeFileSync(join(vaultDir, payloadRel), photoBytes)

  const manifest: VaultManifest = {
    formatVersion: 1,
    vaultId,
    sha256: photoSha,
    byteSize: photoBytes.length,
    managedCopy: {
      relativePath: payloadRel,
      fileName: 'sample.jpg',
      publishedAtMs: now,
      verifiedSha256: photoSha,
      verifiedByteSize: photoBytes.length
    },
    sources: [
      {
        fileLocationId: importedLoc.id,
        originalPath: sourcePath,
        fileName: 'sample.jpg',
        extension: '.jpg',
        category: 'photo',
        recordedFacts: {
          byteSize: photoBytes.length,
          filesystemBirthtimeMs: importedLoc.filesystemBirthtimeMs,
          filesystemMtimeMs: importedLoc.filesystemMtimeMs,
          firstDiscoveredAtMs: importedLoc.firstDiscoveredAtMs,
          lastSeenAtMs: importedLoc.lastSeenAtMs,
          discoveryObservationId: importedLoc.discoveryObservationId,
          hashObservationId: hashObs.id,
          hashVerifiedAtMs: hashObs.hashedAtMs
        },
        inferredMetadata: { inferredCaptureTimeMs: null },
        reviewDecisions: { isPreferred: true, duplicateReviewStatus: null },
        importResult: {
          importJobId: importJob.id,
          importedAtMs: now,
          verifiedSourceSha256: photoSha,
          verifiedSourceByteSize: photoBytes.length,
          sourceStability: {
            preCopyMtimeMs: importedLoc.filesystemMtimeMs ?? 0,
            postCopyMtimeMs: importedLoc.filesystemMtimeMs ?? 0,
            preCopyByteSize: photoBytes.length,
            postCopyByteSize: photoBytes.length
          }
        }
      }
    ]
  }
  writeVaultManifest(vaultDir, manifest, importJob.id)

  const vaultCopy = catalog.recordVaultCopy({
    vaultId,
    sha256: photoSha,
    byteSize: photoBytes.length,
    relativePath: payloadRel,
    manifestRelativePath: manifestRel,
    verifiedAtMs: now
  })
  catalog.updateVaultImportItem({
    jobId: importJob.id,
    fileLocationId: importedLoc.id,
    status: 'completed',
    vaultCopyId: vaultCopy.id,
    completedAtMs: now
  })
  catalog.updateVaultImportStatus(importJob.id, 'completed')

  catalog.setPhotoAnnotation({
    fileLocationId: importedLoc.id,
    expectedRevision: `rev:${importedLoc.discoveryObservationId}:${photoBytes.length}:${importedLoc.filesystemMtimeMs}:${photoSha}`,
    expectedVersion: 0,
    rating: 5,
    flag: 'pick'
  })

  return { userDataDir, vaultDir, catalog, photoSha, photoBytes }
}

describe('Stage 8B Sub-slice 1C — Backup & Restore IPC handlers', () => {
  it('rejects untrusted senders and event-only channel invocations', async () => {
    const fakeHandlers = new Map<string, (...args: unknown[]) => Promise<unknown> | unknown>()
    registerBackupIpcHandlers({
      handle: (ch, fn) => {
        fakeHandlers.set(ch, async (event: unknown, ...rest: unknown[]) => {
          if (event === 'untrusted') {
            throw new Error(`Unauthorized IPC sender for ${ch}`)
          }
          return fn(...rest)
        })
      }
    })

    const startHandler = fakeHandlers.get(IPC_CHANNELS.BACKUP_START)!
    await expect(startHandler('untrusted', { destinationId: 'x' })).rejects.toThrow(
      /Unauthorized IPC sender/
    )

    const progressHandler = fakeHandlers.get(IPC_CHANNELS.BACKUP_PROGRESS_EVENT)!
    await expect(progressHandler('trusted')).rejects.toThrow(/Event-only channel/)
    expect(typeof registerIpcHandlers).toBe('function')
  })

  it('configures destination, runs backup, lists/verifies recovery point, and restores to isolated profile', async () => {
    const baseDir = makeTempDir('pv-1c-ipc-')
    const { userDataDir, catalog, photoSha, photoBytes } = await createPopulatedProfile(baseDir)
    const backupRepoDir = join(baseDir, 'backup-usb')
    const restoreProfileDir = join(baseDir, 'restored-profile')
    const restoreVaultDir = join(baseDir, 'restored-vault')
    mkdirSync(backupRepoDir, { recursive: true })

    const backupCoordinator = new BackupCoordinator({
      catalog,
      userDataDir,
      appVersion: '0.1.0'
    })
    backupCoordinator.initialize()

    try {
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown> | unknown>()
      registerBackupIpcHandlers({
        handle: (ch, fn) => handlers.set(ch, fn),
        backupCoordinator,
        catalog,
        userDataDir,
        selectBackupDirectory: async () => ({ canceled: false, directoryPath: backupRepoDir })
      })

      const listJobs = handlers.get(IPC_CHANNELS.BACKUP_LIST_JOBS)!
      expect(await listJobs({ limit: 20, offset: 0 })).toEqual({
        items: [],
        total: 0,
        limit: 20,
        offset: 0
      })

      const picked = (await handlers.get(IPC_CHANNELS.BACKUP_SELECT_DIRECTORY)!({
        title: 'Pick'
      })) as { canceled: boolean; directoryPath: string | null }
      expect(picked).toEqual({ canceled: false, directoryPath: backupRepoDir })

      const dest = (await handlers.get(IPC_CHANNELS.BACKUP_CONFIGURE_DESTINATION)!({
        name: 'Test USB',
        kind: 'local_fs',
        targetPath: backupRepoDir,
        maxBytesPerSecond: null
      })) as { id: string }

      const job = (await handlers.get(IPC_CHANNELS.BACKUP_START)!({
        destinationId: dest.id
      })) as { id: string; snapshotId: string }

      const deadline = Date.now() + 15_000
      let current = (await handlers.get(IPC_CHANNELS.BACKUP_GET_JOB)!({ jobId: job.id })) as {
        status: string
      }
      while (Date.now() < deadline) {
        if (current.status === 'completed' || current.status === 'failed') break
        await new Promise((r) => setTimeout(r, 50))
        current = (await handlers.get(IPC_CHANNELS.BACKUP_GET_JOB)!({ jobId: job.id })) as {
          status: string
        }
      }
      expect(current.status).toBe('completed')
      expect(await listJobs({})).toMatchObject({
        items: [{ id: job.id, status: 'completed' }],
        total: 1,
        limit: 50,
        offset: 0
      })
      expect(await listJobs({ limit: 1, offset: 1 })).toEqual({
        items: [],
        total: 1,
        limit: 1,
        offset: 1
      })

      const listRes = (await handlers.get(IPC_CHANNELS.BACKUP_LIST_RECOVERY_POINTS)!({
        backupRepoDir
      })) as { recoveryPoints: Array<{ snapshotId: string; isComplete: boolean }> }
      expect(listRes.recoveryPoints).toHaveLength(1)
      expect(listRes.recoveryPoints[0]!.isComplete).toBe(true)

      const verifyRes = (await handlers.get(IPC_CHANNELS.BACKUP_VERIFY_RECOVERY_POINT)!({
        backupRepoDir,
        snapshotId: job.snapshotId
      })) as { snapshotId: string; verifiedFileCount: number; hasVault: boolean }
      expect(verifyRes.snapshotId).toBe(job.snapshotId)
      expect(verifyRes.verifiedFileCount).toBeGreaterThanOrEqual(4)
      expect(verifyRes.hasVault).toBe(true)

      const restoreRes = (await handlers.get(IPC_CHANNELS.BACKUP_RESTORE_RECOVERY_POINT)!({
        backupRepoDir,
        snapshotId: job.snapshotId,
        targetProfileDir: restoreProfileDir,
        targetVaultDir: restoreVaultDir
      })) as { verifiedFileCount: number; restoredProfilePath: string }
      expect(restoreRes.verifiedFileCount).toBeGreaterThanOrEqual(4)
      expect(restoreRes.restoredProfilePath).toBe(restoreProfileDir)
      expect(inspectRestoredProfileStatus(restoreProfileDir, restoreVaultDir).status).toBe(
        'complete'
      )

      const restoredFile = join(
        restoreVaultDir,
        'files',
        photoSha.slice(0, 2),
        photoSha,
        'sample.jpg'
      )
      expect(readFileSync(restoredFile)).toEqual(photoBytes)

      // Recover catalog directly from the surviving vault via BACKUP_RECOVER_CATALOG_FROM_VAULT IPC
      const recoveredProfileDir = join(baseDir, 'recovered-from-vault-profile')
      const recoverRes = (await handlers.get(IPC_CHANNELS.BACKUP_RECOVER_CATALOG_FROM_VAULT)!({
        sourceVaultDir: restoreVaultDir,
        targetProfileDir: recoveredProfileDir
      })) as {
        recoveredVaultCopies: number
        recoveredFileLocations: number
        targetProfileDir: string
        currentVersionSelectionNote: string
      }
      expect(recoverRes.recoveredVaultCopies).toBe(1)
      expect(recoverRes.recoveredFileLocations).toBe(1)
      expect(recoverRes.targetProfileDir).toBe(recoveredProfileDir)
      expect(recoverRes.currentVersionSelectionNote).toBe('inferred_from_manifest_evidence')
    } finally {
      await backupCoordinator.shutdown()
      catalog.close()
    }
  })

  it('wires Google Drive auth, folder selection, expired-auth pause/reconnect/resume, and remote verify/restore IPC without leaking tokens or secrets', async () => {
    const baseDir = makeTempDir('pv-backup-gdrive-ipc-')
    const { catalog, userDataDir, photoBytes, photoSha } = await createPopulatedProfile(baseDir)

    const restoreRoot = join(baseDir, 'restored-gdrive')
    const restoreProfileDir = join(restoreRoot, 'profile')
    const restoreVaultDir = join(restoreRoot, 'vault')

    // In-memory Drive v3 mock supporting folders + resumable upload + download
    interface DriveEntry {
      id: string
      name: string
      mimeType: string
      parents: string[]
      bytes: Buffer
      trashed: boolean
    }
    const entries = new Map<string, DriveEntry>()
    const rootFolderId = 'gdrive-root-folder'
    entries.set(rootFolderId, {
      id: rootFolderId,
      name: 'PersonalVault Backups',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root'],
      bytes: Buffer.alloc(0),
      trashed: false
    })
    const sessions = new Map<
      string,
      { fileId: string; name: string; parents: string[]; mimeType: string; chunks: Buffer[] }
    >()
    let sessionSeq = 0
    let idSeq = 0
    let activeToken = 'mock-access-token-1'
    let rejectUploadWith401 = false

    const driveFetch: typeof fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const url = new URL(urlStr)
      const method = (init?.method ?? 'GET').toUpperCase()
      const headers = new Headers(init?.headers)

      if (!urlStr.includes('/upload/')) {
        const authHeader = headers.get('authorization') ?? ''
        if (authHeader !== `Bearer ${activeToken}`) {
          return new Response(JSON.stringify({ error: { code: 401, message: 'Unauthorized' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          })
        }
      }

      if (url.pathname.startsWith('/upload/drive/v3/files') && method === 'POST') {
        const authHeader = headers.get('authorization') ?? ''
        const uploadType = url.searchParams.get('uploadType')
        if (uploadType === 'multipart') {
          const rawBody = init?.body
          const buf =
            rawBody instanceof Uint8Array
              ? Buffer.from(rawBody)
              : Buffer.from(String(rawBody ?? ''), 'utf8')
          const text = buf.toString('utf8')
          const jsonMatch = text.match(/application\/json[^\r\n]*\r\n\r\n(\{[\s\S]*?\})\r\n--/)
          const meta = (jsonMatch ? JSON.parse(jsonMatch[1]!) : { name: 'unknown' }) as {
            id?: string
            name: string
            parents?: string[]
            mimeType?: string
          }
          if (
            (rejectUploadWith401 && meta.name !== 'repository.json') ||
            authHeader !== `Bearer ${activeToken}`
          ) {
            authService.markAuthorizationExpired('Token revoked')
            return new Response(JSON.stringify({ error: { code: 401, message: 'Unauthorized' } }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' }
            })
          }
          const secondHeaderEnd = text.indexOf(
            '\r\n\r\n',
            (jsonMatch?.index ?? 0) + (jsonMatch?.[0]?.length ?? 0)
          )
          const endBoundary = buf.lastIndexOf(Buffer.from('\r\n--'))
          const mediaBytes =
            secondHeaderEnd !== -1 && endBoundary > secondHeaderEnd + 4
              ? buf.subarray(secondHeaderEnd + 4, endBoundary)
              : Buffer.alloc(0)
          const fileId = meta.id ?? `file-${++idSeq}`
          entries.set(fileId, {
            id: fileId,
            name: meta.name,
            mimeType: meta.mimeType ?? 'application/octet-stream',
            parents: meta.parents ?? ['root'],
            bytes: mediaBytes,
            trashed: false
          })
          return new Response(
            JSON.stringify({ id: fileId, name: meta.name, size: String(mediaBytes.length) }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        const meta = JSON.parse(String(init?.body ?? '{}')) as {
          id?: string
          name: string
          parents?: string[]
          mimeType?: string
        }
        if (
          (rejectUploadWith401 && meta.name !== 'repository.json') ||
          authHeader !== `Bearer ${activeToken}`
        ) {
          authService.markAuthorizationExpired('Token revoked')
          return new Response(JSON.stringify({ error: { code: 401, message: 'Unauthorized' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        const fileId = meta.id ?? `file-${++idSeq}`
        const sessionUri = `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=sess-${++sessionSeq}`
        sessions.set(sessionUri, {
          fileId,
          name: meta.name,
          parents: meta.parents ?? ['root'],
          mimeType: meta.mimeType ?? 'application/octet-stream',
          chunks: []
        })
        return new Response(null, { status: 200, headers: { Location: sessionUri } })
      }

      if (url.pathname.startsWith('/upload/drive/v3/files') && method === 'PUT') {
        const sess = sessions.get(urlStr)
        if (!sess) return new Response(null, { status: 404 })
        const rawBody = init?.body
        const buf =
          rawBody instanceof Uint8Array
            ? Buffer.from(rawBody)
            : typeof rawBody === 'string'
              ? Buffer.from(rawBody)
              : Buffer.alloc(0)
        const contentRange = headers.get('content-range')
        if (contentRange?.startsWith('bytes */')) {
          const uploaded = Buffer.concat(sess.chunks).length
          if (uploaded === 0) return new Response(null, { status: 308 })
          return new Response(null, {
            status: 308,
            headers: { Range: `bytes=0-${uploaded - 1}` }
          })
        }
        sess.chunks.push(buf)
        const full = Buffer.concat(sess.chunks)
        const totalMatch = contentRange?.match(/\/(\d+)$/)
        const total = totalMatch ? Number(totalMatch[1]) : full.length
        if (full.length < total) {
          return new Response(null, {
            status: 308,
            headers: { Range: `bytes=0-${full.length - 1}` }
          })
        }
        entries.set(sess.fileId, {
          id: sess.fileId,
          name: sess.name,
          mimeType: sess.mimeType,
          parents: sess.parents,
          bytes: full,
          trashed: false
        })
        return new Response(
          JSON.stringify({ id: sess.fileId, name: sess.name, size: String(full.length) }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      if (url.pathname === '/drive/v3/files/generateIds' && method === 'GET') {
        const count = Math.max(1, Number(url.searchParams.get('count') ?? '1'))
        const ids = Array.from({ length: count }, () => `gen-id-${++idSeq}`)
        return new Response(JSON.stringify({ ids }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      if (url.pathname === '/drive/v3/files' && method === 'GET') {
        const q = url.searchParams.get('q') ?? ''
        const parentMatch = q.match(/'([^']+)' in parents/)
        const parentId = parentMatch?.[1] ?? null
        const nameMatch = q.match(/name = '([^']+)'/)
        const targetName = nameMatch?.[1] ?? null
        const folderOnly = q.includes("mimeType = 'application/vnd.google-apps.folder'")
        const files = Array.from(entries.values())
          .filter((e) => !e.trashed)
          .filter((e) => (!parentId ? true : e.parents.includes(parentId)))
          .filter((e) => (!targetName ? true : e.name === targetName))
          .filter((e) => (!folderOnly ? true : e.mimeType === 'application/vnd.google-apps.folder'))
          .map((e) => ({
            id: e.id,
            name: e.name,
            mimeType: e.mimeType,
            size: String(e.bytes.length),
            parents: e.parents
          }))
        return new Response(JSON.stringify({ files }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      if (url.pathname === '/drive/v3/files' && method === 'POST') {
        const meta = JSON.parse(String(init?.body ?? '{}')) as {
          id?: string
          name: string
          mimeType?: string
          parents?: string[]
        }
        const fileId = meta.id ?? `folder-${++idSeq}`
        const entry: DriveEntry = {
          id: fileId,
          name: meta.name,
          mimeType: meta.mimeType ?? 'application/vnd.google-apps.folder',
          parents: meta.parents ?? ['root'],
          bytes: Buffer.alloc(0),
          trashed: false
        }
        entries.set(fileId, entry)
        return new Response(
          JSON.stringify({ id: entry.id, name: entry.name, mimeType: entry.mimeType }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      const fileGetMatch = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/)
      if (fileGetMatch && method === 'GET') {
        const entry = entries.get(decodeURIComponent(fileGetMatch[1]!))
        if (!entry || entry.trashed) return new Response(null, { status: 404 })
        if (url.searchParams.get('alt') === 'media') {
          return new Response(new Uint8Array(entry.bytes), { status: 200 })
        }
        return new Response(
          JSON.stringify({
            id: entry.id,
            name: entry.name,
            mimeType: entry.mimeType,
            size: String(entry.bytes.length)
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      if (fileGetMatch && method === 'DELETE') {
        entries.delete(decodeURIComponent(fileGetMatch[1]!))
        return new Response(null, { status: 204 })
      }

      return new Response(null, { status: 404 })
    }

    let signInCount = 0
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (plainText: string) => Buffer.from(plainText, 'utf8'),
      decryptString: (encrypted: Buffer) => encrypted.toString('utf8')
    }
    const authService = new GoogleDriveAuthService({
      tokenFilePath: join(userDataDir, 'google-drive-auth.enc'),
      safeStorage: fakeSafeStorage,
      fetchFn: driveFetch,
      signInFlow: async () => {
        signInCount += 1
        activeToken = `mock-access-token-${signInCount}`
        return {
          accessToken: activeToken,
          refreshToken: `mock-refresh-token-${signInCount}`,
          expiresInSeconds: 3600,
          accountEmail: 'vault-owner@example.com',
          accountDisplayName: 'Vault Owner'
        }
      }
    })

    const backupCoordinator = new BackupCoordinator({
      catalog,
      userDataDir,
      appVersion: '0.1.0',
      googleDrive: {
        getAccessToken: () => authService.getAccessToken(),
        isAvailable: () => authService.getStatus().status === 'connected',
        fetchFn: driveFetch
      }
    })
    backupCoordinator.initialize()

    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown> | unknown>()
    registerBackupIpcHandlers({
      handle: (ch, fn) => handlers.set(ch, fn),
      backupCoordinator,
      catalog,
      userDataDir,
      googleDriveAuth: authService,
      createGoogleDriveTransport: (folderId) =>
        new GoogleDriveTransport({
          rootFolderId: folderId,
          getAccessToken: () => authService.getAccessToken(),
          fetchFn: driveFetch
        }),
      selectBackupDirectory: async () => ({ canceled: true, directoryPath: null })
    })

    try {
      const initialAuth = await handlers.get(IPC_CHANNELS.BACKUP_GDRIVE_GET_STATUS)!()
      expect(initialAuth).toEqual({
        status: 'disconnected',
        accountEmail: null,
        accountDisplayName: null,
        lastError: null
      })

      const connectedAuth = (await handlers.get(IPC_CHANNELS.BACKUP_GDRIVE_CONNECT)!()) as {
        status: string
        accountEmail: string
      }
      expect(connectedAuth).toEqual({
        status: 'connected',
        accountEmail: 'vault-owner@example.com',
        accountDisplayName: 'Vault Owner',
        lastError: null
      })
      expect(JSON.stringify(connectedAuth)).not.toContain('mock-access-token')
      expect(JSON.stringify(connectedAuth)).not.toContain('mock-refresh-token')

      const folderList = (await handlers.get(IPC_CHANNELS.BACKUP_GDRIVE_LIST_FOLDERS)!(
        {}
      )) as Array<{
        id: string
        name: string
      }>
      expect(folderList.some((f) => f.id === rootFolderId)).toBe(true)

      const createdFolder = (await handlers.get(IPC_CHANNELS.BACKUP_GDRIVE_CREATE_FOLDER)!({
        name: 'My Cloud Vault'
      })) as { id: string; name: string }
      expect(createdFolder.name).toBe('My Cloud Vault')

      const recoverySecret = 'super-secret-passphrase-never-logged'
      const dest = (await handlers.get(IPC_CHANNELS.BACKUP_CONFIGURE_DESTINATION)!({
        name: 'Google Drive Backup',
        kind: 'google_drive',
        targetPath: createdFolder.id,
        encryptionMode: 'aes-256-gcm-v1',
        maxBytesPerSecond: null,
        dailyBudgetBytes: 64 * 1024 * 1024
      })) as { id: string; kind: string }
      expect(dest.kind).toBe('google_drive')

      // Simulate expired authorization during upload -> pauses with destination_access_denied
      rejectUploadWith401 = true
      const pausedJob = (await handlers.get(IPC_CHANNELS.BACKUP_START)!({
        destinationId: dest.id,
        recoverySecret
      })) as { id: string }

      const deadline1 = Date.now() + 10_000
      let current = (await handlers.get(IPC_CHANNELS.BACKUP_GET_JOB)!({ jobId: pausedJob.id })) as {
        status: string
        errorCode: string | null
      }
      while (Date.now() < deadline1) {
        if (
          current.status === 'paused' ||
          current.status === 'queued_destination_unavailable' ||
          current.status === 'failed'
        ) {
          break
        }
        await new Promise((r) => setTimeout(r, 30))
        current = (await handlers.get(IPC_CHANNELS.BACKUP_GET_JOB)!({ jobId: pausedJob.id })) as {
          status: string
          errorCode: string | null
        }
      }
      expect(current.status).toBe('paused')
      expect(current.errorCode).toBe('destination_access_denied')
      expect(JSON.stringify(current)).not.toContain(recoverySecret)
      expect(JSON.stringify(current)).not.toContain('mock-access-token')

      const expiredStatus = (await handlers.get(IPC_CHANNELS.BACKUP_GDRIVE_GET_STATUS)!()) as {
        status: string
      }
      expect(expiredStatus.status).toBe('expired')

      // Reconnect and resume
      rejectUploadWith401 = false
      await handlers.get(IPC_CHANNELS.BACKUP_GDRIVE_CONNECT)!()
      const resumed = (await handlers.get(IPC_CHANNELS.BACKUP_RESUME)!({
        jobId: pausedJob.id
      })) as { id: string; snapshotId: string }

      const deadline2 = Date.now() + 15_000
      let finished = (await handlers.get(IPC_CHANNELS.BACKUP_GET_JOB)!({ jobId: resumed.id })) as {
        status: string
        snapshotId: string
      }
      while (Date.now() < deadline2) {
        if (finished.status === 'completed' || finished.status === 'failed') break
        await new Promise((r) => setTimeout(r, 30))
        finished = (await handlers.get(IPC_CHANNELS.BACKUP_GET_JOB)!({ jobId: resumed.id })) as {
          status: string
          snapshotId: string
        }
      }
      expect(finished.status).toBe('completed')

      const remoteList = (await handlers.get(IPC_CHANNELS.BACKUP_LIST_RECOVERY_POINTS)!({
        destinationKind: 'google_drive',
        driveFolderId: createdFolder.id
      })) as { recoveryPoints: Array<{ snapshotId: string; isComplete: boolean }> }
      expect(remoteList.recoveryPoints).toHaveLength(1)
      expect(remoteList.recoveryPoints[0]!.isComplete).toBe(true)

      const verified = (await handlers.get(IPC_CHANNELS.BACKUP_VERIFY_RECOVERY_POINT)!({
        destinationKind: 'google_drive',
        driveFolderId: createdFolder.id,
        snapshotId: finished.snapshotId,
        recoverySecret
      })) as { snapshotId: string; verifiedFileCount: number; hasVault: boolean }
      expect(verified.snapshotId).toBe(finished.snapshotId)
      expect(verified.verifiedFileCount).toBeGreaterThanOrEqual(4)

      const restored = (await handlers.get(IPC_CHANNELS.BACKUP_RESTORE_RECOVERY_POINT)!({
        destinationKind: 'google_drive',
        driveFolderId: createdFolder.id,
        snapshotId: finished.snapshotId,
        targetProfileDir: restoreProfileDir,
        targetVaultDir: restoreVaultDir,
        recoverySecret
      })) as { verifiedFileCount: number; restoredProfilePath: string }
      expect(restored.verifiedFileCount).toBeGreaterThanOrEqual(4)
      expect(inspectRestoredProfileStatus(restoreProfileDir, restoreVaultDir).status).toBe(
        'complete'
      )
      expect(
        readFileSync(join(restoreVaultDir, 'files', photoSha.slice(0, 2), photoSha, 'sample.jpg'))
      ).toEqual(photoBytes)

      // Disconnect removes account status
      const disconnected = await handlers.get(IPC_CHANNELS.BACKUP_GDRIVE_DISCONNECT)!()
      expect(disconnected).toEqual({
        status: 'disconnected',
        accountEmail: null,
        accountDisplayName: null,
        lastError: null
      })
    } finally {
      await backupCoordinator.shutdown()
      catalog.close()
    }
  })

  it('prevents stale token refresh from saving credentials after disconnect', async () => {
    const baseDir = makeTempDir('pv-backup-gdrive-refresh-race-')
    const tokenFilePath = join(baseDir, 'google-drive-auth.enc')
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (plainText: string) => Buffer.from(plainText, 'utf8'),
      decryptString: (encrypted: Buffer) => encrypted.toString('utf8')
    }

    let currentNowMs = 1_000_000
    let resolveRefresh!: (val: {
      accessToken: string
      expiresInSeconds: number
      refreshToken: string
    }) => void
    const refreshPending = new Promise<{
      accessToken: string
      expiresInSeconds: number
      refreshToken: string
    }>((resolve) => {
      resolveRefresh = resolve
    })

    const authService = new GoogleDriveAuthService({
      tokenFilePath,
      safeStorage: fakeSafeStorage,
      nowMs: () => currentNowMs,
      signInFlow: async () => ({
        accessToken: 'initial-access-token',
        refreshToken: 'initial-refresh-token',
        expiresInSeconds: 120,
        accountEmail: 'race-test@example.com',
        accountDisplayName: 'Race Test'
      }),
      refreshFlow: async () => refreshPending
    })

    const connected = await authService.connect()
    expect(connected.status).toBe('connected')

    // Advance clock so access token is within refresh window (<60s remaining)
    currentNowMs += 90_000

    // Start refresh (now awaiting refreshFlow)
    const tokenPromise = authService.getAccessToken()

    // Disconnect while refresh is still in-flight
    const disconnected = authService.disconnect()
    expect(disconnected.status).toBe('disconnected')

    // Now let the in-flight refresh resolve with fresh credentials
    resolveRefresh({
      accessToken: 'stale-refreshed-access-token',
      expiresInSeconds: 3600,
      refreshToken: 'stale-refreshed-refresh-token'
    })

    await expect(tokenPromise).rejects.toThrow(/disconnected|superseded/i)
    expect(authService.getStatus()).toEqual({
      status: 'disconnected',
      accountEmail: null,
      accountDisplayName: null,
      lastError: null
    })

    // Re-instantiating from disk confirms no stale credentials were persisted
    const reloadedService = new GoogleDriveAuthService({
      tokenFilePath,
      safeStorage: fakeSafeStorage
    })
    expect(reloadedService.getStatus().status).toBe('disconnected')
  })

  it('serves BACKUP_GET_SUMMARY for catalog-only and populated vaults and forwards multi-drive folder selections', async () => {
    const baseDir = makeTempDir('pv-backup-summary-ipc-')
    const { userDataDir, catalog, photoBytes } = await createPopulatedProfile(baseDir)

    const backupCoordinator = new BackupCoordinator({
      catalog,
      userDataDir,
      appVersion: '0.1.0'
    })
    backupCoordinator.initialize()

    try {
      const pickedPaths: string[] = ['D:\\Backups\\PV', 'C:\\Temp\\PVBackup']
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown> | unknown>()
      registerBackupIpcHandlers({
        handle: (ch, fn) => handlers.set(ch, fn),
        backupCoordinator,
        catalog,
        userDataDir,
        selectBackupDirectory: async () => ({
          canceled: false,
          directoryPath: pickedPaths.shift() ?? null
        })
      })

      const summary = (await handlers.get(IPC_CHANNELS.BACKUP_GET_SUMMARY)!()) as {
        hasActiveVault: boolean
        vaultFileCount: number
        vaultBytes: number
        estimatedTotalBytes: number
        catalogedFileCount: number
        isCatalogOnly: boolean
      }
      expect(summary.hasActiveVault).toBe(true)
      expect(summary.vaultFileCount).toBe(1)
      expect(summary.vaultBytes).toBe(photoBytes.length)
      expect(summary.catalogedFileCount).toBe(1)
      expect(summary.isCatalogOnly).toBe(false)
      expect(summary.estimatedTotalBytes).toBeGreaterThanOrEqual(photoBytes.length)

      const dPick = await handlers.get(IPC_CHANNELS.BACKUP_SELECT_DIRECTORY)!({
        title: 'Pick D',
        defaultPath: 'Z:\\DoesNotExist'
      })
      expect(dPick).toEqual({ canceled: false, directoryPath: 'D:\\Backups\\PV' })

      const cPick = await handlers.get(IPC_CHANNELS.BACKUP_SELECT_DIRECTORY)!({
        title: 'Pick C'
      })
      expect(cPick).toEqual({ canceled: false, directoryPath: 'C:\\Temp\\PVBackup' })
    } finally {
      await backupCoordinator.shutdown()
      catalog.close()
    }
  })
})
