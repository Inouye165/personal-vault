import React from 'react'
import { FolderLock, Info } from 'lucide-react'
import type { NavigationTab } from '../../../shared/validation/ipc-schemas.js'

interface EmptyStateProps {
  currentTab: NavigationTab
}

const TAB_TITLES: Record<NavigationTab, string> = {
  all: 'All Catalog Items',
  photos: 'Photo Library',
  documents: 'Document Vault',
  review: 'Review & Classification',
  duplicates: 'Exact & Content Duplicates'
}

export const EmptyState: React.FC<EmptyStateProps> = ({ currentTab }) => {
  const sectionTitle = TAB_TITLES[currentTab]

  return (
    <section className="empty-state-container" aria-labelledby="empty-state-heading">
      <div className="empty-state-card">
        <div className="empty-icon-wrap" aria-hidden="true">
          <FolderLock size={24} />
        </div>

        <h2 id="empty-state-heading" className="empty-title">
          No Sources Connected
        </h2>

        <p className="empty-description">
          Personal Vault has not connected any source folders yet. The {sectionTitle.toLowerCase()}{' '}
          view is currently empty.
        </p>

        <div className="empty-details">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
            <Info size={16} aria-hidden="true" />
            <strong>Engineering Foundation (Stage 1)</strong>
          </div>
          <ul>
            <li>No user files have been scanned or modified.</li>
            <li>Source discovery and read-only indexing will be introduced in Stage 2.</li>
            <li>
              Source originals will always remain unaltered throughout discovery and cataloging.
            </li>
          </ul>
        </div>
      </div>
    </section>
  )
}
