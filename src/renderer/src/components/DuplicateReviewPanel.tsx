import { useState } from 'react'
import {
  CheckCircle,
  Copy,
  AlertTriangle,
  RotateCcw,
  Star,
  ChevronLeft,
  ChevronRight,
  Info
} from 'lucide-react'
import { useDuplicateReview } from '../hooks/useDuplicateReview'
import type { DuplicateReviewFilter } from '../../../shared/validation/ipc-schemas'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDate(ms: number | null): string {
  if (ms === null || ms === undefined) return 'Unknown'
  return new Date(ms).toLocaleString()
}

export function DuplicateReviewPanel() {
  const review = useDuplicateReview()
  const [selectedPreferredId, setSelectedPreferredId] = useState<number | null>(null)

  // Synchronize local preferred selection when selected group changes
  const effectivePreferredId =
    selectedPreferredId !== null
      ? selectedPreferredId
      : (review.selectedGroup?.preferredLocationId ?? null)

  const handleSelectGroup = (group: (typeof review.groups)[0]) => {
    setSelectedPreferredId(null)
    review.selectGroup(group)
  }

  const handleToggleReviewed = async () => {
    if (!review.selectedGroup) return
    const newStatus = review.selectedGroup.reviewStatus === 'reviewed' ? 'unreviewed' : 'reviewed'
    await review.submitReview(newStatus, effectivePreferredId)
  }

  const handleSetPreferred = (fileLocationId: number) => {
    setSelectedPreferredId(fileLocationId)
  }

  return (
    <div className="duplicate-review-container">
      {/* Distinct Operations Architecture Notice */}
      <section className="distinct-operations-card" aria-labelledby="distinct-operations-title">
        <div className="operations-header">
          <Info size={18} className="info-icon" aria-hidden="true" />
          <h3 id="distinct-operations-title">Operations Policy & Boundaries</h3>
        </div>
        <p className="operations-subtitle">
          Review decisions are catalog annotations only; they never modify or delete source files.
          Personal Vault explicitly distinguishes three separate operations:
        </p>
        <div className="operations-grid">
          <div className="operation-item">
            <strong>1. Catalog-Index Removal</strong>
            <p>
              Removes the catalog index entry. Source files remain untouched on disk. (Planned in a
              future stage; not implemented).
            </p>
          </div>
          <div className="operation-item">
            <strong>2. Vault-Copy Deletion</strong>
            <p>
              Deletes a managed copy inside vault storage. (Vault storage is planned in Stage 4; not
              implemented).
            </p>
          </div>
          <div className="operation-item">
            <strong>3. Original-Source Deletion</strong>
            <p>
              Deletes files on your disk. Personal Vault never automatically deletes original source
              files; source deletion requires explicit, guarded confirmation. (Not implemented).
            </p>
          </div>
        </div>
      </section>

      {/* Loading state */}
      {review.isLoadingGroups && (
        <div className="notice" role="status">
          Loading duplicate groups…
        </div>
      )}

      {/* Error state */}
      {review.groupsError && (
        <div className="notice notice-error" role="alert">
          <strong>Failed to load duplicate groups</strong>
          <p>{review.groupsError}</p>
          <button type="button" className="btn btn-secondary" onClick={() => void review.refresh()}>
            <RotateCcw size={14} aria-hidden="true" />
            <span>Retry</span>
          </button>
        </div>
      )}

      {/* Confirmed Empty State */}
      {!review.isLoadingGroups && !review.groupsError && review.totalGroups === 0 && (
        <div className="empty-state-card duplicates-empty" role="status">
          <div className="empty-icon-wrap" aria-hidden="true">
            <CheckCircle size={28} />
          </div>
          <h2 className="empty-title">No duplicate files found</h2>
          <p className="empty-description">
            All cataloged files have unique content. As you scan more folders, identical files with
            matching SHA-256 and byte sizes will appear here for review.
          </p>
        </div>
      )}

      {/* Populated Duplicate Groups Review View */}
      {!review.isLoadingGroups && review.totalGroups > 0 && (
        <div className="duplicate-review-workspace">
          {/* Left Column: Duplicate Groups Master List */}
          <aside className="duplicate-groups-sidebar" aria-label="Duplicate Groups List">
            <div className="groups-sidebar-header">
              <div className="groups-count-title">
                <Copy size={16} aria-hidden="true" />
                <span>
                  {review.totalGroups} Duplicate {review.totalGroups === 1 ? 'Group' : 'Groups'}
                </span>
              </div>
              <div className="groups-filter-row" role="group" aria-label="Filter groups">
                {(['all', 'unreviewed', 'reviewed'] as const).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    className={`btn-filter ${review.groupsFilter === filter ? 'active' : ''}`}
                    onClick={() => review.setFilter(filter as DuplicateReviewFilter)}
                  >
                    {filter === 'all' ? 'All' : filter === 'unreviewed' ? 'Unreviewed' : 'Reviewed'}
                  </button>
                ))}
              </div>
            </div>

            <div className="groups-list" role="list">
              {review.groups.map((group) => {
                const isSelected =
                  review.selectedGroup?.sha256 === group.sha256 &&
                  review.selectedGroup?.byteSize === group.byteSize

                return (
                  <div
                    key={`${group.sha256}:${group.byteSize}`}
                    role="listitem"
                    className={`group-list-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => handleSelectGroup(group)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        handleSelectGroup(group)
                      }
                    }}
                    tabIndex={0}
                    aria-current={isSelected ? 'true' : undefined}
                  >
                    <div className="group-item-top">
                      <span className="group-item-size">{formatBytes(group.byteSize)}</span>
                      <span className="group-item-count">{group.fileCount} copies</span>
                    </div>
                    <div className="group-item-hash" title={group.sha256}>
                      SHA-256: {group.sha256.substring(0, 12)}…
                    </div>
                    <div className="group-item-bottom">
                      {group.hasStaleDecision ? (
                        <span
                          className="badge badge-warning"
                          title="Group membership or content has changed"
                        >
                          Review outdated
                        </span>
                      ) : group.reviewStatus === 'reviewed' ? (
                        <span className="badge badge-success">Reviewed</span>
                      ) : (
                        <span className="badge badge-neutral">Unreviewed</span>
                      )}
                      {group.preferredLocationId && (
                        <span className="badge badge-preferred" title="Preferred location selected">
                          <Star size={10} aria-hidden="true" /> Preferred set
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Groups Pagination */}
            {review.totalGroups > review.groupsLimit && (
              <div className="pagination-bar">
                <button
                  type="button"
                  className="btn btn-icon"
                  disabled={review.groupsOffset === 0}
                  onClick={() =>
                    review.changeGroupsPage(Math.max(0, review.groupsOffset - review.groupsLimit))
                  }
                  aria-label="Previous Page"
                >
                  <ChevronLeft size={16} />
                </button>
                <span className="pagination-info">
                  {Math.floor(review.groupsOffset / review.groupsLimit) + 1} /{' '}
                  {Math.ceil(review.totalGroups / review.groupsLimit)}
                </span>
                <button
                  type="button"
                  className="btn btn-icon"
                  disabled={review.groupsOffset + review.groupsLimit >= review.totalGroups}
                  onClick={() => review.changeGroupsPage(review.groupsOffset + review.groupsLimit)}
                  aria-label="Next Page"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </aside>

          {/* Right Column: Group Details & Member Side-by-Side Review */}
          <main className="duplicate-detail-panel" aria-label="Duplicate Group Details">
            {review.selectedGroup ? (
              <>
                <div className="group-detail-header">
                  <div className="group-header-info">
                    <h2 className="group-header-title">
                      Duplicate Group ({review.selectedGroup.fileCount} identical copies)
                    </h2>
                    <div className="group-facts-meta">
                      <span className="fact-item">
                        <strong>Content Size:</strong> {formatBytes(review.selectedGroup.byteSize)}{' '}
                        ({review.selectedGroup.byteSize.toLocaleString()} bytes)
                      </span>
                      <span className="fact-item hash-fact">
                        <strong>Verified SHA-256:</strong>{' '}
                        <code>{review.selectedGroup.sha256}</code>
                      </span>
                    </div>
                  </div>

                  <div className="group-review-actions">
                    <button
                      type="button"
                      className={`btn ${review.selectedGroup.reviewStatus === 'reviewed' ? 'btn-secondary' : 'btn-primary'}`}
                      onClick={() => void handleToggleReviewed()}
                      disabled={review.isSavingReview}
                    >
                      <CheckCircle size={16} aria-hidden="true" />
                      <span>
                        {review.selectedGroup.reviewStatus === 'reviewed'
                          ? 'Mark as Unreviewed'
                          : 'Mark as Reviewed'}
                      </span>
                    </button>
                  </div>
                </div>

                {review.selectedGroup.hasStaleDecision && (
                  <div className="notice notice-warning" role="alert">
                    <AlertTriangle size={18} aria-hidden="true" />
                    <div>
                      <strong>Review decision outdated</strong>
                      <p>
                        The files or content in this duplicate group have changed since it was
                        previously reviewed. The prior decision has been invalidated. Please review
                        the current members.
                      </p>
                    </div>
                  </div>
                )}

                {review.actionError && (
                  <div className="notice notice-error" role="alert">
                    <strong>Action Failed</strong>
                    <p>{review.actionError}</p>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void review.refresh()}
                    >
                      <RotateCcw size={14} aria-hidden="true" />
                      <span>Refresh Group</span>
                    </button>
                  </div>
                )}

                {/* Member Comparison Area */}
                <div className="members-section">
                  <div className="members-section-header">
                    <h3>Identical Copies ({review.totalMembers})</h3>
                    {review.totalMembers > review.membersLimit && (
                      <span className="text-dim">
                        Showing {review.membersOffset + 1}–
                        {Math.min(review.totalMembers, review.membersOffset + review.membersLimit)}{' '}
                        of {review.totalMembers}
                      </span>
                    )}
                  </div>

                  {review.isLoadingMembers && (
                    <div className="notice" role="status">
                      Loading file members…
                    </div>
                  )}

                  {!review.isLoadingMembers && (
                    <div className="members-grid">
                      {review.members.map((member) => {
                        const isMemberPreferred = effectivePreferredId === member.fileLocationId
                        return (
                          <div
                            key={member.fileLocationId}
                            className={`member-card ${isMemberPreferred ? 'is-preferred-card' : ''}`}
                          >
                            <div className="member-card-header">
                              <div className="member-filename" title={member.fileName}>
                                {member.fileName}
                              </div>
                              <div className="member-actions">
                                {isMemberPreferred ? (
                                  <span className="preferred-badge">
                                    <Star size={14} fill="currentColor" aria-hidden="true" />{' '}
                                    Preferred Location
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => handleSetPreferred(member.fileLocationId)}
                                    disabled={review.isSavingReview}
                                    aria-label={`Set ${member.fileName} as preferred location`}
                                  >
                                    <Star size={14} aria-hidden="true" />
                                    <span>Set as Preferred</span>
                                  </button>
                                )}
                              </div>
                            </div>

                            <div className="member-facts-list">
                              <div className="fact-row">
                                <span className="fact-label">Absolute Path:</span>
                                <span className="fact-value path-value" title={member.originalPath}>
                                  {member.originalPath}
                                </span>
                              </div>

                              <div className="fact-row">
                                <span className="fact-label">Byte Size:</span>
                                <span className="fact-value">
                                  {formatBytes(member.byteSize)} ({member.byteSize.toLocaleString()}{' '}
                                  bytes)
                                </span>
                              </div>

                              <div className="fact-row">
                                <span className="fact-label">Filesystem Created:</span>
                                <span className="fact-value">
                                  {formatDate(member.filesystemBirthtimeMs)}
                                </span>
                              </div>

                              <div className="fact-row">
                                <span className="fact-label">Filesystem Modified:</span>
                                <span className="fact-value">
                                  {formatDate(member.filesystemMtimeMs)}
                                </span>
                              </div>

                              <div className="fact-row">
                                <span className="fact-label">Inferred Capture:</span>
                                <span className="fact-value">
                                  {member.inferredCaptureTimeMs
                                    ? `${formatDate(member.inferredCaptureTimeMs)} (Inferred)`
                                    : 'None'}
                                </span>
                              </div>

                              <div className="fact-divider" />

                              <div className="fact-row provenance-row">
                                <span className="fact-label">Hash Provenance:</span>
                                <span className="fact-value">
                                  Observation #{member.hashObservationId} (Verified:{' '}
                                  {formatDate(member.activeHashVerifiedAtMs)})
                                </span>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Members Pagination if > limit */}
                  {review.totalMembers > review.membersLimit && (
                    <div className="pagination-bar members-pagination">
                      <button
                        type="button"
                        className="btn btn-icon"
                        disabled={review.membersOffset === 0}
                        onClick={() =>
                          review.changeMembersPage(
                            Math.max(0, review.membersOffset - review.membersLimit)
                          )
                        }
                        aria-label="Previous Members Page"
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <span className="pagination-info">
                        Page {Math.floor(review.membersOffset / review.membersLimit) + 1} of{' '}
                        {Math.ceil(review.totalMembers / review.membersLimit)}
                      </span>
                      <button
                        type="button"
                        className="btn btn-icon"
                        disabled={review.membersOffset + review.membersLimit >= review.totalMembers}
                        onClick={() =>
                          review.changeMembersPage(review.membersOffset + review.membersLimit)
                        }
                        aria-label="Next Members Page"
                      >
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="no-selection-placeholder">
                <p>Select a duplicate group from the list to review copies.</p>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  )
}
