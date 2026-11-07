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

  // Tracking refs synchronized outside React state updater callbacks to maintain purity
  const isMountedRef = useRef(true)
  const groupsTokenRef = useRef(0)
  const selectionTokenRef = useRef(0)
  const selectedGroupRef = useRef<DuplicateGroupSummary | null>(null)
  const groupsFilterRef = useRef<DuplicateReviewFilter>(groupsFilter)
  const groupsOffsetRef = useRef<number>(groupsOffset)

  useEffect(() => {
    selectedGroupRef.current = selectedGroup
  }, [selectedGroup])

  useEffect(() => {
    groupsFilterRef.current = groupsFilter
  }, [groupsFilter])

  useEffect(() => {
    groupsOffsetRef.current = groupsOffset
  }, [groupsOffset])

  const fetchMembers = useCallback(
    async (group: DuplicateGroupSummary, offset: number) => {
      const token = ++selectionTokenRef.current
      // Clear obsolete members immediately on new request
      setMembers([])
      setTotalMembers(0)
      setIsLoadingMembers(true)
      setMembersError(null)

      try {
        const response = await window.api.getDuplicateGroupMembers({
          sha256: group.sha256,
          byteSize: group.byteSize,
          offset,
          limit: membersLimit
        })

        if (!isMountedRef.current || token !== selectionTokenRef.current) return

        setMembers(response.items)
        setTotalMembers(response.totalCount)
        setMembersOffset(response.offset)

        setSelectedGroup((prev) => {
          if (prev && prev.sha256 === group.sha256 && prev.byteSize === group.byteSize) {
            return {
              ...prev,
              groupSignature: response.groupSignature,
              reviewStatus: response.reviewStatus,
              preferredLocationId: response.preferredLocationId,
              hasStaleDecision: response.hasStaleDecision,
              reviewedAtMs: response.reviewedAtMs ?? null
            }
          }
          return prev
        })
      } catch (err) {
        if (isMountedRef.current && token === selectionTokenRef.current) {
          setMembers([])
          setTotalMembers(0)
          setMembersError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (isMountedRef.current && token === selectionTokenRef.current) {
          setIsLoadingMembers(false)
        }
      }
    },
    [membersLimit]
  )

  const fetchGroups = useCallback(
    async (initialOffset: number, filter: DuplicateReviewFilter) => {
      const token = ++groupsTokenRef.current
      setIsLoadingGroups(true)
      setGroupsError(null)

      try {
        let offset = initialOffset
        let response = await window.api.getDuplicateGroups({
          offset,
          limit: groupsLimit,
          filter
        })

        if (!isMountedRef.current || token !== groupsTokenRef.current) return

        // Auto-recover from out-of-range page if results shrank
        if (response.totalCount > 0 && response.items.length === 0 && offset > 0) {
          offset = Math.floor((response.totalCount - 1) / groupsLimit) * groupsLimit
          response = await window.api.getDuplicateGroups({
            offset,
            limit: groupsLimit,
            filter
          })
          if (!isMountedRef.current || token !== groupsTokenRef.current) return
        }

        setGroups(response.items)
        setTotalGroups(response.totalCount)
        setGroupsOffset(response.offset)

        // Purely compute next selection outside state updater callbacks
        const current = selectedGroupRef.current
        let nextSelected: DuplicateGroupSummary | null = null

        if (current) {
          const match = response.items.find(
            (g) => g.sha256 === current.sha256 && g.byteSize === current.byteSize
          )
          if (match) {
            nextSelected = match
          } else if (response.items.length > 0) {
            nextSelected = response.items[0]!
          }
        } else if (response.items.length > 0) {
          nextSelected = response.items[0]!
        }

        setSelectedGroup(nextSelected)

        if (nextSelected) {
          void fetchMembers(nextSelected, 0)
        } else {
          // Invalidate any in-flight member requests and cleanly reset member state
          selectionTokenRef.current++
          setIsLoadingMembers(false)
          setMembersError(null)
          setMembers([])
          setTotalMembers(0)
        }
      } catch (err) {
        if (isMountedRef.current && token === groupsTokenRef.current) {
          setGroupsError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (isMountedRef.current && token === groupsTokenRef.current) {
          setIsLoadingGroups(false)
        }
      }
    },
    [fetchMembers, groupsLimit]
  )

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      // Invalidate request generations on unmount
      groupsTokenRef.current += 1
      selectionTokenRef.current += 1
    }
  }, [])

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
      setMembers([])
      setTotalMembers(0)
      setMembersError(null)
      void fetchMembers(group, 0)
    },
    [fetchMembers]
  )

  const setFilter = useCallback((filter: DuplicateReviewFilter) => {
    selectionTokenRef.current++
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
      const current = selectedGroupRef.current
      if (current) {
        void fetchMembers(current, newOffset)
      }
    },
    [fetchMembers]
  )

  const submitReview = useCallback(
    async (status: 'unreviewed' | 'reviewed', preferredLocationId?: number | null) => {
      const current = selectedGroupRef.current
      if (!current) return
      const targetSha256 = current.sha256
      const targetByteSize = current.byteSize
      const targetSig = current.groupSignature

      setIsSavingReview(true)
      setActionError(null)

      try {
        const response = await window.api.setDuplicateReview({
          sha256: targetSha256,
          byteSize: targetByteSize,
          status,
          preferredLocationId: preferredLocationId ?? null,
          expectedGroupSignature: targetSig
        })

        if (!isMountedRef.current) return

        const activeFilter = groupsFilterRef.current
        const statusMatchesFilter =
          activeFilter === 'all' ||
          (activeFilter === 'unreviewed' && response.status === 'unreviewed') ||
          (activeFilter === 'reviewed' && response.status === 'reviewed')

        if (!statusMatchesFilter) {
          // Item no longer belongs in active filtered view: reload groups and update totals
          void fetchGroups(groupsOffsetRef.current, activeFilter)
        } else {
          // Update groups list item in place
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
        }

        // Protect against stale async completion: only update selectedGroup if user is still on this group
        // and its signature was not refreshed to a newer state while saving
        if (
          selectedGroupRef.current &&
          selectedGroupRef.current.sha256 === response.sha256 &&
          selectedGroupRef.current.byteSize === response.byteSize &&
          selectedGroupRef.current.groupSignature === targetSig
        ) {
          setSelectedGroup((prev) =>
            prev &&
            prev.sha256 === response.sha256 &&
            prev.byteSize === response.byteSize &&
            prev.groupSignature === targetSig
              ? {
                  ...prev,
                  reviewStatus: response.status,
                  preferredLocationId: response.preferredLocationId,
                  groupSignature: response.groupSignature,
                  hasStaleDecision: false,
                  reviewedAtMs: response.reviewedAtMs
                }
              : prev
          )

          setMembers((prev) =>
            prev.map((m) => ({
              ...m,
              isPreferred:
                response.preferredLocationId !== null &&
                m.fileLocationId === response.preferredLocationId
            }))
          )
        }
      } catch (err) {
        if (
          isMountedRef.current &&
          selectedGroupRef.current &&
          selectedGroupRef.current.sha256 === targetSha256 &&
          selectedGroupRef.current.byteSize === targetByteSize &&
          selectedGroupRef.current.groupSignature === targetSig
        ) {
          setActionError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (isMountedRef.current) {
          setIsSavingReview(false)
        }
      }
    },
    [fetchGroups]
  )

  const refresh = useCallback(async () => {
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
