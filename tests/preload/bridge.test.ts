// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  invoke: vi.fn(),
  exposed: {} as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (
      name: string,
      api: Record<string, (...args: unknown[]) => Promise<unknown>>
    ) => {
      electron.exposed[name] = api
    }
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))

async function loadApi() {
  vi.resetModules()
  await import('../../src/preload/index')
  const api = electron.exposed['api']
  if (!api) throw new Error('window.api was not exposed')
  return api
}

beforeEach(() => {
  electron.invoke.mockReset()
  for (const key of Object.keys(electron.exposed)) delete electron.exposed[key]
})

describe('preload bridge', () => {
  it('exposes only the narrow typed methods', async () => {
    const api = await loadApi()
    expect(Object.keys(api).sort()).toEqual(
      [
        'getAppInfo',
        'getVaultStatus',
        'setTab',
        'selectRoots',
        'startScan',
        'pauseScan',
        'resumeScan',
        'cancelScan',
        'dismissScanJob',
        'getActiveScanJob',
        'getLatestScanJob',
        'onScanProgress',
        'getDuplicateGroups',
        'getDuplicateGroupMembers',
        'setDuplicateReview',
        'selectVaultDirectory',
        'initializeVault',
        'getActiveVault',
        'setActiveVault',
        'getImportCandidates',
        'startImport',
        'pauseImport',
        'resumeImport',
        'cancelImport',
        'getActiveImportJob',
        'getLatestImportJob',
        'onImportProgress',
        'getPhotosPage',
        'getThumbnail',
        'getOriginalPhoto',
        'prepareVideoPlayback',
        'revokeVideoPlaybackToken',
        'openMediaInDefaultPlayer',
        'onMediaLibraryUpdated',
        'cancelThumbnail',
        'getPhotosDiagnostics',
        'getThumbnailPrepProgress',
        'onThumbnailPrepProgress',
        'setPhotoAnnotation',
        'getPhotoAnnotation',
        'listCollections',
        'createCollection',
        'renameCollection',
        'addCollectionMember',
        'removeCollectionMember',
        'getPhotoMemberships',
        'reconcileJournal',
        'startSimilarityAnalysis',
        'cancelSimilarityAnalysis',
        'resumeSimilarityAnalysis',
        'getSimilarityProgress',
        'getSimilarityPairs',
        'setSimilarityDecision',
        'reconcileSimilarity',
        'getSemanticModelStatus',
        'downloadSemanticModel',
        'importSemanticModelFromFolder',
        'cancelSemanticModelProvisioning',
        'onSemanticModelStatus',
        'startSemanticIndexing',
        'pauseSemanticIndexing',
        'resumeSemanticIndexing',
        'cancelSemanticIndexing',
        'getSemanticIndexProgress',
        'getSemanticIndexJobItems',
        'onSemanticIndexProgress',
        'getPhotoMetadataProgress',
        'startPhotoMetadataExtraction',
        'pausePhotoMetadataExtraction',
        'resumePhotoMetadataExtraction',
        'cancelPhotoMetadataExtraction',
        'onPhotoMetadataProgress',
        'getPhotoMetadataAttentionItems',
        'getPhotoMetadataDetail',
        'getPhotoMetadataFacets',
        'searchPhotosSemantic',
        'cancelPhotosSemanticSearch',
        'searchPhotosMetadataAware',
        'listSavedEvents',
        'upsertSavedEvent',
        'deleteSavedEvent',
        'listSavedPlaces',
        'upsertSavedPlace',
        'deleteSavedPlace',
        'setPhotoUserPlace',
        'clearPhotoUserPlace',
        'listCameraLabels',
        'upsertCameraLabel',
        'deleteCameraLabel',
        'getDocumentsPage',
        'getDocumentDetail',
        'getDocumentExtensionFacets',
        'getDocumentPreview',
        'extractSelectedDocuments',
        'startDocumentExtraction',
        'pauseDocumentExtraction',
        'resumeDocumentExtraction',
        'cancelDocumentExtraction',
        'getDocumentExtractionProgress',
        'onDocumentExtractionProgress',
        'getOcrModelStatus',
        'downloadOcrModel',
        'importOcrModel',
        'cancelOcrModel',
        'onOcrModelStatus',
        'getDocumentOcrState',
        'getDocumentOcrPreview',
        'ocrSelectedDocuments',
        'startDocumentOcr',
        'pauseDocumentOcr',
        'resumeDocumentOcr',
        'cancelDocumentOcr',
        'getDocumentOcrProgress',
        'onDocumentOcrProgress',
        'getDocSemanticModelStatus',
        'downloadDocSemanticModel',
        'importDocSemanticModel',
        'cancelDocSemanticModel',
        'indexSelectedDocuments',
        'startDocumentSemanticIndexing',
        'pauseDocumentSemanticIndexing',
        'resumeDocumentSemanticIndexing',
        'cancelDocumentSemanticIndexing',
        'getDocumentSemanticProgress',
        'searchDocumentsSemantic',
        'cancelDocumentSemanticSearch',
        'classifySelectedDocuments',
        'startDocumentClassification',
        'pauseDocumentClassification',
        'resumeDocumentClassification',
        'cancelDocumentClassification',
        'getDocumentClassificationProgress',
        'onDocumentClassificationProgress',
        'setDocumentClassificationOverride',
        'resetDocumentClassificationOverride',
        'getDocumentClassificationFacets',
        'searchUnifiedPhotos',
        'searchUnifiedDocuments',
        'cancelUnifiedSearch',
        'selectExportDestination',
        'startExport',
        'cancelExport',
        'getActiveExportJob',
        'listExportJobs',
        'getExportJob',
        'getExportJobItems',
        'verifyExportJob',
        'onExportProgress',
        'selectBackupDirectory',
        'configureBackupDestination',
        'listBackupDestinations',
        'startBackup',
        'pauseBackup',
        'resumeBackup',
        'cancelBackup',
        'getActiveBackupJob',
        'getBackupSummary',
        'listBackupJobs',
        'getBackupJob',
        'listRecoveryPoints',
        'verifyRecoveryPoint',
        'restoreRecoveryPoint',
        'recoverCatalogFromVault',
        'getGoogleDriveAuthStatus',
        'connectGoogleDrive',
        'disconnectGoogleDrive',
        'listGoogleDriveFolders',
        'createGoogleDriveFolder',
        'onBackupProgress',
        'getUpdateState',
        'checkForUpdates',
        'installUpdateNow',
        'deferUpdate',
        'dismissUpdateError',
        'onUpdateState'
      ].sort()
    )
  })

  it('returns validated responses', async () => {
    electron.invoke.mockResolvedValueOnce({ sourceCount: 0, itemCount: 0, isReady: true })
    const api = await loadApi()
    await expect(api.getVaultStatus!()).resolves.toEqual({
      sourceCount: 0,
      itemCount: 0,
      isReady: true
    })
  })

  it('rejects a malformed application info response', async () => {
    electron.invoke.mockResolvedValueOnce({ name: 'Personal Vault' })
    const api = await loadApi()
    await expect(api.getAppInfo!()).rejects.toThrow(/invalid/i)
  })

  it('validates the document semantic search cancellation acknowledgement', async () => {
    electron.invoke.mockResolvedValueOnce({ cancelled: true })
    const api = await loadApi()
    await expect(api.cancelDocumentSemanticSearch!()).resolves.toEqual({ cancelled: true })
    expect(electron.invoke).toHaveBeenCalledWith('doc-semantic:search-cancel')
  })

  it.each([
    ['a string flag', { cancelled: 'yes' }],
    ['a missing flag', {}],
    ['undefined', undefined],
    ['a bare boolean', true]
  ])(
    'rejects a document semantic search cancellation acknowledgement with %s',
    async (_label, response) => {
      electron.invoke.mockResolvedValueOnce(response)
      const api = await loadApi()
      await expect(api.cancelDocumentSemanticSearch!()).rejects.toThrow(/invalid/i)
    }
  )

  it('validates Stage 7E classification override requests and acknowledgements in preload', async () => {
    const api = await loadApi()

    await expect(
      api.setDocumentClassificationOverride!({
        fileLocationId: -1,
        expectedRevision: 'rev',
        expectedOverrideVersion: 0,
        purposeLabels: null,
        originLabels: null,
        clutterOverride: 'force_keep'
      })
    ).rejects.toThrow(/invalid/i)

    electron.invoke.mockResolvedValueOnce({
      ok: true,
      persistencePending: true,
      persistenceError: 'DISK_FULL',
      effectiveClassification: null
    })
    await expect(
      api.setDocumentClassificationOverride!({
        fileLocationId: 1,
        expectedRevision: 'rev-1',
        expectedOverrideVersion: 0,
        purposeLabels: ['legal'],
        originLabels: ['personal'],
        clutterOverride: 'force_keep'
      })
    ).resolves.toMatchObject({
      ok: true,
      persistencePending: true,
      persistenceError: 'DISK_FULL'
    })
    expect(electron.invoke).toHaveBeenCalledWith('documents:set-classification-override', {
      fileLocationId: 1,
      expectedRevision: 'rev-1',
      expectedOverrideVersion: 0,
      purposeLabels: ['legal'],
      originLabels: ['personal'],
      clutterOverride: 'force_keep'
    })

    electron.invoke.mockResolvedValueOnce({ bad: 'ack' })
    await expect(
      api.resetDocumentClassificationOverride!({
        fileLocationId: 1,
        expectedRevision: 'rev-1',
        expectedOverrideVersion: 1
      })
    ).rejects.toThrow(/invalid/i)
  })

  it('returns the setTab acknowledgement when it is a boolean', async () => {
    electron.invoke.mockResolvedValueOnce(true)
    const api = await loadApi()
    await expect(api.setTab!('photos')).resolves.toBe(true)
    expect(electron.invoke).toHaveBeenCalledWith('navigation:set-tab', 'photos')
  })

  it.each([
    ['a string', 'yes'],
    ['undefined', undefined],
    ['an object', { accepted: true }]
  ])('rejects a setTab acknowledgement that is %s', async (_label, response) => {
    electron.invoke.mockResolvedValueOnce(response)
    const api = await loadApi()
    await expect(api.setTab!('photos')).rejects.toThrow(/invalid/i)
  })

  it('rejects an unknown tab without calling the main process', async () => {
    const api = await loadApi()
    await expect(
      api.setTab!(
        'settings' as unknown as import('../../src/shared/validation/ipc-schemas.js').NavigationTab
      )
    ).rejects.toThrow(/invalid/i)
    expect(electron.invoke).not.toHaveBeenCalled()
  })

  it('validates startScan requests and responses', async () => {
    electron.invoke.mockResolvedValueOnce({ success: true })
    const api = await loadApi()

    // Invalid request: empty roots
    await expect(api.startScan!({ roots: [] })).rejects.toThrow(/invalid/i)
    expect(electron.invoke).not.toHaveBeenCalled()

    // Valid request
    await expect(api.startScan!({ roots: ['D:/photos'] })).resolves.toEqual({ success: true })
    expect(electron.invoke).toHaveBeenCalledWith('scan:start-job', { roots: ['D:/photos'] })
  })

  it('validates selectRoots response', async () => {
    electron.invoke.mockResolvedValueOnce({ cancelled: false, rootPaths: ['D:/photos'] })
    const api = await loadApi()
    await expect(api.selectRoots!()).resolves.toEqual({
      cancelled: false,
      rootPaths: ['D:/photos']
    })
  })

  it('validates searchPhotosSemantic requests and responses', async () => {
    const validResponse = {
      items: [],
      totalMatched: 0,
      eligibleCount: 0,
      unindexedCount: 0,
      staleCount: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      queryLatencyMs: 12.5,
      truncated: false,
      tokenCount: 4,
      modelStatus: 'ready'
    }
    electron.invoke.mockResolvedValueOnce(validResponse)
    const api = await loadApi()

    // Invalid request: empty queryText
    await expect(api.searchPhotosSemantic!({ queryText: '' })).rejects.toThrow(/invalid/i)
    expect(electron.invoke).not.toHaveBeenCalled()

    // Valid request
    await expect(
      api.searchPhotosSemantic!({ queryText: 'sunset over lake' })
    ).resolves.toMatchObject({
      totalMatched: 0,
      modelStatus: 'ready'
    })
    expect(electron.invoke).toHaveBeenCalledWith(
      'semantic:search-photos',
      expect.objectContaining({
        queryText: 'sunset over lake'
      })
    )
  })

  it('validates cancelPhotosSemanticSearch requests and responses', async () => {
    electron.invoke.mockResolvedValueOnce({ cancelled: true })
    const api = await loadApi()

    await expect(api.cancelPhotosSemanticSearch!()).resolves.toEqual({ cancelled: true })
    expect(electron.invoke).toHaveBeenCalledWith('semantic:search-cancel', {})
  })

  it('validates Stage 7C OCR requests and responses across preload', async () => {
    const validModelStatus = {
      state: 'missing',
      modelId: 'tesseract-ocr/tessdata_fast:eng@65727574',
      modelCommit: '65727574dfcd264acbb0c3e07860e4e9e9b22185',
      modelManifestSha256: 'a'.repeat(64),
      language: 'eng',
      enginePackage: 'tesseract.js-core@7.0.0',
      requiredBytes: 4_113_088,
      downloadedBytes: 0,
      currentArtifact: null,
      verifiedAtMs: null,
      error: null,
      lastReplacementError: null
    }
    const validOcrProgress = {
      jobId: null,
      status: 'idle',
      scopeKind: null,
      recipeVersion: 'doc_ocr_v1',
      ocrModelId: 'tesseract-ocr/tessdata_fast:eng@65727574',
      ocrModelManifestSha256: 'a'.repeat(64),
      ocrLanguage: 'eng',
      totalItems: 0,
      processedItems: 0,
      extractedItems: 0,
      noTextItems: 0,
      passwordProtectedItems: 0,
      unsupportedItems: 0,
      failedItems: 0,
      truncatedItems: 0,
      reusedItems: 0,
      skippedStaleItems: 0,
      pendingItems: 0,
      activeFileLocationId: null,
      startedAtMs: null,
      updatedAtMs: null,
      completedAtMs: null,
      lastError: null,
      coverage: {
        totalDocuments: 0,
        ocrNeededDocuments: 0,
        notProcessedDocuments: 0,
        extractedDocuments: 0,
        noTextDocuments: 0,
        passwordProtectedDocuments: 0,
        unsupportedDocuments: 0,
        failedDocuments: 0,
        truncatedDocuments: 0,
        staleDocuments: 0,
        selectedImageOcrCount: 0
      },
      coverageReady: true,
      coverageRefreshing: false
    }

    const api = await loadApi()

    // Invalid empty selection is rejected before IPC
    await expect(api.ocrSelectedDocuments!({ fileLocationIds: [] })).rejects.toThrow(/invalid/i)
    expect(electron.invoke).not.toHaveBeenCalled()

    electron.invoke.mockResolvedValueOnce(validModelStatus)
    await expect(api.getOcrModelStatus!()).resolves.toMatchObject({ state: 'missing' })

    electron.invoke.mockResolvedValueOnce({ preview: null })
    await expect(api.getDocumentOcrPreview!({ fileLocationId: 42 })).resolves.toEqual({
      preview: null
    })

    electron.invoke.mockResolvedValueOnce(validOcrProgress)
    await expect(api.startDocumentOcr!({ scope: 'ocr_needed' })).resolves.toMatchObject({
      status: 'idle',
      coverageReady: true
    })

    electron.invoke.mockResolvedValueOnce({ bad: true })
    await expect(api.getDocumentOcrProgress!()).rejects.toThrow(/invalid/i)
  })

  it('validates Stage 7F Slice 1 unified search and cancellation requests and responses in preload', async () => {
    const api = await loadApi()

    // Reject invalid unified requests before IPC
    await expect(
      api.searchUnifiedPhotos!({ query: '   ', ownerSurface: 'unified', ownerGen: 1 })
    ).rejects.toThrow(/invalid/i)
    await expect(
      api.searchUnifiedDocuments!({ query: 'ok', ownerSurface: 'unified', ownerGen: -1 })
    ).rejects.toThrow(/invalid/i)
    await expect(
      api.cancelUnifiedSearch!({ ownerSurface: 'unified', ownerGen: 1, modality: 'invalid' })
    ).rejects.toThrow(/invalid/i)
    expect(electron.invoke).not.toHaveBeenCalled()

    // Valid unified photos round-trip (applies limit=20, offset=0 defaults)
    electron.invoke.mockResolvedValueOnce({
      status: 'unprovisioned',
      modelId: 'Xenova/clip-vit-base-patch32',
      result: null,
      errorMessage: null
    })
    await expect(
      api.searchUnifiedPhotos!({ query: '  sunset  ', ownerSurface: 'unified', ownerGen: 1 })
    ).resolves.toMatchObject({ status: 'unprovisioned' })
    expect(electron.invoke).toHaveBeenCalledWith('unified:search-photos', {
      query: 'sunset',
      ownerSurface: 'unified',
      ownerGen: 1,
      offset: 0,
      limit: 20
    })

    // Valid unified documents round-trip
    electron.invoke.mockResolvedValueOnce({
      status: 'unprovisioned',
      modelId: 'Xenova/bge-small-en-v1.5',
      result: null,
      errorMessage: null
    })
    await expect(
      api.searchUnifiedDocuments!({ query: '  receipt  ', ownerSurface: 'unified', ownerGen: 2 })
    ).resolves.toMatchObject({ status: 'unprovisioned' })
    expect(electron.invoke).toHaveBeenCalledWith('unified:search-documents', {
      query: 'receipt',
      ownerSurface: 'unified',
      ownerGen: 2,
      offset: 0,
      limit: 20
    })

    // Valid unified cancel round-trip
    electron.invoke.mockResolvedValueOnce({ cancelled: true })
    await expect(
      api.cancelUnifiedSearch!({ ownerSurface: 'unified', ownerGen: 2 })
    ).resolves.toEqual({ cancelled: true })
    expect(electron.invoke).toHaveBeenCalledWith('unified:search-cancel', {
      ownerSurface: 'unified',
      ownerGen: 2,
      modality: 'all'
    })

    // Reject malformed response payloads from main
    electron.invoke.mockResolvedValueOnce({
      status: 'ready',
      modelId: 'wrong-model',
      result: null,
      errorMessage: null
    })
    await expect(
      api.searchUnifiedPhotos!({ query: 'sunset', ownerSurface: 'unified', ownerGen: 3 })
    ).rejects.toThrow(/invalid/i)
  })

  it('validates updater state and action responses in preload', async () => {
    const validState = {
      phase: 'available' as const,
      configured: true,
      currentVersion: '0.1.0',
      availableVersion: '0.1.1',
      releaseDate: '2026-11-22T00:00:00.000Z',
      downloadProgress: null,
      activeJobs: { vaultImportActive: false, backupActive: false },
      errorMessage: null,
      failedStage: null,
      lastCheckedAtMs: 123456
    }

    const api = await loadApi()

    electron.invoke.mockResolvedValueOnce(validState)
    await expect(api.getUpdateState!()).resolves.toEqual(validState)
    expect(electron.invoke).toHaveBeenCalledWith('update:get-state')

    electron.invoke.mockResolvedValueOnce({
      accepted: true,
      state: { ...validState, phase: 'deferred' }
    })
    await expect(api.deferUpdate!()).resolves.toMatchObject({
      accepted: true,
      state: { phase: 'deferred', availableVersion: '0.1.1' }
    })
    expect(electron.invoke).toHaveBeenCalledWith('update:defer')

    electron.invoke.mockResolvedValueOnce({ accepted: true, state: { phase: 'bogus' } })
    await expect(api.installUpdateNow!()).rejects.toThrow(/invalid/i)
  })

  it('validates getBackupSummary responses in preload', async () => {
    const validSummary = {
      hasActiveVault: true,
      activeVaultId: 'vault-1',
      activeVaultName: 'Test Vault',
      activeVaultPath: 'D:\\Vault',
      vaultFileCount: 3,
      vaultBytes: 10240,
      catalogBytes: 4096,
      annotationsBytes: 512,
      estimatedTotalBytes: 14848,
      catalogedFileCount: 4,
      isCatalogOnly: false
    }
    const api = await loadApi()

    electron.invoke.mockResolvedValueOnce(validSummary)
    await expect(api.getBackupSummary!()).resolves.toEqual(validSummary)
    expect(electron.invoke).toHaveBeenCalledWith('backup:get-summary')

    electron.invoke.mockResolvedValueOnce({ invalid: true })
    await expect(api.getBackupSummary!()).rejects.toThrow(/invalid/i)
  })
})
