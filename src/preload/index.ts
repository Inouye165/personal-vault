import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/contracts/channels.js'
import {
  AppInfoSchema,
  NavigationTabSchema,
  TabAckSchema,
  VaultStatusSchema,
  SelectRootsResponseSchema,
  StartScanRequestSchema,
  JobIdRequestSchema,
  JobActionResponseSchema,
  GetActiveJobResponseSchema,
  GetLatestJobResponseSchema,
  DismissJobRequestSchema,
  DismissJobResponseSchema,
  ScanJobProgressSchema,
  GetDuplicateGroupsRequestSchema,
  GetDuplicateGroupsResponseSchema,
  GetDuplicateGroupMembersRequestSchema,
  GetDuplicateGroupMembersResponseSchema,
  SetDuplicateReviewRequestSchema,
  SetDuplicateReviewResponseSchema,
  SelectVaultDirectoryResponseSchema,
  InitializeVaultRequestSchema,
  InitializeVaultResponseSchema,
  GetActiveVaultResponseSchema,
  SetActiveVaultRequestSchema,
  SetActiveVaultResponseSchema,
  GetImportCandidatesRequestSchema,
  GetImportCandidatesResponseSchema,
  StartImportRequestSchema,
  StartImportResponseSchema,
  VaultImportProgressSchema,
  GetActiveImportJobResponseSchema,
  GetLatestImportJobResponseSchema,
  VaultImportActionResponseSchema,
  validatePayload,
  type AppInfo,
  type NavigationTab,
  type VaultStatus,
  type SelectRootsResponse,
  type StartScanRequest,
  type JobActionResponse,
  type GetActiveJobResponse,
  type GetLatestJobResponse,
  type DismissJobResponse,
  type ScanJobProgress,
  type GetDuplicateGroupsRequest,
  type GetDuplicateGroupsResponse,
  type GetDuplicateGroupMembersRequest,
  type GetDuplicateGroupMembersResponse,
  type SetDuplicateReviewRequest,
  type SetDuplicateReviewResponse,
  type SelectVaultDirectoryResponse,
  type InitializeVaultRequest,
  type InitializeVaultResponse,
  type GetActiveVaultResponse,
  type SetActiveVaultRequest,
  type SetActiveVaultResponse,
  type GetImportCandidatesRequest,
  type GetImportCandidatesResponse,
  type StartImportRequest,
  type StartImportResponse,
  type VaultImportProgress,
  type GetActiveImportJobResponse,
  type GetLatestImportJobResponse,
  type VaultImportActionResponse
} from '../shared/validation/ipc-schemas.js'
import type { VaultApi } from './index.d.js'

