import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc/handlers'
import { createSenderValidator } from './ipc/sender'
import { resolveAppLocation, secureWebContents } from './navigation'
import { setupSecurityPolicies } from './security'

const documentPath = join(__dirname, '../renderer/index.html')

// The development URL is honoured only for unpackaged runs; see resolveAppLocation.
const location = resolveAppLocation({
  isPackaged: app.isPackaged,
  rendererUrl: process.env['ELECTRON_RENDERER_URL'],
  documentPath
})

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
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

  window.on('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  if (location.kind === 'dev') {
    void window.loadURL(location.origin)
  } else {
    void window.loadFile(location.documentPath)
  }

  mainWindow = window
  return window
}

// Ensure a single instance of Personal Vault per user-data directory.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    setupSecurityPolicies(location)
    registerIpcHandlers({
      validateSender: createSenderValidator({
        getTrustedWebContentsId: () => mainWindow?.webContents.id,
        location
      })
    })
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
