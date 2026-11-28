// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { RestoreIncompleteError } from '../../src/main/services/backup/errors'
import { UnsupportedSchemaVersionError } from '../../src/main/services/catalog/errors'
import {
  focusExistingWindowOnSecondInstance,
  formatFatalStartupError,
  handleFatalStartupError,
  shouldShowStartupErrorDialog,
  type ExistingWindowLike
} from '../../src/main/startup-lifecycle'

describe('startup lifecycle: formatFatalStartupError', () => {
  it('explains schema version mismatches with installed version and startup log path', () => {
    const err = new UnsupportedSchemaVersionError(22, 10)
    const msg = formatFatalStartupError(err, {
      appVersion: '0.1.2',
      logPath: 'C:\\Users\\Test\\AppData\\Roaming\\personal-vault\\startup.log'
    })

    expect(msg.title).toBe('Personal Vault Cannot Start')
    expect(msg.content).toContain('v0.1.2')
    expect(msg.content).toContain('schema version 10')
    expect(msg.content).toContain('version 22')
    expect(msg.content).toContain('older installation or shortcut')
    expect(msg.content).toContain('C:\\Users\\Test\\AppData\\Roaming\\personal-vault\\startup.log')
  })

  it('formats RestoreIncompleteError clearly', () => {
    const err = new RestoreIncompleteError('Marker found from interrupted restore')
    const msg = formatFatalStartupError(err, {
      appVersion: '0.1.4',
      logPath: 'C:\\temp\\startup.log'
    })

    expect(msg.title).toBe('Personal Vault Cannot Start')
    expect(msg.content).toContain('Marker found from interrupted restore')
    expect(msg.content).toContain('0.1.4')
    expect(msg.content).toContain('C:\\temp\\startup.log')
  })

  it('formats unexpected generic startup errors', () => {
    const msg = formatFatalStartupError(new Error('SQLITE_CANTOPEN'), {
      appVersion: '0.1.4',
      logPath: 'C:\\temp\\startup.log'
    })

    expect(msg.title).toBe('Personal Vault Failed to Start')
    expect(msg.content).toContain('v0.1.4')
    expect(msg.content).toContain('SQLITE_CANTOPEN')
    expect(msg.content).toContain('C:\\temp\\startup.log')
  })
})

describe('startup lifecycle: shouldShowStartupErrorDialog', () => {
  it('enables dialogs for interactive desktop launches', () => {
    expect(
      shouldShowStartupErrorDialog({
        env: {},
        argv: ['Personal Vault.exe']
      })
    ).toBe(true)
  })

  it('suppresses dialogs in CI, test, headless, or explicit override environments', () => {
    expect(shouldShowStartupErrorDialog({ env: { CI: 'true' }, argv: [] })).toBe(false)
    expect(shouldShowStartupErrorDialog({ env: { NODE_ENV: 'test' }, argv: [] })).toBe(false)
    expect(shouldShowStartupErrorDialog({ env: { PV_DISABLE_ERROR_DIALOG: '1' }, argv: [] })).toBe(
      false
    )
    expect(
      shouldShowStartupErrorDialog({ env: {}, argv: ['Personal Vault.exe', '--headless'] })
    ).toBe(false)
    expect(
      shouldShowStartupErrorDialog({
        env: {},
        argv: ['Personal Vault.exe', '--disable-error-dialog']
      })
    ).toBe(false)
  })
})

