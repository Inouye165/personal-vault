// @vitest-environment node
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const registered = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => registered.set(channel, fn)
  },
  app: { getVersion: () => '0.1.0' },
  dialog: {}
}))

import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import { OriginalPhotoResultSchema } from '../../src/shared/validation/ipc-schemas'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import { createSenderValidator } from '../../src/main/ipc/sender'
import { resolveAppLocation } from '../../src/main/navigation'
import type { CatalogDatabase } from '../../src/main/services/catalog/database'
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

describe('Stage 8D: photos:get-original IPC validation and error branches', () => {
  const location = resolveAppLocation({
    isPackaged: true,
    rendererUrl: undefined,
    documentPath
  })
  const validateSender = createSenderValidator({
    getTrustedWebContentsId: () => TRUSTED_ID,
    location
  })

  beforeEach(() => {
    registered.clear()
  })

  it('returns Zod-validated missing result when catalog or thumbnailCoordinator is unavailable', async () => {
    registerIpcHandlers({ validateSender, catalog: undefined })
    const res = await invoke(IPC_CHANNELS.PHOTOS_GET_ORIGINAL, trusted, { locationId: 1 })
    expect(OriginalPhotoResultSchema.safeParse(res).success).toBe(true)
    expect(res).toEqual({
      status: 'missing',
      locationId: 1,
      reason: 'Thumbnail coordinator or catalog unavailable'
    })
  })

  it('returns Zod-validated missing result for unknown locationId or non-photo category', async () => {
    const mockCatalog = {
      getFileLocationById: vi.fn((id: number) =>
        id === 99 ? { id: 99, category: 'document', originalPath: 'C:\\Docs\\doc.pdf' } : undefined
      )
    } as unknown as CatalogDatabase
    const mockThumb = {
      getOriginalPhoto: vi.fn()
    } as unknown as ThumbnailCoordinator

    registerIpcHandlers({
      validateSender,
      catalog: mockCatalog,
      thumbnailCoordinator: mockThumb
    })

    const unknownRes = await invoke(IPC_CHANNELS.PHOTOS_GET_ORIGINAL, trusted, { locationId: 777 })
    expect(OriginalPhotoResultSchema.safeParse(unknownRes).success).toBe(true)
    expect(unknownRes).toEqual({
      status: 'missing',
      locationId: 777,
      reason: 'Photograph location ID 777 not found in catalog'
    })

    const docRes = await invoke(IPC_CHANNELS.PHOTOS_GET_ORIGINAL, trusted, { locationId: 99 })
    expect(OriginalPhotoResultSchema.safeParse(docRes).success).toBe(true)
    expect(docRes).toEqual({
      status: 'missing',
      locationId: 99,
      reason: 'Photograph location ID 99 not found in catalog'
    })
    expect(mockThumb.getOriginalPhoto).not.toHaveBeenCalled()
  })

  it('returns Zod-validated missing result when resolveReadableFileLocation cannot find the file', async () => {
    const mockCatalog = {
      getFileLocationById: vi.fn(() => ({
        id: 5,
        sourceId: 1,
        category: 'photo',
        originalPath: 'C:\\Missing\\photo.jpg'
      })),
      getLocationReadResolutionContext: vi.fn(() => undefined)
    } as unknown as CatalogDatabase
    const mockThumb = {
      getOriginalPhoto: vi.fn()
    } as unknown as ThumbnailCoordinator

    registerIpcHandlers({
      validateSender,
      catalog: mockCatalog,
      thumbnailCoordinator: mockThumb
    })

    const res = await invoke(IPC_CHANNELS.PHOTOS_GET_ORIGINAL, trusted, { locationId: 5 })
    expect(OriginalPhotoResultSchema.safeParse(res).success).toBe(true)
    expect((res as { status: string }).status).toBe('missing')
    expect(mockThumb.getOriginalPhoto).not.toHaveBeenCalled()
  })
})
