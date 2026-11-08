/**
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'

type IpcHandler = (...args: unknown[]) => unknown
const ipcHandlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      ipcHandlers.set(channel, handler)
    }
  }
}))

describe('Photo Review & Collections IPC Handlers (Stage 5B)', () => {
  let tempDir: string
  let catalog: CatalogDatabase
  let journal: AnnotationJournal
  const validEvent = { senderFrame: { url: 'http://localhost:5173' } }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-photo-review-ipc-test-'))
    const catalogPath = join(tempDir, 'catalog.db')
    const journalDir = join(tempDir, 'annotations')

    journal = new AnnotationJournal({ storageDir: journalDir })
    await journal.initialize()

    catalog = CatalogDatabase.open({ catalogPath, journal })
    ipcHandlers.clear()
  })

  afterEach(() => {
    try {
      catalog.close()
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('rejects unauthorized senders across all review and collection channels', async () => {
    const validateSender = vi.fn().mockReturnValue(false)
    registerIpcHandlers({
      validateSender,
      catalog
    })

    const channels = [
      IPC_CHANNELS.PHOTOS_SET_ANNOTATION,
      IPC_CHANNELS.PHOTOS_GET_ANNOTATION,
      IPC_CHANNELS.COLLECTIONS_LIST,
      IPC_CHANNELS.COLLECTIONS_CREATE,
      IPC_CHANNELS.COLLECTIONS_RENAME,
      IPC_CHANNELS.COLLECTIONS_ADD_MEMBER,
      IPC_CHANNELS.COLLECTIONS_REMOVE_MEMBER,
      IPC_CHANNELS.COLLECTIONS_GET_MEMBERSHIPS_FOR_PHOTO
    ]

    for (const channel of channels) {
      const handler = ipcHandlers.get(channel)
      expect(handler).toBeDefined()
      await expect(handler!({} as never, {})).rejects.toThrow(/unauthorized ipc sender/i)
    }
  })

  it('rejects malformed requests crossing the IPC boundary', async () => {
    const validateSender = vi.fn().mockReturnValue(true)
    registerIpcHandlers({
      validateSender,
      catalog
    })

    const setAnnotationHandler = ipcHandlers.get(IPC_CHANNELS.PHOTOS_SET_ANNOTATION)!
    await expect(setAnnotationHandler(validEvent, { fileLocationId: -1 })).rejects.toThrow(
      /invalid/i
    )

    const createCollectionHandler = ipcHandlers.get(IPC_CHANNELS.COLLECTIONS_CREATE)!
    await expect(createCollectionHandler(validEvent, { name: '' })).rejects.toThrow(/invalid/i)
  })

  it('handles collection lifecycle and membership operations across IPC', async () => {
    const validateSender = vi.fn().mockReturnValue(true)
    registerIpcHandlers({
      validateSender,
      catalog
    })

    const createHandler = ipcHandlers.get(IPC_CHANNELS.COLLECTIONS_CREATE)!
    const renameHandler = ipcHandlers.get(IPC_CHANNELS.COLLECTIONS_RENAME)!
    const listHandler = ipcHandlers.get(IPC_CHANNELS.COLLECTIONS_LIST)!
    const addMemberHandler = ipcHandlers.get(IPC_CHANNELS.COLLECTIONS_ADD_MEMBER)!
    const removeMemberHandler = ipcHandlers.get(IPC_CHANNELS.COLLECTIONS_REMOVE_MEMBER)!
    const getMembershipsHandler = ipcHandlers.get(
      IPC_CHANNELS.COLLECTIONS_GET_MEMBERSHIPS_FOR_PHOTO
    )!

    // 1. Create collection
    const createRes = (await createHandler(validEvent, { name: 'Landscapes' })) as {
      collection: { id: number; name: string }
    }
    expect(createRes.collection.id).toBeGreaterThan(0)
    expect(createRes.collection.name).toBe('Landscapes')

    // 2. Rename collection
    const renameRes = (await renameHandler(validEvent, {
      collectionId: createRes.collection.id,
      name: 'Scenic Landscapes'
    })) as { collection: { id: number; name: string } }
    expect(renameRes.collection.name).toBe('Scenic Landscapes')

    // 3. List collections
    const listRes = (await listHandler(validEvent, {})) as {
      items: Array<{ id: number; name: string }>
      totalCount: number
    }
    expect(listRes.totalCount).toBe(1)
    expect(listRes.items[0]!.name).toBe('Scenic Landscapes')

    // Register source and photo
    const sourceRoot = 'C:\\photos'
    catalog.registerSource(sourceRoot)
    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: 'C:\\photos\\p1.jpg',
        fileName: 'p1.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 1000,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000000000,
        discoveredAtMs: 1700000000000
      }
    ])
    const p1 = catalog.getFileLocationByPath('C:\\photos\\p1.jpg')!

    // 4. Add member
    const addRes = (await addMemberHandler(validEvent, {
      collectionId: createRes.collection.id,
      fileLocationId: p1.id
    })) as { success: boolean; isNew: boolean }
    expect(addRes.success).toBe(true)
    expect(addRes.isNew).toBe(true)

    // 5. Get memberships
    const membershipsRes = (await getMembershipsHandler(validEvent, {
      fileLocationId: p1.id
    })) as { items: Array<{ collectionName: string }>; totalCount: number }
    expect(membershipsRes.totalCount).toBe(1)
    expect(membershipsRes.items[0]!.collectionName).toBe('Scenic Landscapes')

    // 6. Remove member
    const removeRes = (await removeMemberHandler(validEvent, {
      collectionId: createRes.collection.id,
      fileLocationId: p1.id
    })) as { success: boolean }
    expect(removeRes.success).toBe(true)
  })

  it('handles setting and retrieving photo annotations across IPC', async () => {
    const validateSender = vi.fn().mockReturnValue(true)
    registerIpcHandlers({
      validateSender,
      catalog
    })

    const setAnnotationHandler = ipcHandlers.get(IPC_CHANNELS.PHOTOS_SET_ANNOTATION)!
    const getAnnotationHandler = ipcHandlers.get(IPC_CHANNELS.PHOTOS_GET_ANNOTATION)!

    const sourceRoot = 'C:\\photos'
    catalog.registerSource(sourceRoot)
    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: 'C:\\photos\\p1.jpg',
        fileName: 'p1.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 1000,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000000000,
        discoveredAtMs: 1700000000000
      }
    ])
    const p1 = catalog.getFileLocationByPath('C:\\photos\\p1.jpg')!
    const rev = catalog.getPhotoRevisionString(p1.id)

    // Set annotation: 4 stars, pick
    const setRes = (await setAnnotationHandler(validEvent, {
      fileLocationId: p1.id,
      expectedRevision: rev,
      expectedVersion: 0,
      rating: 4,
      flag: 'pick'
    })) as { success: boolean; annotation: { rating: number; flag: string } }

    expect(setRes.success).toBe(true)
    expect(setRes.annotation.rating).toBe(4)
    expect(setRes.annotation.flag).toBe('pick')

    // Get annotation
    const getRes = (await getAnnotationHandler(validEvent, {
      fileLocationId: p1.id
    })) as { annotation: { rating: number; flag: string } | null }

    expect(getRes.annotation).not.toBeNull()
    expect(getRes.annotation?.rating).toBe(4)
    expect(getRes.annotation?.flag).toBe('pick')
  })
})
