import { session } from 'electron'
import type { AppLocation } from './navigation'

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'"

export function setupSecurityPolicies(location: AppLocation): void {
  // Production loads the document from disk, where the <meta> policy in index.html applies.
  // The header policy covers HTTP(S) responses; for the development server the policy is
  // delivered by the <meta> tag instead, because Vite must be allowed to hash its inline
  // refresh preamble (see electron.vite.config.ts).
  if (location.kind === 'file') {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CONTENT_SECURITY_POLICY]
        }
      })
    })
  }

  // Deny all permission requests (camera, microphone, geolocation, notifications).
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
}
