/**
 * @vitest-environment node
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'

type IpcHandler = (...args: unknown[]) => Promise<unknown>
const ipcHandlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      ipcHandlers.set(channel, handler)
    }
  }
}))

describe('Stage 7A — Documents IPC Handlers', () => {
  let tempDir: string
  let catalog: CatalogDatabase

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-docs-ipc-test-'))
    catalog = CatalogDatabase.open({ catalogPath: join(tempDir, 'catalog.db') })
    ipcHandlers.clear()
  })

  afterEach(() => {
    if (!catalog.isClosed()) {
      catalog.close()
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('rejects unauthorized senders for all document channels', async () => {
    const validateSender = vi.fn().mockReturnValue(false)
    registerIpcHandlers({ validateSender, catalog })

    for (const channel of [
      IPC_CHANNELS.DOCUMENTS_GET_PAGE,
      IPC_CHANNELS.DOCUMENTS_GET_DETAIL,
      IPC_CHANNELS.DOCUMENTS_GET_EXTENSION_FACETS
    ]) {
      const handler = ipcHandlers.get(channel)
      expect(handler).toBeDefined()
      await expect(handler!({}, { offset: 0, limit: 20 })).rejects.toThrow(
        `Unauthorized IPC sender for ${channel}`
      )
    }
  })

  it('validates requests and returns paginated documents, detail, and extension facets', async () => {
    const sourceRoot = join(tempDir, 'docs')
    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: join(sourceRoot, 'plan.md'),
        fileName: 'plan.md',
        extension: '.md',
        category: 'document',
        byteSize: 320,
        birthtimeMs: null,
        mtimeMs: 1_700_000_000_000,
        discoveredAtMs: 1_700_000_001_000
      }
    ])

    const validateSender = vi.fn().mockReturnValue(true)
    registerIpcHandlers({ validateSender, catalog })

    const pageHandler = ipcHandlers.get(IPC_CHANNELS.DOCUMENTS_GET_PAGE)!
    const detailHandler = ipcHandlers.get(IPC_CHANNELS.DOCUMENTS_GET_DETAIL)!
    const facetsHandler = ipcHandlers.get(IPC_CHANNELS.DOCUMENTS_GET_EXTENSION_FACETS)!

    await expect(pageHandler({}, { offset: -1, limit: 10 })).rejects.toThrow(
      /Invalid documents:get-page request/
    )

    const page = (await pageHandler({}, { offset: 0, limit: 50 })) as {
      items: Array<{ fileLocationId: number; fileName: string; extractionStatus: string }>
      totalCount: number
    }
    expect(page.totalCount).toBe(1)
    expect(page.items[0]!.fileName).toBe('plan.md')
    expect(page.items[0]!.extractionStatus).toBe('not_extracted')

    const detail = (await detailHandler({}, { fileLocationId: page.items[0]!.fileLocationId })) as {
      item: { sourceRootPath: string; filesystemBirthtimeMs: number | null } | null
    }
    expect(detail.item?.sourceRootPath).toBe(sourceRoot)
    expect(detail.item?.filesystemBirthtimeMs).toBeNull()

    const facets = (await facetsHandler({}, { offset: 0, limit: 50 })) as {
      items: Array<{ extension: string; count: number }>
      totalCount: number
    }
    expect(facets.totalCount).toBe(1)
    expect(facets.items).toEqual([{ extension: '.md', count: 1 }])
  })
})
