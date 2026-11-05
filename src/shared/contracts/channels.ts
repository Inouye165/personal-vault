export const IPC_CHANNELS = {
  APP_GET_INFO: 'app:get-info',
  VAULT_GET_STATUS: 'vault:get-status',
  NAVIGATE_SET_TAB: 'navigation:set-tab'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
