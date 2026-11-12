import { app, BrowserWindow } from 'electron'
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
import { PhotoMetadataCoordinator } from './services/metadata'

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
  `Process start: isPackaged=${app.isPackaged}, execPath=${process.execPath}, argv=${JSON.stringify(process.argv)}`
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

function createWindow(): BrowserWindow {
  logStartup('createWindow: initializing BrowserWindow')
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
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

      const catalogPath = join(app.getPath('userData'), 'vault-catalog.db')
      logStartup(`Opening catalog at ${catalogPath}`)
      catalog = CatalogDatabase.open({ catalogPath })
      logStartup('CatalogDatabase.open completed')

      const annotationsDir = join(app.getPath('userData'), 'annotations')
      const journal = new AnnotationJournal({
        storageDir: annotationsDir,
        sourceRoots: () => (catalog ? catalog.getAllSourceRoots() : []),
        vaultPath: () => (catalog ? (catalog.getActiveVault()?.vaultPath ?? null) : null)
      })
      await journal.initialize()
      logStartup('journal.initialize completed')

      catalog.setJournal(journal)
      logStartup('catalog.setJournal completed with startup reconciliation')

      coordinator = new ScanJobCoordinator({ catalog })
      await coordinator.initialize()
      logStartup('coordinator.initialize completed')

      vaultCoordinator = new VaultImportCoordinator({ catalog })
      await vaultCoordinator.initialize()
      logStartup('vaultCoordinator.initialize completed')

      const cacheDir = join(app.getPath('userData'), 'thumbnails')
      thumbnailCoordinator = new ThumbnailCoordinator({
        cacheDir,
        approvedRoots: () => (catalog ? catalog.getAllSourceRoots() : []),
        vaultPath: () => (catalog ? (catalog.getActiveVault()?.vaultPath ?? null) : null)
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
        thumbnailCoordinator
      })
      semanticIndexCoordinator.initialize()
      logStartup('semanticIndexCoordinator initialized')

      photoMetadataCoordinator = new PhotoMetadataCoordinator({
        catalog,
        thumbnailCoordinator
      })
      photoMetadataCoordinator.initialize()
      logStartup('photoMetadataCoordinator initialized')

      semanticSearchCoordinator = new SemanticSearchCoordinator({
        catalog,
        modelManager: semanticModelManager
      })
      logStartup('semanticSearchCoordinator initialized')

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
        getMainWindow: () => mainWindow
      })
      logStartup('registerIpcHandlers completed')

      createWindow()

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
    })

  let isQuitting = false
  app.on('before-quit', (event) => {
    logStartup(`before-quit event: isQuitting=${isQuitting}`)
    if (!isQuitting) {
      isQuitting = true
      event.preventDefault()
      const doShutdown = async (): Promise<void> => {
        try {
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
        } finally {
          if (catalog && !catalog.isClosed()) {
            logStartup('closing catalog')
            catalog.close()
            logStartup('catalog closed')
          }
          logStartup('calling final app.quit()')
          app.quit()
        }
      }
      void doShutdown()
    }
  })

  app.on('window-all-closed', () => {
    logStartup('window-all-closed event')
    if (process.platform !== 'darwin') app.quit()
  })
}
