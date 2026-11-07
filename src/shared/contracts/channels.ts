export const IPC_CHANNELS = {
  APP_GET_INFO: 'app:get-info',
  VAULT_GET_STATUS: 'vault:get-status',
  NAVIGATE_SET_TAB: 'navigation:set-tab',
  SCAN_SELECT_ROOTS: 'scan:select-roots',
  SCAN_START_JOB: 'scan:start-job',
  SCAN_PAUSE_JOB: 'scan:pause-job',
  SCAN_RESUME_JOB: 'scan:resume-job',
  SCAN_CANCEL_JOB: 'scan:cancel-job',
  SCAN_GET_ACTIVE_JOB: 'scan:get-active-job',
  SCAN_PROGRESS_EVENT: 'scan:progress-event'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
