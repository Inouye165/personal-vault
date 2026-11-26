import { app, BrowserWindow, safeStorage } from 'electron'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc/handlers'
import { createSenderValidator } from './ipc/sender'
import { resolveAppLocation, secureWebContents } from './navigation'
import { setupSecurityPolicies } from './security'
import { CatalogDatabase } from './services/catalog'
import { ScanJobCoordinator } from './services/jobs'
import { VaultImportCoordinator } from './services/vault'
import { ThumbnailCoordinator } from './services/thumbnails'
import { SimilarityCoordinator } from './services/similarity'
import { AnnotationJournal } from './services/annotations'
import {
  SemanticModelManager,
  SemanticIndexCoordinator,
  SemanticSearchCoordinator,
  APPROVED_DOWNLOAD_HOSTS
} from './services/semantic'
import {
  attachAutoMetadataExtractionScheduler,
  PhotoMetadataCoordinator
} from './services/metadata'
import { DocumentExtractionCoordinator } from './services/documents'
import { DocumentClassificationCoordinator } from './services/documents/classification/coordinator'
import {
  APPROVED_OCR_DOWNLOAD_HOSTS,
  DocumentOcrCoordinator,
  OcrModelManager
} from './services/documents/ocr'
import {
  APPROVED_DOC_SEMANTIC_DOWNLOAD_HOSTS,
  DocSemanticModelManager,
  DocumentSearchCoordinator,
  DocumentSemanticCoordinator
} from './services/documents/semantic'
import { UnifiedSearchCoordinator } from './services/unified-search'
import { PhotoSearchCoordinator } from './services/search'
import { ExportCoordinator } from './services/export'
import { BackupCoordinator } from './services/backup/coordinator'
import { GoogleDriveAuthService } from './services/backup/google-drive-auth'
import { RestoreIncompleteError } from './services/backup/errors'
import { inspectRestoredProfileStatus } from './services/backup/restore'
import { withProfileStartupCoordination } from './services/backup/catalog-recovery'
import { createElectronUpdaterAdapter, UpdateCoordinator } from './services/updater'
import { AppWorkerBudget } from './services/worker-budget'

function logStartup(message: string): void {
  try {
    const logPath = join(app.getPath('userData'), 'startup.log')
    appendFileSync(
      logPath,
      `[${new Date().toISOString()}] [PID:${process.pid}] ${message}\n`,
      'utf8'
    )
  } catch {
    // Ignore logging failure
  }
}

logStartup(
  `Process start: version=${app.getVersion()}, isPackaged=${app.isPackaged}, execPath=${process.execPath}, argv=${JSON.stringify(process.argv)}`
)

const documentPath = join(__dirname, '../renderer/index.html')

// The development URL is honoured only for unpackaged runs; see resolveAppLocation.
const location = resolveAppLocation({
  isPackaged: app.isPackaged,
  rendererUrl: process.env['ELECTRON_RENDERER_URL'],
  documentPath
})

logStartup(`Location resolved: kind=${location.kind}, details=${JSON.stringify(location)}`)

let mainWindow: BrowserWindow | null = null
let catalog: CatalogDatabase | null = null
let coordinator: ScanJobCoordinator | null = null
let vaultCoordinator: VaultImportCoordinator | null = null
let thumbnailCoordinator: ThumbnailCoordinator | null = null
let similarityCoordinator: SimilarityCoordinator | null = null
let semanticModelManager: SemanticModelManager | null = null
let semanticIndexCoordinator: SemanticIndexCoordinator | null = null
let semanticSearchCoordinator: SemanticSearchCoordinator | null = null
let photoMetadataCoordinator: PhotoMetadataCoordinator | null = null
let disposeAutoMetadataScheduler: (() => void) | null = null
let documentExtractionCoordinator: DocumentExtractionCoordinator | null = null
let ocrModelManager: OcrModelManager | null = null
let documentOcrCoordinator: DocumentOcrCoordinator | null = null
let docSemanticModelManager: DocSemanticModelManager | null = null
let docSemanticCoordinator: DocumentSemanticCoordinator | null = null
let docSearchCoordinator: DocumentSearchCoordinator | null = null
let unifiedSearchCoordinator: UnifiedSearchCoordinator | null = null
let photoSearchCoordinator: PhotoSearchCoordinator | null = null
let documentClassificationCoordinator: DocumentClassificationCoordinator | null = null
let exportCoordinator: ExportCoordinator | null = null
let backupCoordinator: BackupCoordinator | null = null
let updateCoordinator: UpdateCoordinator | null = null

