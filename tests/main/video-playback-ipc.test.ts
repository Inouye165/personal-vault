// @vitest-environment node
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const registered = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => registered.set(channel, fn)
  },
  app: { getVersion: () => '0.1.0' },
  dialog: {}
}))

import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import {
  OpenInDefaultPlayerResponseSchema,
  OriginalPhotoResultSchema,
  VideoPlaybackResultSchema
} from '../../src/shared/validation/ipc-schemas'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import { createSenderValidator } from '../../src/main/ipc/sender'
import { resolveAppLocation } from '../../src/main/navigation'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { VideoPlaybackCoordinator } from '../../src/main/services/video/coordinator'
import type { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'

const documentPath = resolve('app', 'out', 'renderer', 'index.html')
const documentUrl = pathToFileURL(documentPath).href
const TRUSTED_ID = 42
const trusted = { sender: { id: TRUSTED_ID }, senderFrame: { url: documentUrl, parent: null } }

function invoke(channel: string, event: unknown, payload: unknown): Promise<unknown> {
  const fn = registered.get(channel)
  if (!fn) throw new Error(`Missing handler for ${channel}`)
  return Promise.resolve(fn(event, payload))
}

function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + payload.length, 0)
  header.write(type, 4, 'ascii')
  return Buffer.concat([header, payload])
}

function fullBox(type: string, version: number, flags: number, payload: Buffer): Buffer {
  const vf = Buffer.alloc(4)
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0)
  return box(type, Buffer.concat([vf, payload]))
}

