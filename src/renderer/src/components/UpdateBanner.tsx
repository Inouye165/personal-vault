import type { UpdateStateDto } from '../../../shared/validation/update-ipc-schemas'

export interface UpdateBannerProps {
  readonly state: UpdateStateDto | null
  readonly onInstallNow: () => void
  readonly onDefer: () => void
  readonly onCheckForUpdates: () => void
  readonly onDismissError: () => void
}

function describeActiveJobs(state: UpdateStateDto): string {
  const { vaultImportActive, backupActive } = state.activeJobs
  if (vaultImportActive && backupActive) {
    return 'active vault write and backup job'
  }
  if (vaultImportActive) {
    return 'active vault write'
  }
  if (backupActive) {
    return 'active backup job'
  }
  return 'active background job'
}

export function UpdateBanner({
  state,
  onInstallNow,
  onDefer,
  onCheckForUpdates,
  onDismissError
}: UpdateBannerProps) {
  if (
    !state ||
    state.phase === 'idle' ||
    state.phase === 'checking' ||
    state.phase === 'up_to_date' ||
    state.phase === 'deferred'
  ) {
    return null
  }

  if (state.phase === 'available') {
    return (
      <section
        className="update-banner update-banner-available"
        data-testid="update-banner"
        aria-label="Application update"
      >
        <div className="update-banner-body">
          <strong>Personal Vault {state.availableVersion} is available</strong>
          <p className="update-banner-detail">
            Choose Update now to download and install. Personal Vault will close and reopen
            automatically after your vault writes and backups finish. Choose Later to keep working.
          </p>
        </div>
        <div className="update-banner-actions">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="update-now-btn"
            onClick={onInstallNow}
          >
            Update now
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="update-later-btn"
            onClick={onDefer}
          >
            Later
          </button>
        </div>
      </section>
    )
  }

  if (state.phase === 'downloading') {
    const percent = Math.round(state.downloadProgress?.percent ?? 0)
    return (
      <section
        className="update-banner update-banner-progress"
        data-testid="update-banner"
        aria-label="Application update"
      >
        <div className="update-banner-body">
          <strong>
            Downloading Personal Vault {state.availableVersion ?? ''}… {percent}%
          </strong>
          <progress
            className="update-banner-progress-bar"
            aria-label="Update download progress"
            max={100}
            value={state.downloadProgress?.percent ?? 0}
          />
        </div>
      </section>
    )
  }

  if (state.phase === 'waiting_for_jobs') {
    const activeLabel = describeActiveJobs(state)
    return (
      <section
        className="update-banner update-banner-waiting"
        data-testid="update-banner"
        aria-label="Application update"
      >
        <div className="update-banner-body">
          <strong>Waiting for {activeLabel} to finish before restarting</strong>
          <p className="update-banner-detail">
            Update {state.availableVersion ?? ''} has been downloaded and verified. Personal Vault
            will restart automatically once your {activeLabel} completes.
          </p>
        </div>
      </section>
    )
  }

  if (state.phase === 'installing') {
    return (
      <section
        className="update-banner update-banner-installing"
        data-testid="update-banner"
        aria-label="Application update"
      >
        <div className="update-banner-body">
          <strong>Installing Personal Vault {state.availableVersion ?? ''} and restarting…</strong>
        </div>
      </section>
    )
  }

  const errorHeading =
    state.failedStage === 'download'
      ? 'Update download failed'
      : state.failedStage === 'install'
        ? 'Update installation failed'
        : 'Update check failed'

  return (
    <section
      className="update-banner update-banner-error"
      data-testid="update-banner"
      aria-label="Application update"
    >
      <div className="update-banner-body">
        <strong>{errorHeading}</strong>
        <p className="update-banner-detail">
          {state.errorMessage ?? 'Could not complete update.'} Your current version (
          {state.currentVersion}) is still ready to use.
        </p>
      </div>
      <div className="update-banner-actions">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="update-retry-btn"
          onClick={state.availableVersion ? onInstallNow : onCheckForUpdates}
        >
          Retry
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          data-testid="update-dismiss-btn"
          onClick={state.availableVersion ? onDefer : onDismissError}
        >
          {state.availableVersion ? 'Later' : 'Dismiss'}
        </button>
      </div>
    </section>
  )
}
