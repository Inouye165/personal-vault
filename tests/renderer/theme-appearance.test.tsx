import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import type { VaultApi } from '../../src/preload/index.d'

function createHealthyApi(): VaultApi {
  return {
    getAppInfo: vi.fn(async () => ({
      name: 'Personal Vault',
      version: '0.1.0',
      platform: 'win32',
      isPackaged: false
    })),
    getVaultStatus: vi.fn(async () => ({ sourceCount: 0, itemCount: 0, isReady: true })),
    setTab: vi.fn(async () => true),
    selectRoots: vi.fn(async () => ({ cancelled: true, rootPaths: [] })),
    startScan: vi.fn(async () => ({ success: true })),
    pauseScan: vi.fn(async () => ({ success: true })),
    resumeScan: vi.fn(async () => ({ success: true })),
    cancelScan: vi.fn(async () => ({ success: true })),
    getActiveScanJob: vi.fn(async () => ({ job: null })),
    getLatestScanJob: vi.fn(async () => ({ job: null })),
    dismissScanJob: vi.fn(async () => ({ success: true })),
    onScanProgress: vi.fn(() => () => {})
  } as unknown as VaultApi
}

describe('Appearance theme preference and menu', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.colorScheme = ''
    window.api = createHealthyApi()
  })

  afterEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.colorScheme = ''
    Reflect.deleteProperty(window, 'api')
    vi.restoreAllMocks()
  })

  it('defaults to Light theme on first use and sets data-theme="light"', async () => {
    await act(async () => {
      render(<App />)
    })

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(window.localStorage.getItem('pv.appearance.theme')).toBeNull()
  })

  it('falls back to Light theme when stored preference is invalid', async () => {
    window.localStorage.setItem('pv.appearance.theme', 'sepia-invalid')

    await act(async () => {
      render(<App />)
    })

    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('switches between Light and Dark via Appearance menu, persists across restarts, and supports Escape', async () => {
    const view = await act(async () => render(<App />))

    const menuButton = screen.getByTestId('app-menu-btn')
    expect(menuButton).toHaveAttribute('aria-haspopup', 'menu')
    expect(menuButton).toHaveAttribute('aria-expanded', 'false')

    await act(async () => {
      fireEvent.click(menuButton)
    })

    expect(menuButton).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByTestId('app-menu')
    expect(menu).toHaveTextContent(/appearance/i)

    const lightOption = screen.getByTestId('theme-option-light')
    const darkOption = screen.getByTestId('theme-option-dark')
    expect(lightOption).toHaveAttribute('aria-checked', 'true')
    expect(darkOption).toHaveAttribute('aria-checked', 'false')

    await act(async () => {
      fireEvent.click(darkOption)
    })

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(window.localStorage.getItem('pv.appearance.theme')).toBe('dark')

    // Unmount and remount to simulate app restart
    view.unmount()
    document.documentElement.removeAttribute('data-theme')

    await act(async () => {
      render(<App />)
    })

    expect(document.documentElement.dataset.theme).toBe('dark')

    const remountMenuBtn = screen.getByTestId('app-menu-btn')
    await act(async () => {
      fireEvent.click(remountMenuBtn)
    })

    expect(screen.getByTestId('theme-option-dark')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('theme-option-light')).toHaveAttribute('aria-checked', 'false')

    // Pressing Escape closes the menu and restores focus to the trigger button
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    expect(screen.queryByTestId('app-menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(remountMenuBtn)
  })
})
