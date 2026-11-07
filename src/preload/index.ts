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
  type ScanJobProgress
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
  }
}

// A failure here is deliberately not swallowed: Electron reports it as a preload error.
contextBridge.exposeInMainWorld('api', api)
