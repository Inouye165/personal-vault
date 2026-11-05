import { session, WebContents } from 'electron'

export function setupSecurityPolicies(): void {
  // Apply strict Content Security Policy (CSP) headers to all session web requests
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'"
        ]
      }
    })
  })

  // Deny all permission requests (camera, mic, geolocation, notifications)
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
}

export function secureWebContents(webContents: WebContents): void {
  // Prevent any navigation away from the local application
  webContents.on('will-navigate', (event, navigationUrl) => {
    // Only allow navigating within file:// or dev server (localhost)
    const parsed = new URL(navigationUrl)
    const isDevUrl = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    if (parsed.protocol !== 'file:' && !isDevUrl) {
      event.preventDefault()
    }
  })

  // Deny all new window creations (e.g. window.open, target="_blank")
  webContents.setWindowOpenHandler(({ url }) => {
    console.warn(`Denied opening external window to URL: ${url}`)
    return { action: 'deny' }
  })
}
