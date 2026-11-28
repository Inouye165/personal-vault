import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { CatalogDatabase } from '../catalog/database'
import { resolveReadableFileLocation } from '../backup/recovered-file-resolver'
import { isPathInsideApprovedRoots } from '../thumbnails/file-content'
import { inspectMediaFileByContent } from './inspector'
import type {
  OpenInDefaultPlayerResponse,
  VideoPlaybackResult
} from '../../../shared/validation/ipc-schemas'

const MAX_ACTIVE_TOKENS = 64
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000
const MAX_TEMP_PLAYBACK_FILES = 5
const STREAM_HIGH_WATER_MARK = 256 * 1024
const STANDARD_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm'])

interface PlaybackSession {
  readonly token: string
  readonly locationId: number
  readonly filePath: string
  readonly approvedRoots: readonly string[]
  readonly byteSize: number
  readonly mimeType: 'video/mp4' | 'video/webm'
  readonly createdAtMs: number
  readonly expiresAtMs: number
}

export interface VideoPlaybackCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly userDataDir: string
  readonly openPath?: (targetPath: string) => Promise<string>
  readonly log?: (message: string) => void
}

async function verifyReadOnlyFileSha256(
  filePath: string,
  expectedByteSize: number,
  expectedSha256: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const handle = await open(filePath, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== expectedByteSize) {
      return {
        ok: false,
        reason: `File size mismatch on "${filePath}": expected ${expectedByteSize}, found ${stat.size}`
      }
    }
    const hash = createHash('sha256')
    const buf = Buffer.allocUnsafe(64 * 1024)
    let offset = 0
    while (true) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset)
      if (bytesRead <= 0) break
      hash.update(buf.subarray(0, bytesRead))
      offset += bytesRead
    }
    const actual = hash.digest('hex').toLowerCase()
    if (actual !== expectedSha256.toLowerCase()) {
      return {
        ok: false,
        reason: `Content hash verification failed for "${filePath}"`
      }
    }
    return { ok: true }
  } finally {
    await handle.close()
  }
}

function parseByteRangeHeader(
  rangeHeader: string,
  totalSize: number
): { start: number; end: number } | 'unsatisfiable' | null {
  const trimmed = rangeHeader.trim()
  if (!trimmed.toLowerCase().startsWith('bytes=')) return null
  const spec = trimmed.slice(6).split(',')[0]?.trim()
  if (!spec) return null

  const dashIdx = spec.indexOf('-')
  if (dashIdx === -1) return null
  const startPart = spec.slice(0, dashIdx).trim()
  const endPart = spec.slice(dashIdx + 1).trim()

  if (totalSize <= 0) return 'unsatisfiable'

  if (startPart === '') {
    const suffixLen = Number(endPart)
    if (!Number.isInteger(suffixLen) || suffixLen <= 0) return 'unsatisfiable'
    const start = Math.max(0, totalSize - suffixLen)
    return { start, end: totalSize - 1 }
  }

  const start = Number(startPart)
  if (!Number.isInteger(start) || start < 0 || start >= totalSize) {
    return 'unsatisfiable'
  }

  if (endPart === '') {
    return { start, end: totalSize - 1 }
  }

  const parsedEnd = Number(endPart)
  if (!Number.isInteger(parsedEnd) || parsedEnd < start) {
    return 'unsatisfiable'
  }

  return { start, end: Math.min(totalSize - 1, parsedEnd) }
}

function sanitizeStem(fileName: string): string {
  const ext = extname(fileName)
  const rawStem = ext ? fileName.slice(0, -ext.length) : fileName
  const cleaned = rawStem.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64)
  return cleaned || 'video'
}

