/**
 * @vitest-environment node
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
      IPC_CHANNELS.DOCUMENTS_GET_EXTENSION_FACETS,
      IPC_CHANNELS.DOCUMENTS_GET_PREVIEW,
      IPC_CHANNELS.DOCUMENTS_EXTRACT_SELECTED,
      IPC_CHANNELS.DOCUMENTS_START_EXTRACTION,
      IPC_CHANNELS.DOCUMENTS_PAUSE_EXTRACTION,
      IPC_CHANNELS.DOCUMENTS_RESUME_EXTRACTION,
      IPC_CHANNELS.DOCUMENTS_CANCEL_EXTRACTION,
      IPC_CHANNELS.DOCUMENTS_GET_EXTRACTION_PROGRESS,
      IPC_CHANNELS.OCR_MODEL_GET_STATUS,
      IPC_CHANNELS.OCR_MODEL_DOWNLOAD,
      IPC_CHANNELS.OCR_MODEL_IMPORT,
      IPC_CHANNELS.OCR_MODEL_CANCEL,
      IPC_CHANNELS.DOCUMENTS_OCR_GET_STATE,
      IPC_CHANNELS.DOCUMENTS_OCR_GET_PREVIEW,
      IPC_CHANNELS.DOCUMENTS_OCR_SELECTED,
      IPC_CHANNELS.DOCUMENTS_OCR_START,
      IPC_CHANNELS.DOCUMENTS_OCR_PAUSE,
      IPC_CHANNELS.DOCUMENTS_OCR_RESUME,
      IPC_CHANNELS.DOCUMENTS_OCR_CANCEL,
      IPC_CHANNELS.DOCUMENTS_OCR_GET_PROGRESS
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

  it('registers Stage 7C OCR IPC handlers with sender validation, path-injection guard, and Zod validation', async () => {
    const sourceRoot = join(tempDir, 'docs')
    mkdirSync(sourceRoot, { recursive: true })
    const docPath = join(sourceRoot, 'scan.pdf')
    writeFileSync(docPath, '%PDF-1.4\n%%EOF\n')

    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: docPath,
        fileName: 'scan.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 15,
        birthtimeMs: null,
        mtimeMs: 1_700_000_000_000,
        discoveredAtMs: 1_700_000_001_000
      }
    ])

    const { OcrModelManager, DocumentOcrCoordinator } =
      await import('../../src/main/services/documents/ocr')
    const modelManager = new OcrModelManager({
      modelsRootDir: join(tempDir, 'ocr-models'),
      getApprovedRoots: () => [sourceRoot],
      getVaultRoot: () => null
    })
    await modelManager.initialize()

    const ocrCoord = new DocumentOcrCoordinator({
      catalog,
      modelManager,
      isPackaged: false
    })
    ocrCoord.initialize()

    try {
      const validateSender = vi.fn().mockReturnValue(true)
      registerIpcHandlers({
        validateSender,
        catalog,
        ocrModelManager: modelManager,
        documentOcrCoordinator: ocrCoord
      })

      // 1. OCR_MODEL_IMPORT rejects renderer-supplied paths
      const importHandler = ipcHandlers.get(IPC_CHANNELS.OCR_MODEL_IMPORT)!
      await expect(importHandler({}, 'C:\\evil\\path')).rejects.toThrow(
        /Renderer cannot supply filesystem paths/i
      )

      // 2. OCR_MODEL_GET_STATUS returns validated status
      const modelStatusHandler = ipcHandlers.get(IPC_CHANNELS.OCR_MODEL_GET_STATUS)!
      const status = (await modelStatusHandler({})) as { state: string; language: string }
      expect(status.state).toBe('missing')
      expect(status.language).toBe('eng')

      // 3. DOCUMENTS_OCR_GET_PROGRESS returns validated progress
      const progressHandler = ipcHandlers.get(IPC_CHANNELS.DOCUMENTS_OCR_GET_PROGRESS)!
      const progress = (await progressHandler({})) as {
        status: string
        coverage: { totalDocuments: number }
      }
      expect(progress.status).toBe('idle')

      // 4. Event-only channels cannot be invoked
      const eventOnlyHandler = ipcHandlers.get(IPC_CHANNELS.DOCUMENTS_OCR_PROGRESS_EVENT)!
      await expect(eventOnlyHandler({})).rejects.toThrow(/Event-only channel/i)

      // 5. Invalid request rejected by Zod
      const selectedHandler = ipcHandlers.get(IPC_CHANNELS.DOCUMENTS_OCR_SELECTED)!
      await expect(selectedHandler({}, { fileLocationIds: [] })).rejects.toThrow(
        /Invalid documents:ocr-selected request/i
      )

      // 6. Untrusted sender is rejected before reaching handler logic
      validateSender.mockReturnValueOnce(false)
      await expect(modelStatusHandler({})).rejects.toThrow(/Unauthorized IPC sender/i)
    } finally {
      await ocrCoord.shutdown()
    }
  })
})
