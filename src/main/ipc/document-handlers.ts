import { dialog, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/contracts/channels'
import {
  ClassifySelectedDocumentsRequestSchema,
  DocSemanticModelStatusSchema,
  DocSemanticProgressSchema,
  DocSemanticSearchRequestSchema,
  DocSemanticSearchResponseSchema,
  DocSemanticSearchCancelRequestSchema,
  DocSemanticSearchCancelResponseSchema,
  DocumentClassificationOverrideAckSchema,
  DocumentClassificationProgressSchema,
  DocumentExtractionProgressSchema,
  DocumentOcrProgressSchema,
  ExtractSelectedDocumentsRequestSchema,
  GetDocumentClassificationFacetsRequestSchema,
  GetDocumentClassificationFacetsResponseSchema,
  GetDocumentDetailRequestSchema,
  GetDocumentDetailResponseSchema,
  GetDocumentExtensionFacetsRequestSchema,
  GetDocumentExtensionFacetsResponseSchema,
  GetDocumentOcrPreviewRequestSchema,
  GetDocumentOcrPreviewResponseSchema,
  GetDocumentOcrStateRequestSchema,
  GetDocumentOcrStateResponseSchema,
  GetDocumentPreviewRequestSchema,
  GetDocumentPreviewResponseSchema,
  GetDocumentsPageRequestSchema,
  GetDocumentsPageResponseSchema,
  IndexSelectedDocumentsRequestSchema,
  OcrModelStatusSchema,
  OcrSelectedDocumentsRequestSchema,
  ResetDocumentClassificationOverrideRequestSchema,
  SetDocumentClassificationOverrideRequestSchema,
  StartDocSemanticIndexRequestSchema,
  StartDocumentClassificationRequestSchema,
  StartDocumentExtractionRequestSchema,
  StartDocumentOcrRequestSchema
} from '../../shared/validation/document-schemas'
import { validatePayload } from '../../shared/validation/ipc-schemas'
import type { CatalogDatabase } from '../services/catalog'
import type { DocumentExtractionCoordinator } from '../services/documents'
import type { DocumentClassificationCoordinator } from '../services/documents/classification/coordinator'
import type { DocumentOcrCoordinator, OcrModelManager } from '../services/documents/ocr'
import type {
  DocSemanticModelManager,
  DocumentSearchCoordinator,
  DocumentSemanticCoordinator
} from '../services/documents/semantic'
import type { UnifiedSearchCoordinator } from '../services/unified-search'

export interface DocumentIpcHandlerDeps {
  readonly handle: <Args extends unknown[], Result>(
    channel: string,
    fn: (...args: Args) => Result | Promise<Result>
  ) => void
  readonly catalog?: CatalogDatabase
  readonly documentExtractionCoordinator?: DocumentExtractionCoordinator
  readonly ocrModelManager?: OcrModelManager
  readonly documentOcrCoordinator?: DocumentOcrCoordinator
  readonly docSemanticModelManager?: DocSemanticModelManager
  readonly docSemanticCoordinator?: DocumentSemanticCoordinator
  readonly docSearchCoordinator?: DocumentSearchCoordinator
  readonly unifiedSearchCoordinator?: UnifiedSearchCoordinator
  readonly documentClassificationCoordinator?: DocumentClassificationCoordinator
  readonly getMainWindow?: () => BrowserWindow | null
  readonly selectOcrModelDirectory?: () => Promise<string | null>
  readonly selectDocSemanticModelDirectory?: () => Promise<string | null>
}

function validateOcrModelStatusOut(status: unknown) {
  const res = validatePayload(OcrModelStatusSchema, status)
  if (!res.success) {
    throw new Error(`Invalid OCR model status response: ${res.error}`)
  }
  return res.data
}

function validateOcrProgressOut(progress: unknown) {
  const res = validatePayload(DocumentOcrProgressSchema, progress)
  if (!res.success) {
    throw new Error(`Invalid OCR progress response: ${res.error}`)
  }
  return res.data
}

function validateDocSemanticModelStatusOut(status: unknown) {
  const res = validatePayload(DocSemanticModelStatusSchema, status)
  if (!res.success) {
    throw new Error(`Invalid doc semantic model status response: ${res.error}`)
  }
  return res.data
}

function validateDocSemanticProgressOut(progress: unknown) {
  const res = validatePayload(DocSemanticProgressSchema, progress)
  if (!res.success) {
    throw new Error(`Invalid doc semantic progress response: ${res.error}`)
  }
  return res.data
}

function validateDocClassificationProgressOut(progress: unknown) {
  const res = validatePayload(DocumentClassificationProgressSchema, progress)
  if (!res.success) {
    throw new Error(`Invalid document classification progress response: ${res.error}`)
  }
  return res.data
}

export function registerDocumentIpcHandlers({
  handle,
  catalog,
  documentExtractionCoordinator,
  ocrModelManager,
  documentOcrCoordinator,
  docSemanticModelManager,
  docSemanticCoordinator,
  docSearchCoordinator,
  unifiedSearchCoordinator,
  documentClassificationCoordinator,
  getMainWindow,
  selectOcrModelDirectory,
  selectDocSemanticModelDirectory
}: DocumentIpcHandlerDeps): void {
  handle(IPC_CHANNELS.DOCUMENTS_GET_PAGE, (rawRequest: unknown) => {
    const req = validatePayload(GetDocumentsPageRequestSchema, rawRequest)
    if (!req.success) {
      throw new Error(`Invalid documents:get-page request: ${req.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog database is not initialized')
    }
    const processingIds = documentExtractionCoordinator?.getProcessingFileLocationIds()
    const page = catalog.getDocumentsPage(req.data, { processingFileLocationIds: processingIds })
    const res = validatePayload(GetDocumentsPageResponseSchema, page)
    if (!res.success) {
      throw new Error(`Invalid documents:get-page response: ${res.error}`)
    }
    return res.data
  })

  handle(IPC_CHANNELS.DOCUMENTS_GET_DETAIL, (rawRequest: unknown) => {
    const req = validatePayload(GetDocumentDetailRequestSchema, rawRequest)
    if (!req.success) {
      throw new Error(`Invalid documents:get-detail request: ${req.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog database is not initialized')
    }
    const processingIds = documentExtractionCoordinator?.getProcessingFileLocationIds()
    const item = catalog.getDocumentDetail(req.data.fileLocationId, {
      processingFileLocationIds: processingIds
    })
    const res = validatePayload(GetDocumentDetailResponseSchema, { item })
    if (!res.success) {
      throw new Error(`Invalid documents:get-detail response: ${res.error}`)
    }
    return res.data
  })

  handle(IPC_CHANNELS.DOCUMENTS_GET_EXTENSION_FACETS, (rawRequest: unknown) => {
    const req = validatePayload(GetDocumentExtensionFacetsRequestSchema, rawRequest ?? {})
    if (!req.success) {
      throw new Error(`Invalid documents:get-extension-facets request: ${req.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog database is not initialized')
    }
    const facets = catalog.getDocumentExtensionFacets(req.data)
    const res = validatePayload(GetDocumentExtensionFacetsResponseSchema, facets)
    if (!res.success) {
      throw new Error(`Invalid documents:get-extension-facets response: ${res.error}`)
    }
    return res.data
  })

  handle(IPC_CHANNELS.DOCUMENTS_GET_PREVIEW, (rawRequest: unknown) => {
    const req = validatePayload(GetDocumentPreviewRequestSchema, rawRequest)
    if (!req.success) {
      throw new Error(`Invalid documents:get-preview request: ${req.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog database is not initialized')
    }
    const preview = documentExtractionCoordinator
      ? documentExtractionCoordinator.getPreview(req.data.fileLocationId)
      : catalog.getDocumentRepository().getDocumentPreview(req.data.fileLocationId)
    const res = validatePayload(GetDocumentPreviewResponseSchema, { preview })
    if (!res.success) {
      throw new Error(`Invalid documents:get-preview response: ${res.error}`)
    }
    return res.data
  })

  handle(IPC_CHANNELS.DOCUMENTS_EXTRACT_SELECTED, async (rawRequest: unknown) => {
    const req = validatePayload(ExtractSelectedDocumentsRequestSchema, rawRequest)
    if (!req.success) {
      throw new Error(`Invalid documents:extract-selected request: ${req.error}`)
    }
    if (!documentExtractionCoordinator) {
      throw new Error('Document extraction coordinator is not initialized')
    }
    const progress = await documentExtractionCoordinator.extractSelected(req.data)
    const res = validatePayload(DocumentExtractionProgressSchema, progress)
    if (!res.success) {
      throw new Error(`Invalid documents:extract-selected response: ${res.error}`)
    }
    return res.data
  })

  handle(IPC_CHANNELS.DOCUMENTS_START_EXTRACTION, async (rawRequest: unknown) => {
    const req = validatePayload(StartDocumentExtractionRequestSchema, rawRequest ?? {})
    if (!req.success) {
      throw new Error(`Invalid documents:start-extraction request: ${req.error}`)
    }
    if (!documentExtractionCoordinator) {
      throw new Error('Document extraction coordinator is not initialized')
    }
    const progress = await documentExtractionCoordinator.startExtraction(req.data)
    const res = validatePayload(DocumentExtractionProgressSchema, progress)
    if (!res.success) {
      throw new Error(`Invalid documents:start-extraction response: ${res.error}`)
    }
    return res.data
  })

  handle(IPC_CHANNELS.DOCUMENTS_PAUSE_EXTRACTION, () => {
    if (!documentExtractionCoordinator) {
      throw new Error('Document extraction coordinator is not initialized')
    }
    const progress = documentExtractionCoordinator.pauseExtraction()
    const res = validatePayload(DocumentExtractionProgressSchema, progress)
    if (!res.success) {
      throw new Error(`Invalid documents:pause-extraction response: ${res.error}`)
    }
    return res.data
  })

  handle(IPC_CHANNELS.DOCUMENTS_RESUME_EXTRACTION, () => {
    if (!documentExtractionCoordinator) {
      throw new Error('Document extraction coordinator is not initialized')
    }
    const progress = documentExtractionCoordinator.resumeExtraction()
    const res = validatePayload(DocumentExtractionProgressSchema, progress)
    if (!res.success) {
      throw new Error(`Invalid documents:resume-extraction response: ${res.error}`)
    }
    return res.data
  })

  handle(IPC_CHANNELS.DOCUMENTS_CANCEL_EXTRACTION, async () => {
    if (!documentExtractionCoordinator) {
      throw new Error('Document extraction coordinator is not initialized')
    }
    const progress = await documentExtractionCoordinator.cancelExtraction()
    const res = validatePayload(DocumentExtractionProgressSchema, progress)
    if (!res.success) {
      throw new Error(`Invalid documents:cancel-extraction response: ${res.error}`)
    }
    return res.data
  })

  handle(IPC_CHANNELS.DOCUMENTS_GET_EXTRACTION_PROGRESS, () => {
    if (!documentExtractionCoordinator) {
      throw new Error('Document extraction coordinator is not initialized')
    }
    const progress = documentExtractionCoordinator.getProgress()
    const res = validatePayload(DocumentExtractionProgressSchema, progress)
    if (!res.success) {
      throw new Error(`Invalid documents:get-extraction-progress response: ${res.error}`)
    }
    return res.data
  })

  handle(IPC_CHANNELS.DOCUMENTS_EXTRACTION_PROGRESS_EVENT, (): never => {
    throw new Error('Event-only channel cannot be invoked')
  })

  if (documentExtractionCoordinator && getMainWindow) {
    documentExtractionCoordinator.onProgress((progress) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        const res = validatePayload(DocumentExtractionProgressSchema, progress)
        if (res.success) {
          win.webContents.send(IPC_CHANNELS.DOCUMENTS_EXTRACTION_PROGRESS_EVENT, res.data)
        }
      }
    })
  }

  // ─── Stage 7C: Offline OCR Model & Job IPC ─────────────────────────────────

  handle(IPC_CHANNELS.OCR_MODEL_GET_STATUS, () => {
    if (!ocrModelManager) {
      throw new Error('OCR model manager is not initialized')
    }
    return validateOcrModelStatusOut(ocrModelManager.getStatus())
  })

  handle(IPC_CHANNELS.OCR_MODEL_DOWNLOAD, async () => {
    if (!ocrModelManager) {
      throw new Error('OCR model manager is not initialized')
    }
    const status = await ocrModelManager.downloadModel()
    return validateOcrModelStatusOut(status)
  })

  handle(IPC_CHANNELS.OCR_MODEL_IMPORT, async (raw?: unknown) => {
    if (raw !== undefined) {
      throw new Error('Renderer cannot supply filesystem paths to ocr:model-import')
    }
    if (!ocrModelManager) {
      throw new Error('OCR model manager is not initialized')
    }

    let chosenDir: string | null = null
    if (selectOcrModelDirectory) {
      chosenDir = await selectOcrModelDirectory()
    } else if (process.env.PV_TEST_OCR_MODEL_IMPORT_DIR) {
      chosenDir = process.env.PV_TEST_OCR_MODEL_IMPORT_DIR
    } else {
      const win = getMainWindow ? getMainWindow() : null
      const dialogOpts: Electron.OpenDialogOptions = {
        title: 'Select Verified English OCR Model Folder',
        properties: ['openDirectory', 'dontAddToRecent']
      }
      const dialogRes = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts)
      if (!dialogRes.canceled && dialogRes.filePaths.length > 0) {
        chosenDir = dialogRes.filePaths[0] ?? null
      }
    }

    if (!chosenDir) {
      return validateOcrModelStatusOut(ocrModelManager.getStatus())
    }

    const status = await ocrModelManager.importFromDirectory(chosenDir)
    return validateOcrModelStatusOut(status)
  })

  handle(IPC_CHANNELS.OCR_MODEL_CANCEL, async () => {
    if (!ocrModelManager) {
      throw new Error('OCR model manager is not initialized')
    }
    const status = await ocrModelManager.cancelProvisioning()
    return validateOcrModelStatusOut(status)
  })

  handle(IPC_CHANNELS.OCR_MODEL_STATUS_EVENT, (): never => {
    throw new Error('Event-only channel cannot be invoked')
  })

  handle(IPC_CHANNELS.DOCUMENTS_OCR_GET_STATE, (rawRequest: unknown) => {
    const req = validatePayload(GetDocumentOcrStateRequestSchema, rawRequest)
    if (!req.success) {
      throw new Error(`Invalid documents:ocr-get-state request: ${req.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog database is not initialized')
    }
    const state = documentOcrCoordinator
      ? documentOcrCoordinator.getOcrState(req.data.fileLocationId)
      : catalog.getDocumentOcrRepository().getDocumentOcrState(req.data.fileLocationId)
    const res = validatePayload(GetDocumentOcrStateResponseSchema, { state })
    if (!res.success) {
      throw new Error(`Invalid documents:ocr-get-state response: ${res.error}`)
    }
    return res.data
  })

  handle(IPC_CHANNELS.DOCUMENTS_OCR_GET_PREVIEW, (rawRequest: unknown) => {
    const req = validatePayload(GetDocumentOcrPreviewRequestSchema, rawRequest)
    if (!req.success) {
      throw new Error(`Invalid documents:ocr-get-preview request: ${req.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog database is not initialized')
    }
    const preview = documentOcrCoordinator
      ? documentOcrCoordinator.getOcrPreview(req.data.fileLocationId)
      : catalog.getDocumentOcrRepository().getDocumentOcrPreview(req.data.fileLocationId)
    const res = validatePayload(GetDocumentOcrPreviewResponseSchema, { preview })
    if (!res.success) {
      throw new Error(`Invalid documents:ocr-get-preview response: ${res.error}`)
    }
    return res.data
  })

  handle(IPC_CHANNELS.DOCUMENTS_OCR_SELECTED, async (rawRequest: unknown) => {
    const req = validatePayload(OcrSelectedDocumentsRequestSchema, rawRequest)
    if (!req.success) {
      throw new Error(`Invalid documents:ocr-selected request: ${req.error}`)
    }
    if (!documentOcrCoordinator) {
      throw new Error('Document OCR coordinator is not initialized')
    }
    const progress = await documentOcrCoordinator.ocrSelected(req.data)
    return validateOcrProgressOut(progress)
  })

  handle(IPC_CHANNELS.DOCUMENTS_OCR_START, async (rawRequest: unknown) => {
    const req = validatePayload(StartDocumentOcrRequestSchema, rawRequest ?? {})
    if (!req.success) {
      throw new Error(`Invalid documents:ocr-start request: ${req.error}`)
    }
    if (!documentOcrCoordinator) {
      throw new Error('Document OCR coordinator is not initialized')
    }
    const progress = await documentOcrCoordinator.startOcr(req.data)
    return validateOcrProgressOut(progress)
  })

  handle(IPC_CHANNELS.DOCUMENTS_OCR_PAUSE, () => {
    if (!documentOcrCoordinator) {
      throw new Error('Document OCR coordinator is not initialized')
    }
    return validateOcrProgressOut(documentOcrCoordinator.pauseOcr())
  })

  handle(IPC_CHANNELS.DOCUMENTS_OCR_RESUME, async () => {
    if (!documentOcrCoordinator) {
      throw new Error('Document OCR coordinator is not initialized')
    }
    const progress = await documentOcrCoordinator.resumeOcr()
    return validateOcrProgressOut(progress)
  })

  handle(IPC_CHANNELS.DOCUMENTS_OCR_CANCEL, async () => {
    if (!documentOcrCoordinator) {
      throw new Error('Document OCR coordinator is not initialized')
    }
    const progress = await documentOcrCoordinator.cancelOcr()
    return validateOcrProgressOut(progress)
  })

  handle(IPC_CHANNELS.DOCUMENTS_OCR_GET_PROGRESS, () => {
    if (!documentOcrCoordinator) {
      throw new Error('Document OCR coordinator is not initialized')
    }
    return validateOcrProgressOut(documentOcrCoordinator.getProgress())
  })

  handle(IPC_CHANNELS.DOCUMENTS_OCR_PROGRESS_EVENT, (): never => {
    throw new Error('Event-only channel cannot be invoked')
  })

  if (ocrModelManager && getMainWindow) {
    ocrModelManager.onStatusChange((status) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        const res = validatePayload(OcrModelStatusSchema, status)
        if (res.success) {
          win.webContents.send(IPC_CHANNELS.OCR_MODEL_STATUS_EVENT, res.data)
        }
      }
    })
  }

  if (documentOcrCoordinator && getMainWindow) {
    documentOcrCoordinator.onProgress((progress) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        const res = validatePayload(DocumentOcrProgressSchema, progress)
        if (res.success) {
          win.webContents.send(IPC_CHANNELS.DOCUMENTS_OCR_PROGRESS_EVENT, res.data)
        }
      }
    })
  }

  // -------------------------------------------------------------------------
  // Stage 7D: Document Semantic Model, Indexing & Search Handlers
  // -------------------------------------------------------------------------

  handle(IPC_CHANNELS.DOC_SEMANTIC_MODEL_GET_STATUS, async () => {
    if (!docSemanticModelManager) {
      throw new Error('Document semantic model manager is not initialized')
    }
    const status = await docSemanticModelManager.refreshStatus()
    return validateDocSemanticModelStatusOut(status)
  })

  handle(IPC_CHANNELS.DOC_SEMANTIC_MODEL_DOWNLOAD, async () => {
    if (!docSemanticModelManager) {
      throw new Error('Document semantic model manager is not initialized')
    }
    const status = await docSemanticModelManager.downloadModel()
    return validateDocSemanticModelStatusOut(status)
  })

  handle(IPC_CHANNELS.DOC_SEMANTIC_MODEL_IMPORT, async (rawArg?: unknown) => {
    if (rawArg !== undefined) {
      throw new Error('doc-semantic:model-import does not accept renderer path arguments')
    }
    if (!docSemanticModelManager) {
      throw new Error('Document semantic model manager is not initialized')
    }

    let selectedDir: string | null = null
    if (selectDocSemanticModelDirectory) {
      selectedDir = await selectDocSemanticModelDirectory()
    } else if (process.env.PV_TEST_DOC_MODEL_IMPORT_DIR) {
      selectedDir = process.env.PV_TEST_DOC_MODEL_IMPORT_DIR
    } else {
      const win = getMainWindow?.() ?? null
      const dialogOptions: Electron.OpenDialogOptions = {
        title: 'Select Offline Document Search Model Folder (Xenova/bge-small-en-v1.5)',
        properties: ['openDirectory']
      }
      const picked = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      if (!picked.canceled && picked.filePaths.length > 0) {
        selectedDir = picked.filePaths[0] ?? null
      }
    }

    if (!selectedDir) {
      return validateDocSemanticModelStatusOut(docSemanticModelManager.getStatus())
    }
    const status = await docSemanticModelManager.importFromDirectory(selectedDir)
    return validateDocSemanticModelStatusOut(status)
  })

  handle(IPC_CHANNELS.DOC_SEMANTIC_MODEL_CANCEL, async () => {
    if (!docSemanticModelManager) {
      throw new Error('Document semantic model manager is not initialized')
    }
    const status = await docSemanticModelManager.cancelProvisioning()
    return validateDocSemanticModelStatusOut(status)
  })

  handle(IPC_CHANNELS.DOC_SEMANTIC_INDEX_SELECTED, async (rawRequest: unknown) => {
    const req = validatePayload(IndexSelectedDocumentsRequestSchema, rawRequest)
    if (!req.success) {
      throw new Error(`Invalid doc-semantic:index-selected request: ${req.error}`)
    }
    if (!docSemanticCoordinator) {
      throw new Error('Document semantic coordinator is not initialized')
    }
    await docSemanticCoordinator.startIndexing({
      scopeKind: 'selected',
      fileLocationIds: req.data.fileLocationIds,
      forceReindex: req.data.forceReindex
    })
    return validateDocSemanticProgressOut(docSemanticCoordinator.getProgress())
  })

  handle(IPC_CHANNELS.DOC_SEMANTIC_INDEX_START, async (rawRequest: unknown) => {
    const req = validatePayload(StartDocSemanticIndexRequestSchema, rawRequest ?? {})
    if (!req.success) {
      throw new Error(`Invalid doc-semantic:index-start request: ${req.error}`)
    }
    if (!docSemanticCoordinator) {
      throw new Error('Document semantic coordinator is not initialized')
    }
    await docSemanticCoordinator.startIndexing({
      scopeKind: req.data.scope,
      extensionFilter: req.data.extensionFilter,
      filenameQuery: req.data.filenameQuery,
      retryFailed: req.data.retryFailed,
      forceReindex: req.data.forceReindex
    })
    return validateDocSemanticProgressOut(docSemanticCoordinator.getProgress())
  })

  handle(IPC_CHANNELS.DOC_SEMANTIC_INDEX_PAUSE, async () => {
    if (!docSemanticCoordinator) {
      throw new Error('Document semantic coordinator is not initialized')
    }
    const progress = await docSemanticCoordinator.pauseIndexing()
    return validateDocSemanticProgressOut(progress)
  })

  handle(IPC_CHANNELS.DOC_SEMANTIC_INDEX_RESUME, async () => {
    if (!docSemanticCoordinator) {
      throw new Error('Document semantic coordinator is not initialized')
    }
    await docSemanticCoordinator.resumeIndexing()
    return validateDocSemanticProgressOut(docSemanticCoordinator.getProgress())
  })

  handle(IPC_CHANNELS.DOC_SEMANTIC_INDEX_CANCEL, async () => {
    if (!docSemanticCoordinator) {
      throw new Error('Document semantic coordinator is not initialized')
    }
    const progress = await docSemanticCoordinator.cancelIndexing()
    return validateDocSemanticProgressOut(progress)
  })

  handle(IPC_CHANNELS.DOC_SEMANTIC_INDEX_GET_PROGRESS, async () => {
    if (!docSemanticCoordinator) {
      throw new Error('Document semantic coordinator is not initialized')
    }
    await docSemanticCoordinator.refreshCoverage()
    return validateDocSemanticProgressOut(docSemanticCoordinator.getProgress())
  })

  handle(IPC_CHANNELS.DOC_SEMANTIC_SEARCH, async (rawRequest: unknown) => {
    const req = validatePayload(DocSemanticSearchRequestSchema, rawRequest)
    if (!req.success) {
      throw new Error(`Invalid doc-semantic:search request: ${req.error}`)
    }
    if (!docSearchCoordinator) {
      throw new Error('Document search coordinator is not initialized')
    }
    const rawResp = unifiedSearchCoordinator
      ? await unifiedSearchCoordinator.searchDocumentsFromTab(req.data)
      : await docSearchCoordinator.search(req.data)
    const res = validatePayload(DocSemanticSearchResponseSchema, rawResp)
    if (!res.success) {
      throw new Error(`Invalid doc-semantic:search response: ${res.error}`)
    }
    return res.data
  })

  handle(IPC_CHANNELS.DOC_SEMANTIC_SEARCH_CANCEL, async (rawRequest?: unknown) => {
    const req = validatePayload(DocSemanticSearchCancelRequestSchema, rawRequest ?? {})
    if (!req.success) {
      throw new Error(`Invalid doc-semantic:search-cancel request: ${req.error}`)
    }
    if (!docSearchCoordinator) {
      throw new Error('Document search coordinator is not initialized')
    }
    const cancelResult = unifiedSearchCoordinator
      ? await unifiedSearchCoordinator.cancelDocumentsFromTab(req.data.ownerGen)
      : (await docSearchCoordinator.cancelSearch(), { cancelled: true })
    const res = validatePayload(DocSemanticSearchCancelResponseSchema, cancelResult)
    if (!res.success) {
      throw new Error(`Invalid doc-semantic:search-cancel response: ${res.error}`)
    }
    return res.data
  })

  // -------------------------------------------------------------------------
  // Stage 7E: Document Classification & Override Handlers
  // -------------------------------------------------------------------------

  handle(IPC_CHANNELS.DOCUMENTS_CLASSIFY_SELECTED, async (rawRequest: unknown) => {
    const req = validatePayload(ClassifySelectedDocumentsRequestSchema, rawRequest)
    if (!req.success) {
      throw new Error(`Invalid documents:classify-selected request: ${req.error}`)
    }
    if (!documentClassificationCoordinator) {
      throw new Error('Document classification coordinator is not initialized')
    }
    await documentClassificationCoordinator.classifySelected(
      req.data.fileLocationIds,
      req.data.forceReclassify ?? false
    )
    return validateDocClassificationProgressOut(documentClassificationCoordinator.getProgress())
  })

  handle(IPC_CHANNELS.DOCUMENTS_CLASSIFY_START, async (rawRequest: unknown) => {
    const req = validatePayload(StartDocumentClassificationRequestSchema, rawRequest ?? {})
    if (!req.success) {
      throw new Error(`Invalid documents:classify-start request: ${req.error}`)
    }
    if (!documentClassificationCoordinator) {
      throw new Error('Document classification coordinator is not initialized')
    }
    await documentClassificationCoordinator.startClassification({
      scopeKind: req.data.scope,
      extensionFilter: req.data.extensionFilter,
      filenameQuery: req.data.filenameQuery,
      forceReclassify: req.data.forceReclassify
    })
    return validateDocClassificationProgressOut(documentClassificationCoordinator.getProgress())
  })

  handle(IPC_CHANNELS.DOCUMENTS_CLASSIFY_PAUSE, async () => {
    if (!documentClassificationCoordinator) {
      throw new Error('Document classification coordinator is not initialized')
    }
    await documentClassificationCoordinator.pause()
    return validateDocClassificationProgressOut(documentClassificationCoordinator.getProgress())
  })

  handle(IPC_CHANNELS.DOCUMENTS_CLASSIFY_RESUME, async () => {
    if (!documentClassificationCoordinator) {
      throw new Error('Document classification coordinator is not initialized')
    }
    await documentClassificationCoordinator.resume()
    return validateDocClassificationProgressOut(documentClassificationCoordinator.getProgress())
  })

  handle(IPC_CHANNELS.DOCUMENTS_CLASSIFY_CANCEL, async () => {
    if (!documentClassificationCoordinator) {
      throw new Error('Document classification coordinator is not initialized')
    }
    await documentClassificationCoordinator.cancel()
    return validateDocClassificationProgressOut(documentClassificationCoordinator.getProgress())
  })

  handle(IPC_CHANNELS.DOCUMENTS_CLASSIFY_GET_PROGRESS, async () => {
    if (!documentClassificationCoordinator) {
      throw new Error('Document classification coordinator is not initialized')
    }
    await documentClassificationCoordinator.getCoverage()
    return validateDocClassificationProgressOut(documentClassificationCoordinator.getProgress())
  })

  handle(IPC_CHANNELS.DOCUMENTS_CLASSIFY_PROGRESS_EVENT, (): never => {
    throw new Error('Event-only channel cannot be invoked')
  })

  if (documentClassificationCoordinator && getMainWindow) {
    documentClassificationCoordinator.onProgress((progress) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        const res = validatePayload(DocumentClassificationProgressSchema, progress)
        if (res.success) {
          win.webContents.send(IPC_CHANNELS.DOCUMENTS_CLASSIFY_PROGRESS_EVENT, res.data)
        }
      }
    })
  }

  const handleOverrideMutation = (
    fileLocationId: number,
    runMutation: () => { persistencePending?: boolean; persistenceError?: string }
  ) => {
    if (!catalog) {
      throw new Error('Catalog database is not initialized')
    }
    const repo = catalog.getDocumentClassificationRepository()
    try {
      const result = runMutation()
      const eff = repo.getEffectiveDocumentClassification(fileLocationId)
      const ack = validatePayload(DocumentClassificationOverrideAckSchema, {
        ok: true,
        persistencePending: Boolean(result.persistencePending),
        ...(result.persistenceError ? { persistenceError: result.persistenceError } : {}),
        effectiveClassification: eff ? repo.toEffectiveClassificationSummary(eff, true) : null
      })
      if (!ack.success) {
        throw new Error(`Invalid classification override ack response: ${ack.error}`)
      }
      return ack.data
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const conflict = msg.includes('STALE_OVERRIDE_VERSION')
        ? ('STALE_OVERRIDE_VERSION' as const)
        : msg.includes('STALE_REVISION')
          ? ('STALE_REVISION' as const)
          : msg.includes('NOT_FOUND')
            ? ('NOT_FOUND' as const)
            : undefined
      if (!conflict) {
        throw err
      }
      const eff = repo.getEffectiveDocumentClassification(fileLocationId)
      const ack = validatePayload(DocumentClassificationOverrideAckSchema, {
        ok: false,
        conflict,
        errorMessage: msg,
        persistencePending: false,
        effectiveClassification: eff ? repo.toEffectiveClassificationSummary(eff, true) : null
      })
      if (!ack.success) {
        throw new Error(`Invalid classification override conflict ack response: ${ack.error}`, {
          cause: err
        })
      }
      return ack.data
    }
  }

  handle(IPC_CHANNELS.DOCUMENTS_SET_CLASSIFICATION_OVERRIDE, (rawRequest: unknown) => {
    const req = validatePayload(SetDocumentClassificationOverrideRequestSchema, rawRequest)
    if (!req.success) {
      throw new Error(`Invalid documents:set-classification-override request: ${req.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog database is not initialized')
    }
    const repo = catalog.getDocumentClassificationRepository()
    return handleOverrideMutation(req.data.fileLocationId, () =>
      repo.setClassificationOverride(req.data)
    )
  })

  handle(IPC_CHANNELS.DOCUMENTS_RESET_CLASSIFICATION_OVERRIDE, (rawRequest: unknown) => {
    const req = validatePayload(ResetDocumentClassificationOverrideRequestSchema, rawRequest)
    if (!req.success) {
      throw new Error(`Invalid documents:reset-classification-override request: ${req.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog database is not initialized')
    }
    const repo = catalog.getDocumentClassificationRepository()
    return handleOverrideMutation(req.data.fileLocationId, () =>
      repo.resetClassificationOverride(req.data)
    )
  })

  handle(IPC_CHANNELS.DOCUMENTS_GET_CLASSIFICATION_FACETS, (rawRequest: unknown) => {
    const req = validatePayload(GetDocumentClassificationFacetsRequestSchema, rawRequest ?? {})
    if (!req.success) {
      throw new Error(`Invalid documents:get-classification-facets request: ${req.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog database is not initialized')
    }
    const facets = catalog.getDocumentClassificationRepository().getClassificationFacets(req.data)
    const res = validatePayload(GetDocumentClassificationFacetsResponseSchema, facets)
    if (!res.success) {
      throw new Error(`Invalid documents:get-classification-facets response: ${res.error}`)
    }
    return res.data
  })
}
