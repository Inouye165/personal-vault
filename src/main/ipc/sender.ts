import { isTrustedAppUrl, type AppLocation } from '../navigation'

/** The parts of Electron's IpcMainInvokeEvent that sender validation relies on. */
export interface IpcSenderEvent {
  readonly sender: { readonly id: number }
  readonly senderFrame: { readonly url: string; readonly parent: unknown } | null
}

export type SenderValidator = (event: IpcSenderEvent) => boolean

export interface SenderValidatorOptions {
  /** Returns the id of the application window's WebContents, or undefined if none exists. */
  readonly getTrustedWebContentsId: () => number | undefined
  readonly location: AppLocation
}

/**
 * Accepts a request only from the top-level frame of the application window,
 * and only while that frame is showing the trusted application document.
 */
export function createSenderValidator(options: SenderValidatorOptions): SenderValidator {
  return (event) => {
    const trustedId = options.getTrustedWebContentsId()
    if (trustedId === undefined || event.sender.id !== trustedId) return false

    const frame = event.senderFrame
    if (!frame || frame.parent !== null) return false

    return isTrustedAppUrl(options.location, frame.url)
  }
}
