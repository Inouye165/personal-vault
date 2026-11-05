import { FolderLock } from 'lucide-react'
import type { NavigationTab } from '../../../shared/validation/ipc-schemas'
import { viewLabel } from '../views'

export function EmptyState({ currentTab }: { currentTab: NavigationTab }) {
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
      </div>
    </section>
  )
}
