// @vitest-environment node
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const registered = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', isPackaged: true },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => registered.set(channel, fn)
  }
}))

import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import { createSenderValidator } from '../../src/main/ipc/sender'
import { resolveAppLocation } from '../../src/main/navigation'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import { PhotoMetadataCoordinator } from '../../src/main/services/metadata'
import { createJpegFixture, createPngFixture, EXIF_TAG_IDS } from '../helpers/exif-fixture-builder'

const documentPath = resolve('app', 'out', 'renderer', 'index.html')
const documentUrl = pathToFileURL(documentPath).href
const TRUSTED_ID = 11

const trustedEvent = {
  sender: { id: TRUSTED_ID },
  senderFrame: { url: documentUrl, parent: null }
}
const untrustedUrlEvent = {
  sender: { id: TRUSTED_ID },
  senderFrame: { url: 'https://evil.example/index.html', parent: null }
}
const subframeEvent = {
  sender: { id: TRUSTED_ID },
  senderFrame: { url: documentUrl, parent: { url: documentUrl } }
}

const invoke = async (channel: string, event: unknown, ...args: unknown[]) => {
  const handler = registered.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler(event, ...args)
}

describe('Stage 6C — Photo Metadata & SQL Filter IPC Boundary Validation', () => {
  let tempDir: string
  let rootDir: string
  let catalog: CatalogDatabase
  let thumbCoordinator: ThumbnailCoordinator
  let metaCoordinator: PhotoMetadataCoordinator
  let sentEvents: Array<{ channel: string; payload: unknown }>

  beforeEach(() => {
    registered.clear()
    sentEvents = []
    tempDir = mkdtempSync(join(tmpdir(), 'pv-meta-ipc-'))
    rootDir = join(tempDir, 'photos')
    catalog = CatalogDatabase.open({ catalogPath: join(tempDir, 'catalog.sqlite') })
    thumbCoordinator = new ThumbnailCoordinator({
      cacheDir: join(tempDir, 'thumbs'),
      approvedRoots: () => catalog.getAllSourceRoots()
    })
    metaCoordinator = new PhotoMetadataCoordinator({
      catalog,
      thumbnailCoordinator: thumbCoordinator
    })
    metaCoordinator.initialize()

    const location = resolveAppLocation({ isPackaged: true, rendererUrl: undefined, documentPath })
    registerIpcHandlers({
      validateSender: createSenderValidator({
        getTrustedWebContentsId: () => TRUSTED_ID,
        location
      }),
      catalog,
      thumbnailCoordinator: thumbCoordinator,
      photoMetadataCoordinator: metaCoordinator,
      getMainWindow: () =>
        ({
          isDestroyed: () => false,
          webContents: {
            id: TRUSTED_ID,
            send: (channel: string, payload: unknown) => {
              sentEvents.push({ channel, payload })
            }
          }
        }) as never
    })
  })

  afterEach(async () => {
    await metaCoordinator.shutdown()
    await thumbCoordinator.shutdown()
    if (!catalog.isClosed()) {
      catalog.close()
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('rejects untrusted senders and subframes across all Stage 6C metadata channels', async () => {
    const channels = [
      IPC_CHANNELS.METADATA_GET_PROGRESS,
      IPC_CHANNELS.METADATA_START_EXTRACTION,
      IPC_CHANNELS.METADATA_PAUSE_EXTRACTION,
      IPC_CHANNELS.METADATA_RESUME_EXTRACTION,
      IPC_CHANNELS.METADATA_CANCEL_EXTRACTION,
      IPC_CHANNELS.METADATA_GET_PHOTO_DETAIL,
      IPC_CHANNELS.METADATA_GET_FACETS
    ]

    for (const ch of channels) {
      await expect(invoke(ch, untrustedUrlEvent, {})).rejects.toThrow(/Unauthorized IPC sender/)
      await expect(invoke(ch, subframeEvent, {})).rejects.toThrow(/Unauthorized IPC sender/)
    }

    await expect(invoke(IPC_CHANNELS.METADATA_PROGRESS_EVENT, trustedEvent)).rejects.toThrow(
      /Event-only channel/
    )
  })

  it('rejects arbitrary sourcePath injection and invalid calendar dates or payloads with Zod validation', async () => {
    // Renderer cannot supply arbitrary filesystem paths to detail lookup
    await expect(
      invoke(IPC_CHANNELS.METADATA_GET_PHOTO_DETAIL, trustedEvent, {
        fileLocationId: 1,
        sourcePath: 'C:\\Windows\\System32\\drivers\\etc\\hosts'
      })
    ).rejects.toThrow(/Invalid/i)

    // Impossible Gregorian calendar date 2024-02-30 must be rejected at IPC boundary
    await expect(
      invoke(IPC_CHANNELS.PHOTOS_GET_PAGE, trustedEvent, {
        offset: 0,
        limit: 50,
        captureDateFrom: '2024-02-30'
      })
    ).rejects.toThrow(/Invalid/i)

    // Out-of-bounds facet limit (> 50) rejected
    await expect(
      invoke(IPC_CHANNELS.METADATA_GET_FACETS, trustedEvent, {
        field: 'camera',
        limit: 500
      })
    ).rejects.toThrow(/Invalid/i)
  })

  it('drives end-to-end metadata extraction, detail provenance, bounded facets, and combined SQL filters over IPC', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(rootDir, { recursive: true })

    const canonPath = join(rootDir, 'canon.jpg')
    writeFileSync(
      canonPath,
      await createJpegFixture({
        width: 1200,
        height: 800,
        ifd0Tags: [
          { tagId: EXIF_TAG_IDS.Make, type: 'ascii', value: 'Canon' },
          { tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: 'Canon EOS R6' },
          { tagId: EXIF_TAG_IDS.Orientation, type: 'short', value: 6 }
        ],
        exifTags: [
          { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2025:05:10 18:20:00' },
          { tagId: EXIF_TAG_IDS.LensModel, type: 'ascii', value: 'RF50mm F1.2 L USM' }
        ]
      })
    )

    const plainPath = join(rootDir, 'plain.png')
    writeFileSync(plainPath, await createPngFixture({ width: 640, height: 480 }))

    for (const p of [canonPath, plainPath]) {
      const st = statSync(p)
      catalog.persistDiscoveryBatch(rootDir, [
        {
          originalPath: p,
          fileName: p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1),
          extension: extname(p).toLowerCase(),
          byteSize: st.size,
          birthtimeMs: st.birthtimeMs,
          mtimeMs: st.mtimeMs,
          discoveredAtMs: Date.now(),
          category: 'photo'
        }
      ])
    }

    const beforeProgress = await invoke(IPC_CHANNELS.METADATA_GET_PROGRESS, trustedEvent)
    expect(beforeProgress).toMatchObject({
      status: 'idle',
      coverage: { totalPhotos: 2, unprocessedCount: 2 }
    })

    await invoke(IPC_CHANNELS.METADATA_START_EXTRACTION, trustedEvent, { retryFailed: false })
    const done = await metaCoordinator.waitForCompletion()
    expect(done.status).toBe('completed')
    expect(sentEvents.some((e) => e.channel === IPC_CHANNELS.METADATA_PROGRESS_EVENT)).toBe(true)

    const allPage = (await invoke(IPC_CHANNELS.PHOTOS_GET_PAGE, trustedEvent, {
      offset: 0,
      limit: 50
    })) as { items: Array<{ id: number; fileName: string }>; totalCount: number }
    expect(allPage.totalCount).toBe(2)
    const canonId = allPage.items.find((i) => i.fileName === 'canon.jpg')!.id

    const detailRes = (await invoke(IPC_CHANNELS.METADATA_GET_PHOTO_DETAIL, trustedEvent, {
      fileLocationId: canonId
    })) as {
      detail: {
        effectiveStatus: string
        currentMetadata: {
          cameraDisplay: string
          displayWidthPx: number
          displayHeightPx: number
          captureTimezoneStatus: string
        }
      }
    }
    expect(detailRes.detail.effectiveStatus).toBe('extracted')
    expect(detailRes.detail.currentMetadata.cameraDisplay).toBe('Canon EOS R6')
    expect(detailRes.detail.currentMetadata.displayWidthPx).toBe(800)
    expect(detailRes.detail.currentMetadata.displayHeightPx).toBe(1200)
    expect(detailRes.detail.currentMetadata.captureTimezoneStatus).toBe(
      'local_wall_clock_unknown_tz'
    )

    const cameraFacets = (await invoke(IPC_CHANNELS.METADATA_GET_FACETS, trustedEvent, {
      field: 'camera',
      limit: 10,
      offset: 0
    })) as { items: Array<{ normalizedValue: string; count: number }>; unknownCount: number }
    expect(cameraFacets.items).toEqual([
      {
        normalizedValue: 'canon eos r6',
        displayLabel: 'Canon EOS R6',
        count: 1
      }
    ])
    expect(cameraFacets.unknownCount).toBe(1)

    // Filter by orientation-adjusted display height >= 1000 AND cameraNormalized
    const filtered = (await invoke(IPC_CHANNELS.PHOTOS_GET_PAGE, trustedEvent, {
      offset: 0,
      limit: 50,
      cameraNormalized: 'canon eos r6',
      minWidthPx: 800,
      minHeightPx: 1200,
      captureDateFrom: '2025-05-01',
      captureDateTo: '2025-05-31',
      fileTypeBasis: 'detected_format',
      fileTypeValue: 'jpeg'
    })) as { totalCount: number; items: Array<{ id: number }> }
    expect(filtered.totalCount).toBe(1)
    expect(filtered.items[0]?.id).toBe(canonId)

    // Filter for Unknown camera returns plain.png
    const unknownCamPage = (await invoke(IPC_CHANNELS.PHOTOS_GET_PAGE, trustedEvent, {
      offset: 0,
      limit: 50,
      onlyUnknownCamera: true
    })) as { totalCount: number; items: Array<{ fileName: string }> }
    expect(unknownCamPage.totalCount).toBe(1)
    expect(unknownCamPage.items[0]?.fileName).toBe('plain.png')
  })
})
