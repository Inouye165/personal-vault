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
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('photos:get-page', { offset: 0, limit: 50 })
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
})
