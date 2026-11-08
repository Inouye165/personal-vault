import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { IpcRenderer } from 'electron'

describe('Preload Photos Bridge', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('validates window.api.getPhotosPage payload across IPC', async () => {
    const mockIpcRenderer = {
      invoke: vi.fn().mockResolvedValue({
        items: [
          {
            id: 1,
            sourceId: 1,
            originalPath: 'C:\\photo.jpg',
            fileName: 'photo.jpg',
            extension: '.jpg',
            category: 'photo',
            discoveryObservationId: 10,
            byteSize: 500,
            filesystemBirthtimeMs: null,
            filesystemMtimeMs: 1700000000000,
            inferredCaptureTimeMs: null,
            firstDiscoveredAtMs: 1700000000000,
            lastSeenAtMs: 1700000000000,
            activeHash: null,
            activeHashVerifiedAtMs: null
          }
        ],
        totalCount: 1,
        offset: 0,
        limit: 50,
        hasMore: false
      })
    }

    vi.doMock('electron', () => ({
      ipcRenderer: mockIpcRenderer,
      contextBridge: {
        exposeInMainWorld: vi.fn()
      }
    }))

    // Load bridge definition
    const { createPhotosApi } = await import('../../src/preload/photos-api')
    const api = createPhotosApi(mockIpcRenderer as unknown as IpcRenderer)

    const res = await api.getPhotosPage({ offset: 0, limit: 50 })
    expect(res.totalCount).toBe(1)
    expect(res.items[0]!.fileName).toBe('photo.jpg')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('photos:get-page', {
      offset: 0,
      limit: 50,
      ratingFilter: 'all',
      flagFilter: 'all',
      collectionId: null
    })
  })

  it('rejects invalid getPhotosPage response from main process', async () => {
    const mockIpcRenderer = {
      invoke: vi.fn().mockResolvedValue({
        malformed: true
      })
    }

    vi.doMock('electron', () => ({
      ipcRenderer: mockIpcRenderer,
      contextBridge: {
        exposeInMainWorld: vi.fn()
      }
    }))

    const { createPhotosApi } = await import('../../src/preload/photos-api')
    const api = createPhotosApi(mockIpcRenderer as unknown as IpcRenderer)

    await expect(api.getPhotosPage({ offset: 0, limit: 50 })).rejects.toThrow()
  })

  it('validates window.api.getThumbnail payload across IPC', async () => {
    const mockIpcRenderer = {
      invoke: vi.fn().mockResolvedValue({
        status: 'ready',
        locationId: 1,
        dataUrl: 'data:image/webp;base64,AAA=',
        mimeType: 'image/webp',
        width: 100,
        height: 100
      })
    }

    vi.doMock('electron', () => ({
      ipcRenderer: mockIpcRenderer,
      contextBridge: {
        exposeInMainWorld: vi.fn()
      }
    }))

    const { createPhotosApi } = await import('../../src/preload/photos-api')
    const api = createPhotosApi(mockIpcRenderer as unknown as IpcRenderer)

    const res = await api.getThumbnail({ locationId: 1, priority: 'high' })
    expect(res.status).toBe('ready')
    if (res.status === 'ready') {
      expect(res.dataUrl).toBe('data:image/webp;base64,AAA=')
    }
  })

  it('validates window.api.setPhotoAnnotation and collection methods across IPC', async () => {
    const mockIpcRenderer = {
      invoke: vi.fn().mockImplementation((channel: string) => {
        if (channel === 'photos:set-annotation') {
          return Promise.resolve({
            success: true,
            annotation: {
              id: 1,
              fileLocationId: 10,
              discoveryObservationId: 100,
              contentSha256: 'a'.repeat(64),
              rating: 5,
              flag: 'pick',
              version: 1,
              isCurrent: true,
              createdAtMs: 1700000000000,
              updatedAtMs: 1700000000000
            }
          })
        }
        if (channel === 'collections:create') {
          return Promise.resolve({
            collection: {
              id: 1,
              name: 'Portraits',
              normalizedName: 'portraits',
              createdAtMs: 1700000000000,
              updatedAtMs: 1700000000000
            }
          })
        }
        return Promise.resolve({})
      })
    }

    vi.doMock('electron', () => ({
      ipcRenderer: mockIpcRenderer,
      contextBridge: {
        exposeInMainWorld: vi.fn()
      }
    }))

    const { createPhotosApi } = await import('../../src/preload/photos-api')
    const api = createPhotosApi(mockIpcRenderer as unknown as IpcRenderer)

    const annRes = await api.setPhotoAnnotation({
      fileLocationId: 10,
      expectedRevision: 'rev:1',
      expectedVersion: 0,
      rating: 5,
      flag: 'pick'
    })
    expect(annRes.success).toBe(true)
    expect(annRes.annotation.rating).toBe(5)
    expect(annRes.annotation.flag).toBe('pick')

    const colRes = await api.createCollection({ name: 'Portraits' })
    expect(colRes.collection.name).toBe('Portraits')

    mockIpcRenderer.invoke.mockImplementationOnce((channel: string) => {
      if (channel === 'photos:reconcile-journal') {
        return Promise.resolve({
          success: true,
          reconciledCount: 3
        })
      }
      return Promise.resolve({})
    })
    const recRes = await api.reconcileJournal()
    expect(recRes.success).toBe(true)
    expect(recRes.reconciledCount).toBe(3)

    // addCollectionMember requires expectedRevision
    await expect(
      api.addCollectionMember({
        collectionId: 1,
        fileLocationId: 10
      } as unknown as import('../../src/shared/validation/ipc-schemas').AddCollectionMemberRequest)
    ).rejects.toThrow()
  })
})