function createWindow(): BrowserWindow {
  logStartup('createWindow: initializing BrowserWindow')
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 360,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: 'Personal Vault',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged
    }
  })

  secureWebContents(window.webContents, location)

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logStartup(
      `webContents did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`
    )
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    logStartup(
      `webContents render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`
    )
  })

  window.on('ready-to-show', () => {
    logStartup('window ready-to-show fired -> calling show() and focus()')
    window.show()
    window.focus()
  })

  // Fallback to ensure the desktop window is visibly displayed and focused
  setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) {
      logStartup('window fallback timeout: window not visible, calling show() and focus()')
      window.show()
      window.focus()
    }
  }, 1000)

  window.on('show', () => {
    logStartup(
      `window show event: isVisible=${window.isVisible()} isMinimized=${window.isMinimized()}`
    )
  })

  window.on('closed', () => {
    logStartup('window closed event fired')
    if (mainWindow === window) mainWindow = null
  })

  if (location.kind === 'dev') {
    logStartup(`Loading dev URL: ${location.origin}`)
    void window.loadURL(location.origin)
  } else {
    logStartup(`Loading file: ${location.documentPath}`)
    void window.loadFile(location.documentPath)
  }

  mainWindow = window
  return window
}

// Ensure a single instance of Personal Vault per user-data directory.
if (!app.requestSingleInstanceLock()) {
  logStartup('Failed to acquire single instance lock -> calling app.quit()')
  app.quit()
} else {
  logStartup('Acquired single instance lock successfully')
  let isQuitting = false
  let shutdownPromise: Promise<void> | null = null

  const shutdownServicesForQuit = async (options?: {
    skipUpdaterShutdown?: boolean
  }): Promise<void> => {
    if (shutdownPromise) {
      await shutdownPromise
      return
    }
    shutdownPromise = (async () => {
      try {
        if (updateCoordinator && !options?.skipUpdaterShutdown) {
          logStartup('shutting down update coordinator')
          updateCoordinator.shutdown()
          logStartup('update coordinator shutdown done')
        }
        if (coordinator) {
          logStartup('shutting down coordinator')
          await coordinator.shutdown()
          logStartup('coordinator shutdown done')
        }
        if (vaultCoordinator) {
          logStartup('shutting down vault coordinator')
          await vaultCoordinator.shutdown()
          logStartup('vault coordinator shutdown done')
        }
        if (disposeAutoMetadataScheduler) {
          disposeAutoMetadataScheduler()
          disposeAutoMetadataScheduler = null
        }
        if (photoMetadataCoordinator) {
          logStartup('shutting down photo metadata coordinator')
          await photoMetadataCoordinator.shutdown()
          logStartup('photo metadata coordinator shutdown done')
        }
        if (semanticIndexCoordinator) {
          logStartup('shutting down semantic index coordinator')
          await semanticIndexCoordinator.shutdown()
          logStartup('semantic index coordinator shutdown done')
        }
        if (unifiedSearchCoordinator) {
          logStartup('shutting down unified search coordinator')
          await unifiedSearchCoordinator.shutdown()
          logStartup('unified search coordinator shutdown done')
        }
        if (semanticSearchCoordinator) {
          logStartup('shutting down semantic search coordinator')
          await semanticSearchCoordinator.shutdown()
          logStartup('semantic search coordinator shutdown done')
        }
        if (similarityCoordinator) {
          logStartup('shutting down similarity coordinator')
          await similarityCoordinator.shutdown()
          logStartup('similarity coordinator shutdown done')
        }
        if (thumbnailCoordinator) {
          logStartup('shutting down thumbnail coordinator')
          await thumbnailCoordinator.shutdown()
          logStartup('thumbnail coordinator shutdown done')
        }
        if (documentExtractionCoordinator) {
          logStartup('shutting down document extraction coordinator')
          await documentExtractionCoordinator.shutdown()
          logStartup('document extraction coordinator shutdown done')
        }
        if (documentOcrCoordinator) {
          logStartup('shutting down document OCR coordinator')
          await documentOcrCoordinator.shutdown()
          logStartup('document OCR coordinator shutdown done')
        }
        if (ocrModelManager) {
          logStartup('shutting down OCR model manager')
          await ocrModelManager.shutdown()
          logStartup('OCR model manager shutdown done')
        }
        if (docSearchCoordinator) {
          logStartup('shutting down doc search coordinator')
          await docSearchCoordinator.shutdown()
          logStartup('doc search coordinator shutdown done')
        }
        if (docSemanticCoordinator) {
          logStartup('shutting down doc semantic coordinator')
          await docSemanticCoordinator.shutdown()
          logStartup('doc semantic coordinator shutdown done')
        }
        if (documentClassificationCoordinator) {
          logStartup('shutting down document classification coordinator')
          await documentClassificationCoordinator.shutdown()
          logStartup('document classification coordinator shutdown done')
        }
        if (exportCoordinator) {
          logStartup('shutting down export coordinator')
          await exportCoordinator.shutdown()
          logStartup('export coordinator shutdown done')
        }
        if (backupCoordinator) {
          logStartup('shutting down backup coordinator')
          await backupCoordinator.shutdown()
          logStartup('backup coordinator shutdown done')
        }
      } finally {
        if (catalog && !catalog.isClosed()) {
          logStartup('closing catalog')
          catalog.close()
          logStartup('catalog closed')
        }
      }
    })()
    await shutdownPromise
  }

  app.on('second-instance', () => {
    logStartup('second-instance event received -> focusing existing window')
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app
    .whenReady()
    .then(async () => {
      logStartup('app.whenReady resolved')
      setupSecurityPolicies(location)
      logStartup('setupSecurityPolicies completed')

      const userDataDir = app.getPath('userData')
      const restoreStatus = inspectRestoredProfileStatus(userDataDir)
      if (restoreStatus.status === 'interrupted' || restoreStatus.status === 'corrupt') {
        throw new RestoreIncompleteError(
          `Refusing startup: restored profile at "${userDataDir}" is ${restoreStatus.status}${restoreStatus.reason ? ` (${restoreStatus.reason})` : ''}`
        )
      }
      const openedCatalog = await withProfileStartupCoordination(userDataDir, async () => {
        const catalogPath = join(userDataDir, 'vault-catalog.db')
        logStartup(`Opening catalog at ${catalogPath}`)
        const db = CatalogDatabase.open({ catalogPath })
        catalog = db
        logStartup('CatalogDatabase.open completed')

        const annotationsDir = join(app.getPath('userData'), 'annotations')
        const journal = new AnnotationJournal({
          storageDir: annotationsDir,
          sourceRoots: () => (catalog ? catalog.getAllSourceRoots() : []),
          vaultPath: () => (catalog ? (catalog.getActiveVault()?.vaultPath ?? null) : null)
        })
        await journal.initialize()
        logStartup('journal.initialize completed')

        db.setJournal(journal)
        logStartup('catalog.setJournal completed with startup reconciliation')
        return db
      })
      catalog = openedCatalog

      coordinator = new ScanJobCoordinator({ catalog })
      await coordinator.initialize()
      logStartup('coordinator.initialize completed')

      vaultCoordinator = new VaultImportCoordinator({ catalog })
      await vaultCoordinator.initialize()
      logStartup('vaultCoordinator.initialize completed')

      const appWorkerBudget = new AppWorkerBudget(3)
      let releasingExternalIdle = false
      const tryReleaseExternalIdleWorker = async (
        exclude?: 'semantic-search' | 'doc-search'
      ): Promise<boolean> => {
        if (releasingExternalIdle) return false
        releasingExternalIdle = true
        try {
          if ((await thumbnailCoordinator?.releaseOneIdleWorker()) ?? false) {
            return true
          }
          if (
            exclude !== 'semantic-search' &&
            ((await semanticSearchCoordinator?.releaseIdleWorker()) ?? false)
          ) {
            return true
          }
          if (
            exclude !== 'doc-search' &&
            ((await docSearchCoordinator?.releaseIdleWorker()) ?? false)
          ) {
            return true
          }
          return false
        } finally {
          releasingExternalIdle = false
        }
      }
      const cacheDir = join(app.getPath('userData'), 'thumbnails')
      thumbnailCoordinator = new ThumbnailCoordinator({
        cacheDir,
        approvedRoots: () => (catalog ? catalog.getAllSourceRoots() : []),
        vaultPath: () => (catalog ? (catalog.getActiveVault()?.vaultPath ?? null) : null),
        maxAppLiveWorkers: 3,
        workerBudget: appWorkerBudget
      })
      await thumbnailCoordinator.initialize()
      logStartup('thumbnailCoordinator initialized')

      similarityCoordinator = new SimilarityCoordinator({
        catalog,
        thumbnailCoordinator
      })
      await similarityCoordinator.initialize()
      logStartup('similarityCoordinator initialized')

      const modelsRootDir = join(app.getPath('userData'), 'semantic-models')
      const allowLoopbackForTests = process.env.PV_ALLOW_LOOPBACK_MODEL_URL === '1'
      const customDownloadBaseUrl =
        allowLoopbackForTests && process.env.PV_SEMANTIC_DOWNLOAD_BASE_URL
          ? process.env.PV_SEMANTIC_DOWNLOAD_BASE_URL
          : undefined
      const allowedHosts = allowLoopbackForTests
        ? [...APPROVED_DOWNLOAD_HOSTS, '127.0.0.1', 'localhost']
        : APPROVED_DOWNLOAD_HOSTS

      semanticModelManager = new SemanticModelManager({
        modelsRootDir,
        getApprovedRoots: () => (catalog ? catalog.getAllSourceRoots() : []),
        getVaultRoot: () => (catalog ? (catalog.getActiveVault()?.vaultPath ?? null) : null),
        baseDownloadUrl: customDownloadBaseUrl,
        allowedHosts,
        allowLoopbackHttpForTests: allowLoopbackForTests,
        verifyDirectoryOffMain: (dirPath, specs) =>
          thumbnailCoordinator!.verifyModelDirectory(dirPath, specs)
      })
      await semanticModelManager.initialize()
      logStartup('semanticModelManager initialized')

      semanticIndexCoordinator = new SemanticIndexCoordinator({
        catalog,
        modelManager: semanticModelManager,
        thumbnailCoordinator,
        shouldYieldToInteractiveSearch: () => semanticSearchCoordinator?.hasActiveSearch() ?? false
      })
      semanticIndexCoordinator.initialize()
      logStartup('semanticIndexCoordinator initialized')

      photoMetadataCoordinator = new PhotoMetadataCoordinator({
        catalog,
        thumbnailCoordinator
      })
      photoMetadataCoordinator.initialize()
      logStartup('photoMetadataCoordinator initialized')

      const attachedMetaScheduler = attachAutoMetadataExtractionScheduler({
        scanCoordinator: coordinator,
        photoMetadataCoordinator,
        isCatalogClosed: () => !catalog || catalog.isClosed(),
        isDisabled: () => process.env.PV_DISABLE_AUTO_METADATA === '1',
        log: logStartup
      })
      disposeAutoMetadataScheduler = attachedMetaScheduler.dispose

      semanticSearchCoordinator = new SemanticSearchCoordinator({
        catalog,
        modelManager: semanticModelManager,
        maxAppLiveWorkers: 3,
        workerBudget: appWorkerBudget,
        tryReleaseExternalIdleWorker: () => tryReleaseExternalIdleWorker('semantic-search')
      })
      logStartup('semanticSearchCoordinator initialized')

      documentExtractionCoordinator = new DocumentExtractionCoordinator({
        catalog,
        maxAppLiveWorkers: 3,
        workerBudget: appWorkerBudget,
        tryReleaseExternalIdleWorker: () => tryReleaseExternalIdleWorker()
      })
      documentExtractionCoordinator.initialize()
      logStartup('documentExtractionCoordinator initialized')

      const ocrModelsRootDir = join(app.getPath('userData'), 'models', 'ocr')
      const customOcrDownloadBaseUrl = process.env.PV_TEST_OCR_MODEL_BASE_URL
      const allowOcrLoopbackForTests =
        customOcrDownloadBaseUrl &&
        /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(customOcrDownloadBaseUrl)
          ? true
          : false
      const ocrAllowedHosts = allowOcrLoopbackForTests
        ? [...APPROVED_OCR_DOWNLOAD_HOSTS, '127.0.0.1', 'localhost']
        : APPROVED_OCR_DOWNLOAD_HOSTS

      ocrModelManager = new OcrModelManager({
        modelsRootDir: ocrModelsRootDir,
        getApprovedRoots: () => (catalog ? catalog.getAllSourceRoots() : []),
        getVaultRoot: () => (catalog ? (catalog.getActiveVault()?.vaultPath ?? null) : null),
        baseDownloadUrl: customOcrDownloadBaseUrl,
        allowedHosts: ocrAllowedHosts,
        allowLoopbackHttpForTests: allowOcrLoopbackForTests
      })
      await ocrModelManager.initialize()
      logStartup('ocrModelManager initialized')

      documentOcrCoordinator = new DocumentOcrCoordinator({
        catalog,
        modelManager: ocrModelManager,
        maxAppLiveWorkers: 3,
        workerBudget: appWorkerBudget,
        tryReleaseExternalIdleWorker: () => tryReleaseExternalIdleWorker(),
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged
      })
      documentOcrCoordinator.initialize()
      logStartup('documentOcrCoordinator initialized')

      const docSemanticModelsRootDir = join(app.getPath('userData'), 'models', 'doc-semantic')
      docSemanticModelManager = new DocSemanticModelManager({
        modelsRootDir: docSemanticModelsRootDir,
        getApprovedRoots: () => (catalog ? catalog.getAllSourceRoots() : []),
        getVaultRoot: () => (catalog ? (catalog.getActiveVault()?.vaultPath ?? null) : null),
        baseDownloadUrl: process.env.PV_TEST_DOC_MODEL_BASE_URL || undefined,
        allowedHosts: process.env.PV_TEST_DOC_MODEL_BASE_URL
          ? ['127.0.0.1', 'localhost', ...APPROVED_DOC_SEMANTIC_DOWNLOAD_HOSTS]
          : undefined,
        allowLoopbackHttpForTests: Boolean(process.env.PV_TEST_DOC_MODEL_BASE_URL)
      })
      await docSemanticModelManager.initialize()
      logStartup('docSemanticModelManager initialized')

      docSemanticCoordinator = new DocumentSemanticCoordinator({
        catalog,
        modelManager: docSemanticModelManager,
        maxAppLiveWorkers: 3,
        workerBudget: appWorkerBudget,
        tryReleaseExternalIdleWorker: () => tryReleaseExternalIdleWorker(),
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged
      })
      docSemanticCoordinator.initialize()
      logStartup('docSemanticCoordinator initialized')

      docSearchCoordinator = new DocumentSearchCoordinator({
        catalog,
        modelManager: docSemanticModelManager,
        indexCoordinator: docSemanticCoordinator,
        maxAppLiveWorkers: 3,
        workerBudget: appWorkerBudget,
        tryReleaseExternalIdleWorker: () => tryReleaseExternalIdleWorker('doc-search'),
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged
      })
      logStartup('docSearchCoordinator initialized')

      unifiedSearchCoordinator = new UnifiedSearchCoordinator({
        semanticSearchCoordinator,
        docSearchCoordinator
      })
      logStartup('unifiedSearchCoordinator initialized')

      photoSearchCoordinator = new PhotoSearchCoordinator({
        catalog,
        unifiedSearchCoordinator,
        semanticModelManager,
        photoMetadataCoordinator
      })
      logStartup('photoSearchCoordinator initialized')

      documentClassificationCoordinator = new DocumentClassificationCoordinator({
        catalog,
        maxAppLiveWorkers: 3,
        workerBudget: appWorkerBudget,
        tryReleaseExternalIdleWorker: () => tryReleaseExternalIdleWorker(),
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged
      })
      logStartup('documentClassificationCoordinator initialized')

      exportCoordinator = new ExportCoordinator({
        catalog,
        userDataDir,
        appVersion: app.getVersion()
      })
      const recoveredExportJobs = exportCoordinator.initialize()
      logStartup(`exportCoordinator initialized (recovered=${recoveredExportJobs})`)

      const googleDriveAuth = new GoogleDriveAuthService({
        tokenFilePath: join(userDataDir, 'google-drive-auth.enc'),
        safeStorage
      })

      backupCoordinator = new BackupCoordinator({
        catalog,
        userDataDir,
        appVersion: app.getVersion(),
        vaultImportCoordinator: vaultCoordinator,
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged,
        googleDrive: {
          getAccessToken: () => googleDriveAuth.getAccessToken(),
          isAvailable: () => googleDriveAuth.getStatus().status === 'connected'
        }
      })
      const backupInit = backupCoordinator.initialize()
      logStartup(
        `backupCoordinator initialized (interrupted=${backupInit.interruptedCount}, cleanedStaging=${backupInit.cleanedStagingDirs.length})`
      )

      const activeVaultCoordinator = vaultCoordinator
      const activeBackupCoordinator = backupCoordinator
      updateCoordinator = new UpdateCoordinator({
        adapter: createElectronUpdaterAdapter(),
        currentVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        vaultDrain: activeVaultCoordinator,
        backupDrain: activeBackupCoordinator,
        prepareForUpdateQuit: async () => {
          isQuitting = true
          await shutdownServicesForQuit({ skipUpdaterShutdown: true })
        },
        log: logStartup
      })

      registerIpcHandlers({
        validateSender: createSenderValidator({
          getTrustedWebContentsId: () => mainWindow?.webContents.id,
          location
        }),
        catalog,
        coordinator,
        vaultCoordinator,
        thumbnailCoordinator,
        similarityCoordinator,
        semanticModelManager,
        semanticIndexCoordinator,
        semanticSearchCoordinator,
        photoMetadataCoordinator,
        documentExtractionCoordinator,
        ocrModelManager,
        documentOcrCoordinator,
        docSemanticModelManager,
        docSemanticCoordinator,
        docSearchCoordinator,
        unifiedSearchCoordinator,
        photoSearchCoordinator,
        documentClassificationCoordinator,
        exportCoordinator,
        backupCoordinator,
        googleDriveAuth,
        updateCoordinator,
        userDataDir,
        getMainWindow: () => mainWindow
      })
      logStartup('registerIpcHandlers completed')

      createWindow()
      updateCoordinator.scheduleStartupCheck()

      app.on('activate', () => {
        logStartup('app activate event')
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((err) => {
      logStartup(
        `Fatal error during application startup: ${err instanceof Error ? err.stack : String(err)}`
      )
      console.error('Fatal error during application startup:', err)
      if (err instanceof RestoreIncompleteError) {
        app.exit(1)
      }
    })

  app.on('before-quit', (event) => {
    logStartup(`before-quit event: isQuitting=${isQuitting}`)
    if (!isQuitting) {
      isQuitting = true
      event.preventDefault()
      void shutdownServicesForQuit().finally(() => {
        logStartup('calling final app.quit()')
        app.quit()
      })
    }
  })

  app.on('window-all-closed', () => {
    logStartup('window-all-closed event')
    if (process.platform !== 'darwin') app.quit()
  })
}
