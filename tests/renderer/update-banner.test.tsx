import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UpdateBanner } from '../../src/renderer/src/components/UpdateBanner'
import type { UpdateStateDto } from '../../src/shared/validation/update-ipc-schemas'

function makeState(overrides: Partial<UpdateStateDto> = {}): UpdateStateDto {
  return {
    phase: 'idle',
    configured: true,
    currentVersion: '0.1.0',
    availableVersion: null,
    releaseDate: null,
    downloadProgress: null,
    activeJobs: { vaultImportActive: false, backupActive: false },
    errorMessage: null,
    failedStage: null,
    lastCheckedAtMs: null,
    ...overrides
  }
}

describe('UpdateBanner', () => {
  it.each(['idle', 'checking', 'up_to_date', 'deferred'] as const)(
    'renders nothing during %s phase',
    (phase) => {
      render(
        <UpdateBanner
          state={makeState({ phase, availableVersion: phase === 'deferred' ? '0.1.1' : null })}
          onInstallNow={vi.fn()}
          onDefer={vi.fn()}
          onCheckForUpdates={vi.fn()}
          onDismissError={vi.fn()}
        />
      )
      expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument()
    }
  )

  it('offers Update now and Later when an update is available', () => {
    const onInstallNow = vi.fn()
    const onDefer = vi.fn()
    render(
      <UpdateBanner
        state={makeState({ phase: 'available', availableVersion: '0.1.1' })}
        onInstallNow={onInstallNow}
        onDefer={onDefer}
        onCheckForUpdates={vi.fn()}
        onDismissError={vi.fn()}
      />
    )

    const banner = screen.getByTestId('update-banner')
    expect(banner).toHaveAttribute('role', 'status')
    expect(screen.getByText(/Update available — Personal Vault 0\.1\.1/i)).toBeInTheDocument()
    expect(
      screen.getByText(
        /will close and reopen automatically after any active vault writes and backups finish/i
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('update-now-btn'))
    expect(onInstallNow).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('update-later-btn'))
    expect(onDefer).toHaveBeenCalledTimes(1)
  })

  it('shows download percentage, progress bar, and close-and-reopen guidance while downloading', () => {
    render(
      <UpdateBanner
        state={makeState({
          phase: 'downloading',
          availableVersion: '0.1.1',
          downloadProgress: {
            percent: 42.4,
            transferredBytes: 424,
            totalBytes: 1000,
            bytesPerSecond: 100
          }
        })}
        onInstallNow={vi.fn()}
        onDefer={vi.fn()}
        onCheckForUpdates={vi.fn()}
        onDismissError={vi.fn()}
      />
    )

    const banner = screen.getByTestId('update-banner')
    expect(banner).toHaveAttribute('role', 'status')
    expect(screen.getByText(/Downloading Personal Vault 0\.1\.1… 42%/i)).toBeInTheDocument()
    expect(
      screen.getByRole('progressbar', { name: /Update download progress/i })
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        /Personal Vault will close and reopen automatically after the download and any active vault writes or backups finish/i
      )
    ).toBeInTheDocument()
  })

  it('shows active vault write and backup job notice while draining before restart', () => {
    render(
      <UpdateBanner
        state={makeState({
          phase: 'waiting_for_jobs',
          availableVersion: '0.1.1',
          activeJobs: { vaultImportActive: true, backupActive: true }
        })}
        onInstallNow={vi.fn()}
        onDefer={vi.fn()}
        onCheckForUpdates={vi.fn()}
        onDismissError={vi.fn()}
      />
    )

    const banner = screen.getByTestId('update-banner')
    expect(banner).toHaveAttribute('role', 'status')
    expect(banner).toHaveTextContent(/active vault write and backup job/i)
  })

  it('shows failed download recovery actions while keeping current version usable', () => {
    const onInstallNow = vi.fn()
    const onDefer = vi.fn()
    render(
      <UpdateBanner
        state={makeState({
          phase: 'error',
          availableVersion: '0.1.1',
          failedStage: 'download',
          errorMessage: 'HTTP 500 Internal Server Error'
        })}
        onInstallNow={onInstallNow}
        onDefer={onDefer}
        onCheckForUpdates={vi.fn()}
        onDismissError={vi.fn()}
      />
    )

    const banner = screen.getByTestId('update-banner')
    expect(banner).toHaveAttribute('role', 'alert')
    expect(screen.getByText(/Update download failed/i)).toBeInTheDocument()
    expect(
      screen.getByText(/current version \(0\.1\.0\) is still ready to use/i)
    ).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('update-retry-btn'))
    expect(onInstallNow).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('update-dismiss-btn'))
    expect(onDefer).toHaveBeenCalledTimes(1)
  })
})