const api: VaultApi = {
  async getAppInfo(): Promise<AppInfo> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.APP_GET_INFO)
    const result = validatePayload(AppInfoSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid AppInfo payload from main: ${result.error}`)
    }
    return result.data
  },

  async getVaultStatus(): Promise<VaultStatus> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_GET_STATUS)
    const result = validatePayload(VaultStatusSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid VaultStatus payload from main: ${result.error}`)
    }
    return result.data
  },

  async setTab(tab: NavigationTab): Promise<boolean> {
    const parsedTab = validatePayload(NavigationTabSchema, tab)
    if (!parsedTab.success) {
      throw new Error(`Invalid tab name provided: ${parsedTab.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.NAVIGATE_SET_TAB, parsedTab.data)
    const ack = validatePayload(TabAckSchema, raw)
    if (!ack.success) {
      throw new Error(`Invalid setTab acknowledgement from main: ${ack.error}`)
    }
    return ack.data
  },

  async selectRoots(): Promise<SelectRootsResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_SELECT_ROOTS)
    const result = validatePayload(SelectRootsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid selectRoots response from main: ${result.error}`)
    }
    return result.data
  },

  async startScan(request: StartScanRequest): Promise<JobActionResponse> {
    const parsed = validatePayload(StartScanRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid startScan request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_START_JOB, parsed.data)
    const result = validatePayload(JobActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid startScan response from main: ${result.error}`)
    }
    return result.data
  },

  async pauseScan(jobId: number): Promise<JobActionResponse> {
    const parsed = validatePayload(JobIdRequestSchema, { jobId })
    if (!parsed.success) {
      throw new Error(`Invalid pauseScan request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_PAUSE_JOB, parsed.data)
    const result = validatePayload(JobActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid pauseScan response from main: ${result.error}`)
    }
    return result.data
  },

  async resumeScan(jobId: number): Promise<JobActionResponse> {
    const parsed = validatePayload(JobIdRequestSchema, { jobId })
    if (!parsed.success) {
      throw new Error(`Invalid resumeScan request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_RESUME_JOB, parsed.data)
    const result = validatePayload(JobActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid resumeScan response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelScan(jobId: number): Promise<JobActionResponse> {
    const parsed = validatePayload(JobIdRequestSchema, { jobId })
    if (!parsed.success) {
      throw new Error(`Invalid cancelScan request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_CANCEL_JOB, parsed.data)
    const result = validatePayload(JobActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelScan response from main: ${result.error}`)
    }
    return result.data
  },

  async getActiveScanJob(): Promise<GetActiveJobResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_GET_ACTIVE_JOB)
    const result = validatePayload(GetActiveJobResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getActiveScanJob response from main: ${result.error}`)
    }
    return result.data
  },

  async getLatestScanJob(): Promise<GetLatestJobResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_GET_LATEST_JOB)
    const result = validatePayload(GetLatestJobResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getLatestScanJob response from main: ${result.error}`)
    }
    return result.data
  },

  async dismissScanJob(jobId: number): Promise<DismissJobResponse> {
    const parsed = validatePayload(DismissJobRequestSchema, { jobId })
    if (!parsed.success) {
      throw new Error(`Invalid dismissScanJob request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_DISMISS_JOB, parsed.data)
    const result = validatePayload(DismissJobResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid dismissScanJob response from main: ${result.error}`)
    }
    return result.data
  },

  onScanProgress(callback: (progress: ScanJobProgress) => void): () => void {
    const listener = (_event: unknown, raw: unknown): void => {
      const result = validatePayload(ScanJobProgressSchema, raw)
      if (result.success) {
        callback(result.data)
      } else {
        console.error(`Invalid ScanJobProgress event payload from main: ${result.error}`)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.SCAN_PROGRESS_EVENT, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SCAN_PROGRESS_EVENT, listener)
    }
  },

  async getDuplicateGroups(
    request: GetDuplicateGroupsRequest = { offset: 0, limit: 20 }
  ): Promise<GetDuplicateGroupsResponse> {
    const parsed = validatePayload(GetDuplicateGroupsRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getDuplicateGroups request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DUPLICATES_GET_GROUPS, parsed.data)
    const result = validatePayload(GetDuplicateGroupsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getDuplicateGroups response from main: ${result.error}`)
    }
    return result.data
  },

  async getDuplicateGroupMembers(
    request: GetDuplicateGroupMembersRequest
  ): Promise<GetDuplicateGroupMembersResponse> {
    const parsed = validatePayload(GetDuplicateGroupMembersRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getDuplicateGroupMembers request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DUPLICATES_GET_MEMBERS, parsed.data)
    const result = validatePayload(GetDuplicateGroupMembersResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getDuplicateGroupMembers response from main: ${result.error}`)
    }
    return result.data
  },

  async setDuplicateReview(
    request: SetDuplicateReviewRequest
  ): Promise<SetDuplicateReviewResponse> {
    const parsed = validatePayload(SetDuplicateReviewRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid setDuplicateReview request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DUPLICATES_SET_REVIEW, parsed.data)
    const result = validatePayload(SetDuplicateReviewResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid setDuplicateReview response from main: ${result.error}`)
    }
    return result.data
  },

  async selectVaultDirectory(): Promise<SelectVaultDirectoryResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_SELECT_DIRECTORY)
    const result = validatePayload(SelectVaultDirectoryResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid selectVaultDirectory response from main: ${result.error}`)
    }
    return result.data
  },

  async initializeVault(request: InitializeVaultRequest): Promise<InitializeVaultResponse> {
    const parsed = validatePayload(InitializeVaultRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid initializeVault request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_INITIALIZE, parsed.data)
    const result = validatePayload(InitializeVaultResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid initializeVault response from main: ${result.error}`)
    }
    return result.data
  },

  async getActiveVault(): Promise<GetActiveVaultResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_GET_ACTIVE)
    const result = validatePayload(GetActiveVaultResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getActiveVault response from main: ${result.error}`)
    }
    return result.data
  },

  async setActiveVault(request: SetActiveVaultRequest): Promise<SetActiveVaultResponse> {
    const parsed = validatePayload(SetActiveVaultRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid setActiveVault request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_SET_ACTIVE, parsed.data)
    const result = validatePayload(SetActiveVaultResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid setActiveVault response from main: ${result.error}`)
    }
    return result.data
  },

  async getImportCandidates(
    request: GetImportCandidatesRequest
  ): Promise<GetImportCandidatesResponse> {
    const parsed = validatePayload(GetImportCandidatesRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getImportCandidates request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_GET_IMPORT_CANDIDATES, parsed.data)
    const result = validatePayload(GetImportCandidatesResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getImportCandidates response from main: ${result.error}`)
    }
    return result.data
  },

  async startImport(request: StartImportRequest): Promise<StartImportResponse> {
    const parsed = validatePayload(StartImportRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid startImport request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_START_IMPORT, parsed.data)
    const result = validatePayload(StartImportResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid startImport response from main: ${result.error}`)
    }
    return result.data
  },

  async pauseImport(): Promise<VaultImportActionResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_PAUSE_IMPORT)
    const result = validatePayload(VaultImportActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid pauseImport response from main: ${result.error}`)
    }
    return result.data
  },

  async resumeImport(jobId?: string): Promise<VaultImportActionResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_RESUME_IMPORT, { jobId })
    const result = validatePayload(VaultImportActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid resumeImport response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelImport(): Promise<VaultImportActionResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_CANCEL_IMPORT)
    const result = validatePayload(VaultImportActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelImport response from main: ${result.error}`)
    }
    return result.data
  },

  async getActiveImportJob(): Promise<GetActiveImportJobResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_GET_ACTIVE_IMPORT)
    const result = validatePayload(GetActiveImportJobResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getActiveImportJob response from main: ${result.error}`)
    }
    return result.data
  },

  async getLatestImportJob(): Promise<GetLatestImportJobResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_GET_LATEST_IMPORT)
    const result = validatePayload(GetLatestImportJobResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getLatestImportJob response from main: ${result.error}`)
    }
    return result.data
  },

  onImportProgress(callback: (progress: VaultImportProgress) => void): () => void {
    const listener = (_event: unknown, raw: unknown): void => {
      const result = validatePayload(VaultImportProgressSchema, raw)
      if (result.success) {
        callback(result.data)
      } else {
        console.error(`Invalid VaultImportProgress event payload from main: ${result.error}`)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.VAULT_PROGRESS_EVENT, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.VAULT_PROGRESS_EVENT, listener)
    }
  }
}

// A failure here is deliberately not swallowed: Electron reports it as a preload error.
contextBridge.exposeInMainWorld('api', api)
