import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DuplicateGroupSummary,
  DuplicateMemberRecord,
  DuplicateReviewFilter
} from '../../../shared/validation/ipc-schemas'

export interface UseDuplicateReviewResult {
  readonly groups: readonly DuplicateGroupSummary[]
  readonly totalGroups: number
  readonly groupsOffset: number
  readonly groupsLimit: number
  readonly groupsFilter: DuplicateReviewFilter
  readonly isLoadingGroups: boolean
  readonly groupsError: string | null
  readonly selectedGroup: DuplicateGroupSummary | null
  readonly members: readonly DuplicateMemberRecord[]
  readonly totalMembers: number
  readonly membersOffset: number
  readonly membersLimit: number
  readonly isLoadingMembers: boolean
  readonly membersError: string | null
  readonly actionError: string | null
  readonly isSavingReview: boolean
  readonly selectGroup: (group: DuplicateGroupSummary) => void
  readonly setFilter: (filter: DuplicateReviewFilter) => void
  readonly changeGroupsPage: (offset: number) => void
  readonly changeMembersPage: (offset: number) => void
  readonly submitReview: (
    status: 'unreviewed' | 'reviewed',
    preferredLocationId?: number | null
  ) => Promise<void>
  readonly refresh: () => Promise<void>
}

export function useDuplicateReview(): UseDuplicateReviewResult {
  const [groups, setGroups] = useState<DuplicateGroupSummary[]>([])
  const [totalGroups, setTotalGroups] = useState(0)
  const [groupsOffset, setGroupsOffset] = useState(0)
  const groupsLimit = 20
  const [groupsFilter, setGroupsFilter] = useState<DuplicateReviewFilter>('all')
  const [isLoadingGroups, setIsLoadingGroups] = useState(false)
  const [groupsError, setGroupsError] = useState<string | null>(null)

  const [selectedGroup, setSelectedGroup] = useState<DuplicateGroupSummary | null>(null)
  const [members, setMembers] = useState<DuplicateMemberRecord[]>([])
  const [totalMembers, setTotalMembers] = useState(0)
  const [membersOffset, setMembersOffset] = useState(0)
  const membersLimit = 50
  const [isLoadingMembers, setIsLoadingMembers] = useState(false)
  const [membersError, setMembersError] = useState<string | null>(null)

  const [actionError, setActionError] = useState<string | null>(null)
  const [isSavingReview, setIsSavingReview] = useState(false)

  // Token to prevent race conditions on rapid asynchronous selections
  const selectionTokenRef = useRef(0)

  const fetchMembers = useCallback(
    async (group: DuplicateGroupSummary, offset: number) => {
      const token = ++selectionTokenRef.current
      setIsLoadingMembers(true)
      setMembersError(null)
      try {
        const response = await window.api.getDuplicateGroupMembers({
          sha256: group.sha256,
          byteSize: group.byteSize,
          offset,
          limit: membersLimit
        })
        if (token === selectionTokenRef.current) {
          setMembers(response.items)
          setTotalMembers(response.totalCount)
          setMembersOffset(response.offset)
          setSelectedGroup((prev) =>
            prev && prev.sha256 === group.sha256 && prev.byteSize === group.byteSize
              ? {
                  ...prev,
                  groupSignature: response.groupSignature,
                  reviewStatus: response.reviewStatus,
                  preferredLocationId: response.preferredLocationId,
                  hasStaleDecision: response.hasStaleDecision,
                  reviewedAtMs: response.reviewedAtMs ?? null
                }
              : prev
          )
        }
      } catch (err) {
        if (token === selectionTokenRef.current) {
          setMembersError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (token === selectionTokenRef.current) {
          setIsLoadingMembers(false)
        }
      }
    },
    [membersLimit]
  )

  const fetchGroups = useCallback(
    async (offset: number, filter: DuplicateReviewFilter) => {
      setIsLoadingGroups(true)
      setGroupsError(null)
      try {
        const response = await window.api.getDuplicateGroups({
          offset,
          limit: groupsLimit,
          filter
        })
        setGroups(response.items)
        setTotalGroups(response.totalCount)
        setGroupsOffset(response.offset)

        // If previously selected group is still in items, update it; otherwise select first or null
        setSelectedGroup((current) => {
          if (!current && response.items.length > 0) {
            const first = response.items[0]!
            void fetchMembers(first, 0)
            return first
          }
          if (current) {
            const match = response.items.find(
              (g) => g.sha256 === current.sha256 && g.byteSize === current.byteSize
            )
            if (match) {
              void fetchMembers(match, 0)
              return match
            }
            if (response.items.length > 0) {
              const first = response.items[0]!
              void fetchMembers(first, 0)
              return first
            }
          }
          setMembers([])
          setTotalMembers(0)
          return null
        })
      } catch (err) {
        setGroupsError(err instanceof Error ? err.message : String(err))
      } finally {
        setIsLoadingGroups(false)
      }
    },
    [fetchMembers, groupsLimit]
  )

  useEffect(() => {
    let active = true
    const loadInitial = async () => {
      await Promise.resolve()
      if (active) {
        void fetchGroups(0, groupsFilter)
      }
    }
    void loadInitial()
    return () => {
      active = false
    }
  }, [fetchGroups, groupsFilter])

  const selectGroup = useCallback(
    (group: DuplicateGroupSummary) => {
      setSelectedGroup(group)
      setMembersOffset(0)
      setActionError(null)
      void fetchMembers(group, 0)
    },
    [fetchMembers]
  )

  const setFilter = useCallback((filter: DuplicateReviewFilter) => {
    setGroupsFilter(filter)
    setGroupsOffset(0)
    setActionError(null)
  }, [])

  const changeGroupsPage = useCallback(
    (newOffset: number) => {
      void fetchGroups(newOffset, groupsFilter)
    },
    [fetchGroups, groupsFilter]
  )

  const changeMembersPage = useCallback(
    (newOffset: number) => {
      if (selectedGroup) {
        void fetchMembers(selectedGroup, newOffset)
      }
    },
    [fetchMembers, selectedGroup]
  )

  const submitReview = useCallback(
    async (status: 'unreviewed' | 'reviewed', preferredLocationId?: number | null) => {
      if (!selectedGroup) return
      setIsSavingReview(true)
      setActionError(null)
      try {
        const response = await window.api.setDuplicateReview({
          sha256: selectedGroup.sha256,
          byteSize: selectedGroup.byteSize,
          status,
          preferredLocationId: preferredLocationId ?? null,
          expectedGroupSignature: selectedGroup.groupSignature
        })

        // Update selectedGroup and members state locally
        setSelectedGroup((prev) =>
          prev
            ? {
                ...prev,
                reviewStatus: response.status,
                preferredLocationId: response.preferredLocationId,
                groupSignature: response.groupSignature,
                hasStaleDecision: false,
                reviewedAtMs: response.reviewedAtMs
              }
            : null
        )

        setGroups((prev) =>
          prev.map((g) =>
            g.sha256 === response.sha256 && g.byteSize === response.byteSize
              ? {
                  ...g,
                  reviewStatus: response.status,
                  preferredLocationId: response.preferredLocationId,
                  groupSignature: response.groupSignature,
                  hasStaleDecision: false,
                  reviewedAtMs: response.reviewedAtMs
                }
              : g
          )
        )

        setMembers((prev) =>
          prev.map((m) => ({
            ...m,
            isPreferred:
              response.preferredLocationId !== null &&
              m.fileLocationId === response.preferredLocationId
          }))
        )
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      } finally {
        setIsSavingReview(false)
      }
    },
    [selectedGroup]
  )

  const refresh = useCallback(async () => {
    setActionError(null)
    await fetchGroups(groupsOffset, groupsFilter)
  }, [fetchGroups, groupsOffset, groupsFilter])

  return {
    groups,
    totalGroups,
    groupsOffset,
    groupsLimit,
    groupsFilter,
    isLoadingGroups,
    groupsError,
    selectedGroup,
    members,
    totalMembers,
    membersOffset,
    membersLimit,
    isLoadingMembers,
    membersError,
    actionError,
    isSavingReview,
    selectGroup,
    setFilter,
    changeGroupsPage,
    changeMembersPage,
    submitReview,
    refresh
  }
}