export class VideoPlaybackCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly tempPlaybackDir: string
  private readonly openPathFn: (targetPath: string) => Promise<string>
  private readonly log?: (message: string) => void
  private readonly sessions = new Map<string, PlaybackSession>()
  private readonly tempFilesLru: string[] = []
  private isShutdown = false

  constructor(options: VideoPlaybackCoordinatorOptions) {
    this.catalog = options.catalog
    this.tempPlaybackDir = join(options.userDataDir, 'temp-video-playback')
    this.openPathFn =
      options.openPath ??
      (async (targetPath: string) => {
        const { shell } = await import('electron')
        return shell.openPath(targetPath)
      })
    this.log = options.log
    this.cleanupTempPlaybackDir()
  }

  private cleanupTempPlaybackDir(): void {
    try {
      if (existsSync(this.tempPlaybackDir)) {
        rmSync(this.tempPlaybackDir, { recursive: true, force: true })
      }
    } catch {
      // Ignore best-effort temp cleanup
    }
  }

  private pruneExpiredSessions(now = Date.now()): void {
    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAtMs <= now) {
        this.sessions.delete(token)
      }
    }
    while (this.sessions.size >= MAX_ACTIVE_TOKENS) {
      const oldestKey = this.sessions.keys().next().value
      if (!oldestKey) break
      this.sessions.delete(oldestKey)
    }
  }

  public revokeToken(token: string): boolean {
    return this.sessions.delete(token)
  }

  public async preparePlayback(locationId: number): Promise<VideoPlaybackResult> {
    if (this.isShutdown || this.catalog.isClosed()) {
      return {
        status: 'error',
        locationId,
        reason: 'Video playback service is shutting down',
        canOpenInDefaultPlayer: false
      }
    }

    const record = this.catalog.getFileLocationById(locationId)
    if (!record || record.category !== 'photo') {
      return {
        status: 'missing',
        locationId,
        reason: `Media item ${locationId} was not found in the catalog.`,
        canOpenInDefaultPlayer: false
      }
    }

    const resolved = resolveReadableFileLocation(this.catalog, locationId, {
      verifyPayloadHash: false,
      preferVaultCopy: true,
      allowVaultCopyFallbackForUnavailableSource: true
    })

    if (!resolved.ok) {
      const isCorrupt =
        resolved.errorCode === 'VAULT_COPY_CORRUPT' ||
        resolved.errorCode === 'VAULT_CONTAINMENT_ERROR'
      return {
        status: isCorrupt ? 'corrupt' : 'missing',
        locationId,
        reason: isCorrupt
          ? resolved.errorMessage
          : 'This video is currently unavailable because its source folder is disconnected and no verified vault copy was found.',
        canOpenInDefaultPlayer: false
      }
    }

    let fileStat
    let canonicalPath: string
    try {
      const lst = lstatSync(resolved.filePath)
      if (lst.isSymbolicLink() || !lst.isFile()) {
        return {
          status: 'error',
          locationId,
          reason: 'This video path is not a readable regular file.',
          canOpenInDefaultPlayer: false
        }
      }
      canonicalPath = realpathSync(resolved.filePath)
      const canonicalRoots = resolved.approvedRoots
        .map((r) => {
          try {
            return realpathSync(r)
          } catch {
            return null
          }
        })
        .filter((r): r is string => r !== null)
      if (canonicalRoots.length > 0 && !isPathInsideApprovedRoots(canonicalPath, canonicalRoots)) {
        return {
          status: 'error',
          locationId,
          reason: 'Access denied: file resolves outside approved folders.',
          canOpenInDefaultPlayer: false
        }
      }
      fileStat = statSync(canonicalPath)
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      const missing = code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENXIO'
      return {
        status: missing ? 'missing' : 'error',
        locationId,
        reason: missing
          ? 'This video is currently unavailable because its source folder is disconnected and no verified vault copy was found.'
          : err instanceof Error
            ? err.message
            : 'Unable to read video file.',
        canOpenInDefaultPlayer: false
      }
    }

    if (resolved.mode === 'vault_copy' && resolved.expectedSha256) {
      const verified = await verifyReadOnlyFileSha256(
        canonicalPath,
        resolved.expectedByteSize,
        resolved.expectedSha256
      )
      if (!verified.ok) {
        return {
          status: 'corrupt',
          locationId,
          reason: verified.reason,
          canOpenInDefaultPlayer: false
        }
      }
    }

    let inspected
    try {
      inspected = await inspectMediaFileByContent(canonicalPath)
    } catch (err: unknown) {
      return {
        status: 'error',
        locationId,
        reason: err instanceof Error ? err.message : 'Unable to inspect video file.',
        canOpenInDefaultPlayer: true
      }
    }

    if (inspected.mediaKind !== 'video') {
      return {
        status: 'unsupported',
        locationId,
        reason: 'This file does not appear to be a supported MP4, QuickTime, or WebM video.',
        canOpenInDefaultPlayer: true
      }
    }

    const now = Date.now()
    this.catalog.reclassifyLocationAsVideoInPlace(locationId, {
      containerFormat: inspected.video.container,
      videoCodec: inspected.video.videoCodec,
      audioCodec: inspected.video.audioCodec,
      durationMs: inspected.video.durationMs,
      widthPx: inspected.video.widthPx,
      heightPx: inspected.video.heightPx,
      isPlayableStructure: inspected.video.isPlayableStructure,
      structureError: inspected.video.structureError,
      inspectedAtMs: now
    })

    if (!inspected.video.isPlayableStructure) {
      return {
        status: 'corrupt',
        locationId,
        reason:
          inspected.video.structureError ??
          'This video file appears incomplete or damaged and cannot be played.',
        container: inspected.video.container,
        videoCodec: inspected.video.videoCodec,
        audioCodec: inspected.video.audioCodec,
        canOpenInDefaultPlayer: true
      }
    }

    this.pruneExpiredSessions(now)
    const token = randomBytes(24).toString('hex')
    const session: PlaybackSession = {
      token,
      locationId,
      filePath: canonicalPath,
      approvedRoots: resolved.approvedRoots,
      byteSize: fileStat.size,
      mimeType: inspected.video.mimeType,
      createdAtMs: now,
      expiresAtMs: now + TOKEN_TTL_MS
    }
    this.sessions.set(token, session)

    return {
      status: 'ready',
      locationId,
      token,
      streamUrl: `pv-media://video/${token}`,
      mimeType: inspected.video.mimeType,
      container: inspected.video.container,
      videoCodec: inspected.video.videoCodec,
      audioCodec: inspected.video.audioCodec,
      hasVideoTrack: inspected.video.hasVideoTrack,
      durationMs: inspected.video.durationMs,
      widthPx: inspected.video.widthPx,
      heightPx: inspected.video.heightPx,
      sourceKind: resolved.mode === 'vault_copy' ? 'vault_copy' : 'original',
      ...(resolved.mode === 'vault_copy'
        ? {
            notice: existsSync(resolved.originalPath)
              ? 'Playing your verified vault copy.'
              : 'Playing your verified vault copy (original source file is currently unavailable).'
          }
        : {}),
      canOpenInDefaultPlayer: true
    }
  }

  public async handleProtocolRequest(request: Request): Promise<Response> {
    if (this.isShutdown) {
      return new Response('Service shutting down', { status: 503 })
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(request.url)
    } catch {
      return new Response('Invalid media URL', { status: 400 })
    }

    if (parsedUrl.protocol !== 'pv-media:' || parsedUrl.hostname !== 'video') {
      return new Response('Forbidden', { status: 403 })
    }

    const tokenMatch = /^\/([0-9a-f]{48})$/.exec(parsedUrl.pathname)
    if (!tokenMatch) {
      return new Response('Forbidden', { status: 403 })
    }

    const token = tokenMatch[1]!
    const session = this.sessions.get(token)
    if (!session || session.expiresAtMs <= Date.now()) {
      this.sessions.delete(token)
      return new Response('Media token expired or not found', { status: 404 })
    }

    let stat
    try {
      const lst = lstatSync(session.filePath)
      if (lst.isSymbolicLink() || !lst.isFile()) {
        return new Response('Forbidden', { status: 403 })
      }
      const canonical = realpathSync(session.filePath)
      const canonicalRoots = session.approvedRoots
        .map((r) => {
          try {
            return realpathSync(r)
          } catch {
            return null
          }
        })
        .filter((r): r is string => r !== null)
      if (canonicalRoots.length > 0 && !isPathInsideApprovedRoots(canonical, canonicalRoots)) {
        return new Response('Forbidden', { status: 403 })
      }
      stat = statSync(canonical)
    } catch {
      return new Response('Video file unavailable', { status: 404 })
    }

    const totalSize = stat.size
    const baseHeaders: Record<string, string> = {
      'Content-Type': session.mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    }

    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: {
          ...baseHeaders,
          'Content-Length': String(totalSize)
        }
      })
    }

    const rangeHeader = request.headers.get('range')
    let start = 0
    let end = totalSize > 0 ? totalSize - 1 : 0
    let status = 200

    if (rangeHeader) {
      const parsedRange = parseByteRangeHeader(rangeHeader, totalSize)
      if (parsedRange === 'unsatisfiable') {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: {
            ...baseHeaders,
            'Content-Range': `bytes */${totalSize}`
          }
        })
      }
      if (parsedRange) {
        start = parsedRange.start
        end = parsedRange.end
        status = 206
      }
    }

    const contentLength = totalSize === 0 ? 0 : end - start + 1
    const headers: Record<string, string> = {
      ...baseHeaders,
      'Content-Length': String(contentLength)
    }
    if (status === 206) {
      headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`
    }

    if (contentLength === 0) {
      return new Response(new Uint8Array(0), { status, headers })
    }

    const nodeStream = createReadStream(session.filePath, {
      start,
      end,
      flags: 'r',
      highWaterMark: STREAM_HIGH_WATER_MARK
    })

    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
    return new Response(webStream, { status, headers })
  }

  private async createReadOnlyTempCopy(
    sourcePath: string,
    originalFileName: string,
    recommendedExtension: '.mp4' | '.mov' | '.webm'
  ): Promise<string> {
    mkdirSync(this.tempPlaybackDir, { recursive: true })
    const hashPrefix = createHash('sha256').update(sourcePath).digest('hex').slice(0, 8)
    const targetName = `${hashPrefix}-${sanitizeStem(originalFileName)}${recommendedExtension}`
    const targetPath = join(this.tempPlaybackDir, targetName)

    if (!existsSync(targetPath)) {
      const stagingPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
      await new Promise<void>((resolveCopy, rejectCopy) => {
        const reader = createReadStream(sourcePath, { flags: 'r' })
        const writer = createWriteStream(stagingPath, { mode: 0o600 })
        reader.on('error', (err) => {
          writer.destroy()
          rejectCopy(err)
        })
        writer.on('error', (err) => {
          reader.destroy()
          rejectCopy(err)
        })
        writer.on('finish', () => resolveCopy())
        reader.pipe(writer)
      })
      try {
        chmodSync(stagingPath, 0o444)
      } catch {
        // Best-effort read-only flag on Windows
      }
      renameSync(stagingPath, targetPath)
    }

    const idx = this.tempFilesLru.indexOf(targetPath)
    if (idx !== -1) this.tempFilesLru.splice(idx, 1)
    this.tempFilesLru.push(targetPath)

    while (this.tempFilesLru.length > MAX_TEMP_PLAYBACK_FILES) {
      const evicted = this.tempFilesLru.shift()
      if (evicted) {
        try {
          chmodSync(evicted, 0o600)
        } catch {
          // ignore
        }
        try {
          rmSync(evicted, { force: true })
        } catch {
          // ignore if currently open in external player
        }
      }
    }

    return targetPath
  }

  public async openInDefaultPlayer(locationId: number): Promise<OpenInDefaultPlayerResponse> {
    if (this.isShutdown || this.catalog.isClosed()) {
      return {
        ok: false,
        usedTemporaryCopy: false,
        launchedFileName: null,
        error: 'Video playback service is shutting down.'
      }
    }

    const record = this.catalog.getFileLocationById(locationId)
    if (!record || record.category !== 'photo') {
      return {
        ok: false,
        usedTemporaryCopy: false,
        launchedFileName: null,
        error: 'Video item was not found in the catalog.'
      }
    }

    const resolved = resolveReadableFileLocation(this.catalog, locationId, {
      verifyPayloadHash: false,
      preferVaultCopy: true,
      allowVaultCopyFallbackForUnavailableSource: true
    })

    if (!resolved.ok) {
      return {
        ok: false,
        usedTemporaryCopy: false,
        launchedFileName: null,
        error:
          'This video is currently unavailable because its source folder is disconnected and no verified vault copy was found.'
      }
    }

    let canonicalPath: string
    try {
      const lst = lstatSync(resolved.filePath)
      if (lst.isSymbolicLink() || !lst.isFile()) {
        return {
          ok: false,
          usedTemporaryCopy: false,
          launchedFileName: null,
          error: 'Source path is not a regular file.'
        }
      }
      canonicalPath = realpathSync(resolved.filePath)
    } catch {
      return {
        ok: false,
        usedTemporaryCopy: false,
        launchedFileName: null,
        error: 'Video file could not be accessed on disk.'
      }
    }

    if (resolved.mode === 'vault_copy' && resolved.expectedSha256) {
      const verified = await verifyReadOnlyFileSha256(
        canonicalPath,
        resolved.expectedByteSize,
        resolved.expectedSha256
      )
      if (!verified.ok) {
        return {
          ok: false,
          usedTemporaryCopy: false,
          launchedFileName: null,
          error: verified.reason
        }
      }
    }

    let recommendedExt: '.mp4' | '.mov' | '.webm' = '.mp4'
    try {
      const inspected = await inspectMediaFileByContent(canonicalPath)
      if (inspected.mediaKind === 'video') {
        recommendedExt = inspected.video.recommendedExtension
      }
    } catch {
      // Fallback to extension below
    }

    const actualExt = extname(canonicalPath).toLowerCase()
    const needsTempCopy =
      resolved.mode === 'vault_copy' || !STANDARD_VIDEO_EXTENSIONS.has(actualExt)

    let launchPath = canonicalPath
    if (needsTempCopy) {
      try {
        launchPath = await this.createReadOnlyTempCopy(
          canonicalPath,
          record.fileName,
          recommendedExt
        )
      } catch (err: unknown) {
        return {
          ok: false,
          usedTemporaryCopy: false,
          launchedFileName: null,
          error:
            err instanceof Error
              ? `Could not prepare temporary playable copy: ${err.message}`
              : 'Could not prepare temporary playable copy.'
        }
      }
    }

    const openError = await this.openPathFn(launchPath)
    if (openError && openError.trim().length > 0) {
      return {
        ok: false,
        usedTemporaryCopy: needsTempCopy,
        launchedFileName: basename(launchPath),
        error: `Your computer could not open this video automatically: ${openError}`
      }
    }

    this.log?.(
      `VideoPlaybackCoordinator: opened locationId=${locationId} in default player (tempCopy=${needsTempCopy}, file=${basename(launchPath)})`
    )

    return {
      ok: true,
      usedTemporaryCopy: needsTempCopy,
      launchedFileName: basename(launchPath),
      message: needsTempCopy
        ? `Opened a temporary ${recommendedExt} copy (${basename(launchPath)}) in your default player while keeping ${record.fileName} untouched.`
        : `Opened ${basename(launchPath)} in your default player.`
    }
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    this.sessions.clear()
    try {
      if (existsSync(this.tempPlaybackDir)) {
        for (const entry of readdirSync(this.tempPlaybackDir)) {
          try {
            chmodSync(join(this.tempPlaybackDir, entry), 0o600)
          } catch {
            // ignore
          }
        }
        rmSync(this.tempPlaybackDir, { recursive: true, force: true })
      }
    } catch {
      // Ignore cleanup errors if player still holds a handle
    }
  }
}
