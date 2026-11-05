import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { setupSecurityPolicies, secureWebContents } from './security.js'
import { registerIpcHandlers } from './ipc/handlers.js'

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
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

  // Prevent opening links inside Electron window; if necessary open in external browser
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  secureWebContents(mainWindow.webContents)

  mainWindow.on('ready-to-show', async () => {
    mainWindow.show()

    if (process.env.PV_SCREENSHOT_PATH) {
      try {
        // Wait a moment for renderer paint
        await new Promise((resolve) => setTimeout(resolve, 800))
        const image = await mainWindow.webContents.capturePage()
        await fs.writeFile(process.env.PV_SCREENSHOT_PATH, image.toPNG())
        console.log(`SCREENSHOT_CAPTURED: ${process.env.PV_SCREENSHOT_PATH}`)
      } catch (err) {
        console.error('Failed to capture shell screenshot:', err)
      }
    }

    if (process.env.PV_TEST_EXIT === 'true') {
      console.log('MAIN_WINDOW_READY_AND_SHOWN')
      setTimeout(() => {
        app.quit()
      }, 500)
    }
  })

  // Load dev server or packaged production build
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

// Ensure single instance of Personal Vault
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const windows = BrowserWindow.getAllWindows()
    const mainWindow = windows[0]
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    setupSecurityPolicies()
    registerIpcHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
