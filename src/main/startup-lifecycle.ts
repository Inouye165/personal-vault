import { RestoreIncompleteError } from './services/backup/errors'
import { UnsupportedSchemaVersionError } from './services/catalog/errors'

export interface StartupDialogMessage {
  title: string
  content: string
}

export interface ExistingWindowLike {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  show(): void
  restore(): void
  focus(): void
}

export interface FatalStartupErrorDeps {
  appVersion: string
  logPath: string
  showDialog: boolean
  logStartup: (message: string) => void
  logConsoleError?: (...args: unknown[]) => void
  showErrorBox: (title: string, content: string) => void
  exit: (code?: number) => void
  shutdownServices: () => Promise<void>
  releaseSingleInstanceLock: () => void
}

export function formatFatalStartupError(
  error: unknown,
  options: { appVersion: string; logPath: string }
): StartupDialogMessage {
  if (error instanceof UnsupportedSchemaVersionError) {
    return {
      title: 'Personal Vault Cannot Start',
      content: [
        `This build of Personal Vault (v${options.appVersion}) supports catalog schema version ${error.supportedVersion}, but the catalog on this machine is already at version ${error.currentVersion}.`,
        '',
        'This usually happens if you launched an older installation or shortcut after upgrading Personal Vault.',
        'Open the newest installed Personal Vault build, or install an updated version.',
        '',
        `Startup log: ${options.logPath}`
      ].join('\n')
    }
  }

  if (error instanceof RestoreIncompleteError) {
    return {
      title: 'Personal Vault Cannot Start',
      content: [
        error.message,
        '',
        `Version: ${options.appVersion}`,
        `Startup log: ${options.logPath}`
      ].join('\n')
    }
  }

  const detail = error instanceof Error ? error.message : String(error)
  return {
    title: 'Personal Vault Failed to Start',
    content: [
      `Personal Vault (v${options.appVersion}) encountered a fatal error during startup:`,
      detail,
      '',
      `Startup log: ${options.logPath}`
    ].join('\n')
  }
}

export function shouldShowStartupErrorDialog(options: {
  env: NodeJS.ProcessEnv
  argv: readonly string[]
}): boolean {
  const { env, argv } = options
  if (env.CI || env.NODE_ENV === 'test' || env.PV_DISABLE_ERROR_DIALOG === '1') {
    return false
  }
  if (argv.includes('--headless') || argv.includes('--disable-error-dialog')) {
    return false
  }
  return true
}

export async function handleFatalStartupError(
  error: unknown,
  deps: FatalStartupErrorDeps
): Promise<void> {
  const logConsoleError = deps.logConsoleError ?? console.error
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)

  deps.logStartup(`Fatal error during application startup: ${detail}`)
  logConsoleError('Fatal error during application startup:', error)

  try {
    await deps.shutdownServices()
  } catch (shutdownErr) {
    deps.logStartup(
      `Failed to shut down services after fatal startup error: ${
        shutdownErr instanceof Error
          ? (shutdownErr.stack ?? shutdownErr.message)
          : String(shutdownErr)
      }`
    )
  }

  try {
    deps.releaseSingleInstanceLock()
  } catch (lockErr) {
    deps.logStartup(
      `Failed to release single-instance lock after fatal startup error: ${
        lockErr instanceof Error ? (lockErr.stack ?? lockErr.message) : String(lockErr)
      }`
    )
  }

  if (deps.showDialog) {
    const dialogMessage = formatFatalStartupError(error, {
      appVersion: deps.appVersion,
      logPath: deps.logPath
    })
    try {
      deps.showErrorBox(dialogMessage.title, dialogMessage.content)
    } catch (dialogErr) {
      deps.logStartup(
        `Failed to display startup error dialog: ${
          dialogErr instanceof Error ? (dialogErr.stack ?? dialogErr.message) : String(dialogErr)
        }`
      )
    }
  }

  deps.exit(1)
}

export function focusExistingWindowOnSecondInstance(
  mainWindow: ExistingWindowLike | null | undefined,
  logStartup: (message: string) => void
): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    logStartup('second-instance event received -> no active main window to focus')
    return
  }

  logStartup('second-instance event received -> focusing existing window')
  if (!mainWindow.isVisible()) {
    mainWindow.show()
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.focus()
}