function makeQuickTimeMovie(codecFourCc: string): Buffer {
  const ftypPayload = Buffer.alloc(12)
  ftypPayload.write('qt  ', 0, 'ascii')
  ftypPayload.write('qt  ', 8, 'ascii')
  const mvhdPayload = Buffer.alloc(96)
  mvhdPayload.writeUInt32BE(1000, 8)
  mvhdPayload.writeUInt32BE(2500, 12)
  const tkhdPayload = Buffer.alloc(80)
  tkhdPayload.writeUInt32BE(1, 8)
  tkhdPayload.writeUInt32BE(1280 << 16, 72)
  tkhdPayload.writeUInt32BE(720 << 16, 76)
  const hdlrPayload = Buffer.alloc(24)
  hdlrPayload.write('vide', 4, 'ascii')
  const stsdCount = Buffer.alloc(4)
  stsdCount.writeUInt32BE(1, 0)
  const stsd = fullBox('stsd', 0, 0, Buffer.concat([stsdCount, box(codecFourCc, Buffer.alloc(24))]))
  const videTrak = box(
    'trak',
    Buffer.concat([
      fullBox('tkhd', 0, 3, tkhdPayload),
      box(
        'mdia',
        Buffer.concat([fullBox('hdlr', 0, 0, hdlrPayload), box('minf', box('stbl', stsd))])
      )
    ])
  )
  const moov = box('moov', Buffer.concat([fullBox('mvhd', 0, 0, mvhdPayload), videTrak]))
  const mdatPayload = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')
  return Buffer.concat([box('ftyp', ftypPayload), box('mdat', mdatPayload), moov])
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

describe('video playback IPC, pv-media byte-range streaming, and default player fallback', () => {
  const location = resolveAppLocation({
    isPackaged: true,
    rendererUrl: undefined,
    documentPath
  })
  const validateSender = createSenderValidator({
    getTrustedWebContentsId: () => TRUSTED_ID,
    location
  })

  let workDir: string
  let catalog: CatalogDatabase
  let videoCoordinator: VideoPlaybackCoordinator
  let openedPaths: string[]

  beforeEach(() => {
    registered.clear()
    workDir = mkdtempSync(join(tmpdir(), 'pv-vid-ipc-'))
    catalog = CatalogDatabase.open({ catalogPath: join(workDir, 'catalog.db') })
    openedPaths = []
    videoCoordinator = new VideoPlaybackCoordinator({
      catalog,
      userDataDir: join(workDir, 'userData'),
      openPath: async (p) => {
        openedPaths.push(p)
        return ''
      }
    })
  })

  afterEach(async () => {
    await videoCoordinator.shutdown()
    catalog.close()
    rmSync(workDir, { recursive: true, force: true })
  })

  it('prepares playback for mislabeled IMG_1450.JPG, streams byte ranges, revokes tokens, and opens a read-only .mov copy in default player without touching source', async () => {
    const sourceDir = join(workDir, 'sources')
    mkdirSync(sourceDir, { recursive: true })
    const jpgVideoPath = join(sourceDir, 'IMG_1450.JPG')
    const movieBytes = makeQuickTimeMovie('hvc1')
    writeFileSync(jpgVideoPath, movieBytes)
    const originalSha = sha256(jpgVideoPath)

    catalog.persistDiscoveryBatch(sourceDir, [
      {
        originalPath: jpgVideoPath,
        fileName: 'IMG_1450.JPG',
        extension: '.jpg',
        byteSize: movieBytes.length,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000000000,
        discoveredAtMs: 1700000000000,
        category: 'photo',
        mediaKind: 'photo' // simulate legacy row before reclassification
      }
    ])
    const record = catalog.getFileLocationByPath(jpgVideoPath)!

    registerIpcHandlers({
      validateSender,
      catalog,
      videoPlaybackCoordinator: videoCoordinator
    })

    const prepRaw = await invoke(IPC_CHANNELS.MEDIA_PREPARE_VIDEO, trusted, {
      locationId: record.id
    })
    const prep = VideoPlaybackResultSchema.parse(prepRaw)
    expect(prep.status).toBe('ready')
    if (prep.status !== 'ready') return

    expect(prep.container).toBe('quicktime')
    expect(prep.videoCodec).toBe('hevc')
    expect(prep.mimeType).toBe('video/mp4')
    expect(prep.durationMs).toBe(2500)
    expect(prep.widthPx).toBe(1280)
    expect(prep.heightPx).toBe(720)
    expect(prep.streamUrl).toBe(`pv-media://video/${prep.token}`)

    // Verify in-place catalog reclassification
    const updatedRecord = catalog.getFileLocationById(record.id)!
    expect(updatedRecord.mediaKind).toBe('video')

    // Verify pv-media full and Range streaming
    const rangeRes = await videoCoordinator.handleProtocolRequest(
      new Request(prep.streamUrl, { headers: { Range: 'bytes=0-15' } })
    )
    expect(rangeRes.status).toBe(206)
    expect(rangeRes.headers.get('Accept-Ranges')).toBe('bytes')
    expect(rangeRes.headers.get('Content-Range')).toBe(`bytes 0-15/${movieBytes.length}`)
    expect(rangeRes.headers.get('Content-Type')).toBe('video/mp4')
    const chunk = Buffer.from(await rangeRes.arrayBuffer())
    expect(chunk.equals(movieBytes.subarray(0, 16))).toBe(true)

    // Unsatisfiable range -> 416
    const badRangeRes = await videoCoordinator.handleProtocolRequest(
      new Request(prep.streamUrl, { headers: { Range: `bytes=${movieBytes.length + 10}-` } })
    )
    expect(badRangeRes.status).toBe(416)

    // Unauthorized token -> 404 / 403
    const badTokenRes = await videoCoordinator.handleProtocolRequest(
      new Request(`pv-media://video/${'f'.repeat(48)}`)
    )
    expect(badTokenRes.status).toBe(404)
    const badHostRes = await videoCoordinator.handleProtocolRequest(
      new Request('pv-media://other/etc/passwd')
    )
    expect(badHostRes.status).toBe(403)

    // Open in default player -> creates temporary .mov copy, preserves source untouched
    const openRaw = await invoke(IPC_CHANNELS.MEDIA_OPEN_IN_DEFAULT_PLAYER, trusted, {
      locationId: record.id
    })
    const openRes = OpenInDefaultPlayerResponseSchema.parse(openRaw)
    expect(openRes.ok).toBe(true)
    expect(openRes.usedTemporaryCopy).toBe(true)
    expect(openRes.launchedFileName).toMatch(/IMG_1450\.mov$/)
    expect(openedPaths).toHaveLength(1)
    expect(readFileSync(openedPaths[0]!).equals(movieBytes)).toBe(true)
    expect(sha256(jpgVideoPath)).toBe(originalSha)

    // Revoke token -> subsequent stream fails with 404
    const revoked = await invoke(IPC_CHANNELS.MEDIA_REVOKE_VIDEO_TOKEN, trusted, {
      token: prep.token
    })
    expect(revoked).toBe(true)
    const afterRevokeRes = await videoCoordinator.handleProtocolRequest(new Request(prep.streamUrl))
    expect(afterRevokeRes.status).toBe(404)
  })

  it('reports corrupt/incomplete movies and disconnected sources honestly and falls back to verified vault copy', async () => {
    const sourceDir = join(workDir, 'removable')
    const vaultDir = join(workDir, 'vault')
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(vaultDir, { recursive: true })

    // 1. Corrupt/incomplete QuickTime movie
    const corruptPath = join(sourceDir, 'broken.mov')
    const brokenHeader = box('mdat', Buffer.alloc(12))
    brokenHeader.writeUInt32BE(99999, 0)
    const brokenBytes = Buffer.concat([box('wide'), brokenHeader])
    writeFileSync(corruptPath, brokenBytes)

    // 2. Valid MP4 imported into vault, then source disconnected
    const validMp4Path = join(sourceDir, 'trip.mp4')
    const validBytes = makeQuickTimeMovie('avc1')
    writeFileSync(validMp4Path, validBytes)
    const validSha = sha256(validMp4Path)

    const vaultRel = `files/${validSha.slice(0, 2)}/${validSha}/trip.mp4`
    const vaultFilePath = join(vaultDir, vaultRel)
    mkdirSync(join(vaultDir, 'files', validSha.slice(0, 2), validSha), { recursive: true })
    copyFileSync(validMp4Path, vaultFilePath)

    // 3. Unimported video that gets disconnected
    const unimportedPath = join(sourceDir, 'gone.mp4')
    writeFileSync(unimportedPath, validBytes)

    catalog.persistDiscoveryBatch(sourceDir, [
      {
        originalPath: corruptPath,
        fileName: 'broken.mov',
        extension: '.mov',
        byteSize: brokenBytes.length,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000000000,
        discoveredAtMs: 1700000000000,
        category: 'photo',
        mediaKind: 'video'
      },
      {
        originalPath: validMp4Path,
        fileName: 'trip.mp4',
        extension: '.mp4',
        byteSize: validBytes.length,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000000000,
        discoveredAtMs: 1700000000000,
        category: 'photo',
        mediaKind: 'video'
      },
      {
        originalPath: unimportedPath,
        fileName: 'gone.mp4',
        extension: '.mp4',
        byteSize: validBytes.length,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000000000,
        discoveredAtMs: 1700000000000,
        category: 'photo',
        mediaKind: 'video'
      }
    ])
    catalog.recordHashObservation({
      originalPath: validMp4Path,
      sha256: validSha,
      observedByteSize: validBytes.length,
      observedMtimeMs: 1700000000000,
      hashedAtMs: 1700000001000
    })
    catalog.registerVault({
      vaultId: 'v-1',
      vaultPath: vaultDir,
      name: 'Vault',
      createdAtMs: 1700000000000
    })
    catalog.recordVaultCopy({
      vaultId: 'v-1',
      sha256: validSha,
      byteSize: validBytes.length,
      relativePath: vaultRel,
      manifestRelativePath: `manifests/${validSha.slice(0, 2)}/${validSha}.json`,
      verifiedAtMs: 1700000002000
    })

    const corruptId = catalog.getFileLocationByPath(corruptPath)!.id
    const vaultFallbackId = catalog.getFileLocationByPath(validMp4Path)!.id
    const missingId = catalog.getFileLocationByPath(unimportedPath)!.id

    registerIpcHandlers({
      validateSender,
      catalog,
      videoPlaybackCoordinator: videoCoordinator
    })

    const corruptRes = VideoPlaybackResultSchema.parse(
      await invoke(IPC_CHANNELS.MEDIA_PREPARE_VIDEO, trusted, { locationId: corruptId })
    )
    expect(corruptRes.status).toBe('corrupt')
    if (corruptRes.status === 'corrupt') {
      expect(corruptRes.reason).toMatch(/incomplete/i)
      expect(corruptRes.canOpenInDefaultPlayer).toBe(true)
    }

    // Disconnect source folder
    renameSync(sourceDir, join(workDir, 'removable.offline'))

    // Imported video plays from verified vault copy
    const vaultPlayRes = VideoPlaybackResultSchema.parse(
      await invoke(IPC_CHANNELS.MEDIA_PREPARE_VIDEO, trusted, { locationId: vaultFallbackId })
    )
    expect(vaultPlayRes.status).toBe('ready')
    if (vaultPlayRes.status === 'ready') {
      expect(vaultPlayRes.sourceKind).toBe('vault_copy')
      expect(vaultPlayRes.notice).toMatch(/verified vault copy/i)
    }

    // Unimported disconnected video reports missing
    const missingRes = VideoPlaybackResultSchema.parse(
      await invoke(IPC_CHANNELS.MEDIA_PREPARE_VIDEO, trusted, { locationId: missingId })
    )
    expect(missingRes.status).toBe('missing')
    if (missingRes.status === 'missing') {
      expect(missingRes.reason).toMatch(/disconnected/i)
      expect(missingRes.canOpenInDefaultPlayer).toBe(false)
    }

    // Also test original photo cached preview fallback when no vault copy exists
    const mockThumbCoordinator = {
      getOriginalPhoto: vi.fn(),
      getCachedPreviewForOriginal: vi.fn().mockResolvedValue({
        dataUrl: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=',
        mimeType: 'image/webp',
        width: 512,
        height: 384
      })
    } as unknown as ThumbnailCoordinator
    registered.clear()
    registerIpcHandlers({
      validateSender,
      catalog,
      thumbnailCoordinator: mockThumbCoordinator
    })
    const cachedOrig = OriginalPhotoResultSchema.parse(
      await invoke(IPC_CHANNELS.PHOTOS_GET_ORIGINAL, trusted, { locationId: missingId })
    )
    expect(cachedOrig.status).toBe('ready')
    if (cachedOrig.status === 'ready') {
      expect(cachedOrig.sourceKind).toBe('cached_preview')
      expect(cachedOrig.notice).toMatch(/smaller cached preview/i)
    }
    expect(lstatSync(vaultFilePath).isFile()).toBe(true)
  })

  it('prefers verified vault copy for playback and default player even while original is online, distinguishing online vs offline original notice', async () => {
    const sourceDir = join(workDir, 'online-sources')
    const vaultDir = join(workDir, 'online-vault')
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(vaultDir, { recursive: true })

    const mp4Path = join(sourceDir, 'family.mp4')
    const mp4Bytes = makeQuickTimeMovie('avc1')
    writeFileSync(mp4Path, mp4Bytes)
    const sha = sha256(mp4Path)

    const vaultRel = `files/${sha.slice(0, 2)}/${sha}/family.mp4`
    const vaultFilePath = join(vaultDir, vaultRel)
    mkdirSync(join(vaultDir, 'files', sha.slice(0, 2), sha), { recursive: true })
    copyFileSync(mp4Path, vaultFilePath)

    catalog.persistDiscoveryBatch(sourceDir, [
      {
        originalPath: mp4Path,
        fileName: 'family.mp4',
        extension: '.mp4',
        byteSize: mp4Bytes.length,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000000000,
        discoveredAtMs: 1700000000000,
        category: 'photo',
        mediaKind: 'video'
      }
    ])
    catalog.recordHashObservation({
      originalPath: mp4Path,
      sha256: sha,
      observedByteSize: mp4Bytes.length,
      observedMtimeMs: 1700000000000,
      hashedAtMs: 1700000001000
    })
    catalog.registerVault({
      vaultId: 'v-online',
      vaultPath: vaultDir,
      name: 'Vault',
      createdAtMs: 1700000000000
    })
    catalog.setActiveVault(vaultDir)
    catalog.recordVaultCopy({
      vaultId: 'v-online',
      sha256: sha,
      byteSize: mp4Bytes.length,
      relativePath: vaultRel,
      manifestRelativePath: `manifests/${sha.slice(0, 2)}/${sha}.json`,
      verifiedAtMs: 1700000002000
    })

    const locId = catalog.getFileLocationByPath(mp4Path)!.id
    registerIpcHandlers({
      validateSender,
      catalog,
      videoPlaybackCoordinator: videoCoordinator
    })

    // 1. Original STILL ONLINE -> plays from verified vault copy without claiming original is unavailable
    const onlinePlay = VideoPlaybackResultSchema.parse(
      await invoke(IPC_CHANNELS.MEDIA_PREPARE_VIDEO, trusted, { locationId: locId })
    )
    expect(onlinePlay.status).toBe('ready')
    if (onlinePlay.status === 'ready') {
      expect(onlinePlay.sourceKind).toBe('vault_copy')
      expect(onlinePlay.notice).toBe('Playing your verified vault copy.')
    }

    // 2. Original goes offline -> still plays from verified vault copy and notes original unavailable
    renameSync(sourceDir, join(workDir, 'online-sources.offline'))
    const offlinePlay = VideoPlaybackResultSchema.parse(
      await invoke(IPC_CHANNELS.MEDIA_PREPARE_VIDEO, trusted, { locationId: locId })
    )
    expect(offlinePlay.status).toBe('ready')
    if (offlinePlay.status === 'ready') {
      expect(offlinePlay.sourceKind).toBe('vault_copy')
      expect(offlinePlay.notice).toBe(
        'Playing your verified vault copy (original source file is currently unavailable).'
      )
    }
  })
})
