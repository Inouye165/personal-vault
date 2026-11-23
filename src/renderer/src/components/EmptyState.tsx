import { FolderLock } from 'lucide-react'
import type { NavigationTab } from '../../../shared/validation/ipc-schemas'
import { viewLabel } from '../views'
import { ScanJobsPanel, type ScanJobsPanelProps } from './ScanJobsPanel'

export interface EmptyStateProps {
  readonly currentTab: NavigationTab
  readonly scanJobsProps?: ScanJobsPanelProps
}

export function EmptyState({ currentTab, scanJobsProps }: EmptyStateProps) {
  return (
    <section className="empty-state-container" aria-labelledby="empty-state-heading">
      <div className="empty-state-card">
        <div className="empty-icon-wrap" aria-hidden="true">
          <FolderLock size={24} />
        </div>
        <h2 id="empty-state-heading" className="empty-title">
          No sources connected
        </h2>
        <p className="empty-description">
          The {viewLabel(currentTab)} view is empty because no sources are connected.
        </p>
        <p className="empty-note">
          Your original files are only ever read; they are never modified or deleted by cataloging.
        </p>

        {scanJobsProps && (
          <div className="empty-state-scan-section">
            <ScanJobsPanel
              {...scanJobsProps}
              selectButtonLabel={currentTab === 'photos' ? 'Add photos' : undefined}
            />
          </div>
        )}
      </div>
    </section>
  )
}
