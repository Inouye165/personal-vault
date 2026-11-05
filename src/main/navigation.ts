import { fileURLToPath } from 'node:url'
import type { WebContents } from 'electron'

/**
 * Where the trusted application UI lives. Exactly one location is trusted at a time.
 * - `file`: the built renderer document (always used when packaged).
 * - `dev`: one explicitly configured http(s) origin (only when not packaged).
 */
export type AppLocation =
  | { readonly kind: 'file'; readonly documentPath: string }
  | { readonly kind: 'dev'; readonly origin: string }

export interface ResolveAppLocationInput {
  readonly isPackaged: boolean
  readonly rendererUrl: string | undefined
  readonly documentPath: string
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

export function resolveAppLocation(input: ResolveAppLocationInput): AppLocation {
  if (!input.isPackaged && input.rendererUrl) {
    const parsed = parseUrl(input.rendererUrl)
    if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      return { kind: 'dev', origin: parsed.origin }
    }
  }
  return { kind: 'file', documentPath: input.documentPath }
}

const normalizePath = (path: string): string =>
  process.platform === 'win32' ? path.toLowerCase() : path

export function isTrustedAppUrl(location: AppLocation, url: string): boolean {
  const parsed = parseUrl(url)
  if (!parsed) return false

  if (location.kind === 'dev') {
    return parsed.origin === location.origin
  }

  if (parsed.protocol !== 'file:' || parsed.search !== '') return false
  try {
    return normalizePath(fileURLToPath(parsed)) === normalizePath(location.documentPath)
  } catch {
    return false
  }
}

interface NavigationDetails {
  readonly url: string
  preventDefault: () => void
}

/**
 * The single place where navigation and popup policy is applied to a window.
 * Popups are always denied; URLs are never forwarded to the operating system.
 */
export function secureWebContents(webContents: WebContents, location: AppLocation): void {
  const guard = (details: NavigationDetails): void => {
    if (!isTrustedAppUrl(location, details.url)) {
      details.preventDefault()
    }
  }

  webContents.on('will-navigate', guard)
  webContents.on('will-redirect', guard)
  webContents.on('will-frame-navigate', guard)
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}
