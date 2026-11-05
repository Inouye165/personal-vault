import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { App } from '../../src/renderer/src/App.js'

describe('Personal Vault Desktop Shell (Stage 1)', () => {
  beforeEach(() => {
    window.api = {
      getAppInfo: async () => ({
        name: 'Personal Vault',
        version: '0.1.0',
        platform: 'win32',
        isPackaged: false
      }),
      getVaultStatus: async () => ({
        sourceCount: 0,
        itemCount: 0,
        isReady: true
      }),
      setTab: async () => true
    }
  })

  it('renders application branding and title', async () => {
    await act(async () => {
      render(<App />)
    })
    expect(screen.getByText('Personal Vault')).toBeInTheDocument()
    expect(screen.getByText(/Stage 1 Shell/i)).toBeInTheDocument()
  })

  it('provides all 5 required navigation items', async () => {
    await act(async () => {
      render(<App />)
    })
    const allTab = screen.getByRole('button', { name: /all items/i })
    const photosTab = screen.getByRole('button', { name: /photos/i })
    const docsTab = screen.getByRole('button', { name: /documents/i })
    const reviewTab = screen.getByRole('button', { name: /review/i })
    const dupsTab = screen.getByRole('button', { name: /duplicates/i })

    expect(allTab).toBeInTheDocument()
    expect(photosTab).toBeInTheDocument()
    expect(docsTab).toBeInTheDocument()
    expect(reviewTab).toBeInTheDocument()
    expect(dupsTab).toBeInTheDocument()

    // Default tab is 'all'
    expect(allTab).toHaveAttribute('aria-current', 'page')
    expect(photosTab).not.toHaveAttribute('aria-current')
  })

  it('switches navigation tab and updates view cleanly on click', async () => {
    await act(async () => {
      render(<App />)
    })
    const photosTab = screen.getByRole('button', { name: /photos/i })

    await act(async () => {
      fireEvent.click(photosTab)
    })

    expect(photosTab).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText(/photo library view is currently empty/i)).toBeInTheDocument()
  })

  it('displays an honest empty state stating no sources are connected and no files scanned', async () => {
    await act(async () => {
      render(<App />)
    })
    expect(screen.getByRole('heading', { name: /no sources connected/i })).toBeInTheDocument()
    expect(screen.getByText(/no user files have been scanned or modified/i)).toBeInTheDocument()
    expect(screen.getByText(/source originals will always remain unaltered/i)).toBeInTheDocument()
  })

  it('renders search bar in disabled/honest state when zero sources are connected', async () => {
    await act(async () => {
      render(<App />)
    })
    const searchInput = screen.getByRole('searchbox', { name: /search catalog/i })
    expect(searchInput).toBeInTheDocument()
    expect(searchInput).toBeDisabled()
  })

  it('does not render fake counts, mock search items, or simulated items', async () => {
    await act(async () => {
      render(<App />)
    })
    // Verify no fake item rows or fake numerical counters pretending data exists
    expect(screen.queryByText(/1,000 photos/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/sample_image\.jpg/i)).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /no sources connected/i })).toBeInTheDocument()
  })
})