describe('startup lifecycle: handleFatalStartupError', () => {
  it('shuts down services, releases lock BEFORE showing dialog, and exits with code 1', async () => {
    const order: string[] = []
    const showErrorBox = vi.fn(() => order.push('dialog'))
    const shutdownServices = vi.fn(async () => {
      order.push('shutdown')
    })
    const releaseSingleInstanceLock = vi.fn(() => order.push('releaseLock'))
    const exit = vi.fn(() => {
      order.push('exit')
    })
    const logStartup = vi.fn()
    const logConsoleError = vi.fn()

    await handleFatalStartupError(new UnsupportedSchemaVersionError(22, 10), {
      appVersion: '0.1.2',
      logPath: 'C:\\temp\\startup.log',
      showDialog: true,
      logStartup,
      logConsoleError,
      showErrorBox,
      exit,
      shutdownServices,
      releaseSingleInstanceLock
    })

    expect(order).toEqual(['shutdown', 'releaseLock', 'dialog', 'exit'])
    expect(showErrorBox).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(logStartup).toHaveBeenCalledWith(
      expect.stringContaining('Fatal error during application startup')
    )
    expect(logConsoleError).toHaveBeenCalledTimes(1)
  })

  it('still exits with code 1 and omits error box when showDialog is false', async () => {
    const showErrorBox = vi.fn()
    const shutdownServices = vi.fn(async () => undefined)
    const releaseSingleInstanceLock = vi.fn()
    const exit = vi.fn()

    await handleFatalStartupError(new Error('boom'), {
      appVersion: '0.1.4',
      logPath: 'C:\\temp\\startup.log',
      showDialog: false,
      logStartup: vi.fn(),
      logConsoleError: vi.fn(),
      showErrorBox,
      exit,
      shutdownServices,
      releaseSingleInstanceLock
    })

    expect(shutdownServices).toHaveBeenCalledTimes(1)
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1)
    expect(showErrorBox).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('still releases lock, shows error box, and exits with code 1 if cleanup steps throw', async () => {
    const showErrorBox = vi.fn(() => {
      throw new Error('dialog failed')
    })
    const shutdownServices = vi.fn(async () => {
      throw new Error('shutdown failed')
    })
    const releaseSingleInstanceLock = vi.fn(() => {
      throw new Error('lock release failed')
    })
    const exit = vi.fn()
    const logStartup = vi.fn()

    await handleFatalStartupError(new Error('root cause'), {
      appVersion: '0.1.4',
      logPath: 'C:\\temp\\startup.log',
      showDialog: true,
      logStartup,
      logConsoleError: vi.fn(),
      showErrorBox,
      exit,
      shutdownServices,
      releaseSingleInstanceLock
    })

    expect(exit).toHaveBeenCalledWith(1)
    expect(logStartup).toHaveBeenCalledWith(expect.stringContaining('Failed to shut down services'))
    expect(logStartup).toHaveBeenCalledWith(
      expect.stringContaining('Failed to release single-instance lock')
    )
    expect(logStartup).toHaveBeenCalledWith(
      expect.stringContaining('Failed to display startup error dialog')
    )
  })
})

describe('startup lifecycle: focusExistingWindowOnSecondInstance', () => {
  function createMockWindow(overrides: Partial<ExistingWindowLike> = {}): ExistingWindowLike {
    return {
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      isMinimized: vi.fn(() => false),
      show: vi.fn(),
      restore: vi.fn(),
      focus: vi.fn(),
      ...overrides
    }
  }

  it('shows hidden windows, restores minimized windows, and focuses', () => {
    const win = createMockWindow({
      isVisible: vi.fn(() => false),
      isMinimized: vi.fn(() => true)
    })
    const logStartup = vi.fn()

    focusExistingWindowOnSecondInstance(win, logStartup)

    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.restore).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
    expect(logStartup).toHaveBeenCalledWith(expect.stringContaining('focusing existing window'))
  })

  it('skips hidden/minimized calls when already visible and unminimized', () => {
    const win = createMockWindow()
    focusExistingWindowOnSecondInstance(win, vi.fn())

    expect(win.show).not.toHaveBeenCalled()
    expect(win.restore).not.toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('does nothing safely when window is null or destroyed', () => {
    const destroyed = createMockWindow({ isDestroyed: vi.fn(() => true) })
    const logStartup = vi.fn()

    focusExistingWindowOnSecondInstance(null, logStartup)
    focusExistingWindowOnSecondInstance(destroyed, logStartup)

    expect(destroyed.show).not.toHaveBeenCalled()
    expect(destroyed.focus).not.toHaveBeenCalled()
    expect(logStartup).toHaveBeenCalledTimes(2)
    expect(logStartup).toHaveBeenLastCalledWith(expect.stringContaining('no active main window'))
  })
})
