/**
 * Personal Vault — Stage 8B Slice 3: Google Drive Auth & Folder Service
 *
 * Manages OAuth 2.0 sign-in, token refresh, encrypted token storage (via Electron
 * `safeStorage` or an injected store), expired-authorization state, and Drive
 * backup folder listing/creation. OAuth tokens are strictly kept in the main
 * process and are never returned to the renderer or written to logs.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { shell } from 'electron'
import { z } from 'zod'
import { BackupSnapshotError } from './errors'
import { GOOGLE_DRIVE_API_BASE_URL } from './google-drive-transport'

const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
const GOOGLE_DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'

export type GoogleDriveAuthStatusState = 'disconnected' | 'connected' | 'expired'

export interface GoogleDriveAccountStatus {
  readonly status: GoogleDriveAuthStatusState
  readonly accountEmail: string | null
  readonly accountDisplayName: string | null
  readonly lastError: string | null
}

export interface GoogleDriveFolderSummary {
  readonly id: string
  readonly name: string
}

export interface StoredOAuthTokens {
  readonly accessToken: string
  readonly refreshToken: string | null
  readonly expiresAtMs: number
  readonly accountEmail: string | null
  readonly accountDisplayName: string | null
  readonly status: 'connected' | 'expired'
  readonly lastError: string | null
}

const StoredOAuthTokensSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string().nullable(),
    expiresAtMs: z.number().int().nonnegative(),
    accountEmail: z.string().nullable(),
    accountDisplayName: z.string().nullable(),
    status: z.enum(['connected', 'expired']),
    lastError: z.string().nullable()
  })
  .strict()

export interface GoogleDriveTokenStore {
  load(): StoredOAuthTokens | null
  save(tokens: StoredOAuthTokens): void
  clear(): void
}

export interface GoogleDriveSignInResult {
  readonly accessToken: string
  readonly refreshToken: string | null
  readonly expiresInSeconds: number
  readonly accountEmail: string | null
  readonly accountDisplayName: string | null
}

export interface GoogleDriveAuthServiceOptions {
  readonly tokenStore?: GoogleDriveTokenStore
  readonly tokenFilePath?: string
  readonly safeStorage?: {
    isEncryptionAvailable(): boolean
    encryptString(plainText: string): Buffer
    decryptString(encrypted: Buffer): string
  }
  readonly clientId?: string
  readonly clientSecret?: string
  readonly fetchFn?: typeof fetch
  readonly apiBaseUrl?: string
  readonly signInFlow?: () => Promise<GoogleDriveSignInResult>
  readonly refreshFlow?: (refreshToken: string) => Promise<{
    readonly accessToken: string
    readonly expiresInSeconds: number
    readonly refreshToken?: string | null
  }>
  readonly nowMs?: () => number
}

function createSafeStorageTokenStore(
  filePath: string,
  safeStorageApi?: GoogleDriveAuthServiceOptions['safeStorage']
): GoogleDriveTokenStore {
  return {
    load(): StoredOAuthTokens | null {
      if (!existsSync(filePath)) return null
      try {
        const raw = readFileSync(filePath)
        let jsonText: string
        if (safeStorageApi?.isEncryptionAvailable()) {
          jsonText = safeStorageApi.decryptString(raw)
        } else {
          return null
        }
        return StoredOAuthTokensSchema.parse(JSON.parse(jsonText))
      } catch {
        return null
      }
    },
    save(tokens: StoredOAuthTokens): void {
      if (!safeStorageApi?.isEncryptionAvailable()) {
        throw new BackupSnapshotError(
          'destination_access_denied',
          'OS credential encryption (safeStorage) is unavailable for storing Google Drive tokens'
        )
      }
      mkdirSync(dirname(filePath), { recursive: true })
      const encrypted = safeStorageApi.encryptString(JSON.stringify(tokens))
      writeFileSync(filePath, encrypted)
    },
    clear(): void {
      try {
        if (existsSync(filePath)) rmSync(filePath, { force: true })
      } catch {
        // ignore best-effort clear
      }
    }
  }
}

function escapeDriveQuery(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export class GoogleDriveAuthService {
  private readonly tokenStore: GoogleDriveTokenStore
  private readonly clientId?: string
  private readonly clientSecret?: string
  private readonly fetchFn: typeof fetch
  private readonly apiBaseUrl: string
  private readonly signInFlow?: GoogleDriveAuthServiceOptions['signInFlow']
  private readonly refreshFlow?: GoogleDriveAuthServiceOptions['refreshFlow']
  private readonly nowMs: () => number

  private cachedTokens: StoredOAuthTokens | null = null
  private authGeneration = 0

  public constructor(options: GoogleDriveAuthServiceOptions = {}) {
    if (options.tokenStore) {
      this.tokenStore = options.tokenStore
    } else if (options.tokenFilePath) {
      this.tokenStore = createSafeStorageTokenStore(options.tokenFilePath, options.safeStorage)
    } else {
      let mem: StoredOAuthTokens | null = null
      this.tokenStore = {
        load: () => mem,
        save: (t) => {
          mem = t
        },
        clear: () => {
          mem = null
        }
      }
    }
    this.clientId = options.clientId ?? process.env.PV_GOOGLE_CLIENT_ID
    this.clientSecret = options.clientSecret ?? process.env.PV_GOOGLE_CLIENT_SECRET
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.apiBaseUrl = (options.apiBaseUrl ?? GOOGLE_DRIVE_API_BASE_URL).replace(/\/+$/, '')
    this.signInFlow = options.signInFlow
    this.refreshFlow = options.refreshFlow
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.cachedTokens = this.tokenStore.load()
  }

  public getStatus(): GoogleDriveAccountStatus {
    const tokens = this.cachedTokens ?? this.tokenStore.load()
    this.cachedTokens = tokens
    if (!tokens) {
      return {
        status: 'disconnected',
        accountEmail: null,
        accountDisplayName: null,
        lastError: null
      }
    }
    return {
      status: tokens.status,
      accountEmail: tokens.accountEmail,
      accountDisplayName: tokens.accountDisplayName,
      lastError: tokens.lastError
    }
  }

  public async connect(): Promise<GoogleDriveAccountStatus> {
    const startGeneration = ++this.authGeneration
    const res = this.signInFlow ? await this.signInFlow() : await this.runPkceLoopbackSignIn()
    if (this.authGeneration !== startGeneration) {
      return this.getStatus()
    }
    const tokens: StoredOAuthTokens = {
      accessToken: res.accessToken,
      refreshToken: res.refreshToken,
      expiresAtMs: this.nowMs() + Math.max(60, res.expiresInSeconds) * 1000,
      accountEmail: res.accountEmail,
      accountDisplayName: res.accountDisplayName,
      status: 'connected',
      lastError: null
    }
    this.tokenStore.save(tokens)
    this.cachedTokens = tokens
    return this.getStatus()
  }

  public disconnect(): GoogleDriveAccountStatus {
    this.authGeneration += 1
    this.cachedTokens = null
    this.tokenStore.clear()
    return this.getStatus()
  }

  public markAuthorizationExpired(
    reason = 'Google Drive authorization expired; reconnect required'
  ): void {
    const current = this.cachedTokens ?? this.tokenStore.load()
    if (!current) return
    const updated: StoredOAuthTokens = {
      ...current,
      accessToken: '',
      expiresAtMs: 0,
      status: 'expired',
      lastError: reason
    }
    this.cachedTokens = updated
    this.tokenStore.save(updated)
  }

  public async getAccessToken(): Promise<string> {
    const current = this.cachedTokens ?? this.tokenStore.load()
    this.cachedTokens = current
    if (!current) {
      throw new BackupSnapshotError(
        'destination_access_denied',
        'Google Drive account is not connected'
      )
    }
    if (current.status === 'expired') {
      throw new BackupSnapshotError(
        'destination_access_denied',
        current.lastError ?? 'Google Drive authorization expired; please reconnect your account'
      )
    }

    const now = this.nowMs()
    if (current.accessToken && current.expiresAtMs - now > 60_000) {
      return current.accessToken
    }

    if (!current.refreshToken) {
      this.markAuthorizationExpired('Google Drive session expired; please reconnect your account')
      throw new BackupSnapshotError(
        'destination_access_denied',
        'Google Drive session expired; please reconnect your account'
      )
    }

    const refreshGeneration = this.authGeneration
    try {
      const refreshed = this.refreshFlow
        ? await this.refreshFlow(current.refreshToken)
        : await this.runTokenRefresh(current.refreshToken)
      if (this.authGeneration !== refreshGeneration) {
        throw new BackupSnapshotError(
          'destination_access_denied',
          'Google Drive authorization was disconnected or superseded during token refresh'
        )
      }
      const nextTokens: StoredOAuthTokens = {
        ...current,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? current.refreshToken,
        expiresAtMs: this.nowMs() + Math.max(60, refreshed.expiresInSeconds) * 1000,
        status: 'connected',
        lastError: null
      }
      this.tokenStore.save(nextTokens)
      this.cachedTokens = nextTokens
      return nextTokens.accessToken
    } catch (err) {
      if (this.authGeneration !== refreshGeneration) {
        if (err instanceof BackupSnapshotError && err.code === 'destination_access_denied') {
          throw err
        }
        throw new BackupSnapshotError(
          'destination_access_denied',
          'Google Drive authorization was disconnected or superseded during token refresh'
        )
      }
      const msg = err instanceof Error ? err.message : String(err)
      this.markAuthorizationExpired(`Google Drive authorization expired: ${msg}`)
      throw new BackupSnapshotError(
        'destination_access_denied',
        `Google Drive authorization expired; please reconnect your account (${msg})`
      )
    }
  }

  public async listFolders(parentId = 'root'): Promise<GoogleDriveFolderSummary[]> {
    const token = await this.getAccessToken()
    const q = `'${escapeDriveQuery(parentId)}' in parents and mimeType = '${DRIVE_FOLDER_MIME_TYPE}' and trashed = false`
    const params = new URLSearchParams({
      q,
      fields: 'files(id,name)',
      spaces: 'drive',
      orderBy: 'name',
      pageSize: '200'
    })
    const res = await this.fetchWithAuthRetry(
      `${this.apiBaseUrl}/files?${params.toString()}`,
      { method: 'GET' },
      token
    )
    if (!res.ok) {
      throw new BackupSnapshotError(
        res.status === 401 || res.status === 403
          ? 'destination_access_denied'
          : 'destination_unavailable',
        `Failed to list Google Drive folders (${res.status})`
      )
    }
    const data = (await res.json()) as { files?: Array<{ id: string; name: string }> }
    return (data.files ?? []).map((f) => ({ id: f.id, name: f.name }))
  }

  public async createFolder(name: string, parentId = 'root'): Promise<GoogleDriveFolderSummary> {
    const trimmed = name.trim()
    if (!trimmed) {
      throw new Error('Folder name must not be empty')
    }
    const token = await this.getAccessToken()
    const res = await this.fetchWithAuthRetry(
      `${this.apiBaseUrl}/files`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({
          name: trimmed,
          mimeType: DRIVE_FOLDER_MIME_TYPE,
          parents: [parentId]
        })
      },
      token
    )
    if (!res.ok) {
      throw new BackupSnapshotError(
        res.status === 401 || res.status === 403
          ? 'destination_access_denied'
          : 'destination_write_failed',
        `Failed to create Google Drive folder "${trimmed}" (${res.status})`
      )
    }
    const created = (await res.json()) as { id: string; name: string }
    return { id: created.id, name: created.name }
  }

  private async fetchWithAuthRetry(
    url: string,
    init: RequestInit,
    initialToken: string
  ): Promise<Response> {
    const send = async (tok: string): Promise<Response> =>
      this.fetchFn(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${tok}`
        }
      })

    let res = await send(initialToken)
    if (res.status === 401) {
      // Force refresh attempt if refresh token is available; if refresh fails, marks expired
      const current = this.cachedTokens ?? this.tokenStore.load()
      if (current?.refreshToken) {
        this.cachedTokens = { ...current, expiresAtMs: 0 }
        const freshToken = await this.getAccessToken()
        res = await send(freshToken)
      }
      if (res.status === 401) {
        this.markAuthorizationExpired('Google Drive returned 401 Unauthorized; reconnect required')
      }
    }
    return res
  }

  private async runTokenRefresh(refreshToken: string): Promise<{
    readonly accessToken: string
    readonly expiresInSeconds: number
    readonly refreshToken?: string | null
  }> {
    if (!this.clientId) {
      throw new Error('Google OAuth client ID is not configured (PV_GOOGLE_CLIENT_ID)')
    }
    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
    if (this.clientSecret) {
      body.set('client_secret', this.clientSecret)
    }
    const res = await this.fetchFn(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })
    if (!res.ok) {
      throw new Error(`Token refresh failed (${res.status})`)
    }
    const data = (await res.json()) as {
      access_token: string
      expires_in?: number
      refresh_token?: string
    }
    return {
      accessToken: data.access_token,
      expiresInSeconds: data.expires_in ?? 3600,
      refreshToken: data.refresh_token ?? null
    }
  }

  private async runPkceLoopbackSignIn(): Promise<GoogleDriveSignInResult> {
    if (!this.clientId) {
      throw new BackupSnapshotError(
        'destination_access_denied',
        'Google Drive OAuth client ID is not configured (set PV_GOOGLE_CLIENT_ID)'
      )
    }

    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const state = randomBytes(16).toString('hex')

    const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
      (resolve, reject) => {
        const server = createServer((req, res) => {
          try {
            const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
            if (reqUrl.pathname !== '/oauth2callback') {
              res.writeHead(404).end('Not found')
              return
            }
            const errParam = reqUrl.searchParams.get('error')
            if (errParam) {
              res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Authorization denied.')
              server.close()
              reject(
                new BackupSnapshotError('destination_access_denied', `OAuth error: ${errParam}`)
              )
              return
            }
            const returnedState = reqUrl.searchParams.get('state')
            const authCode = reqUrl.searchParams.get('code')
            if (returnedState !== state || !authCode) {
              res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Invalid OAuth state.')
              server.close()
              reject(
                new BackupSnapshotError('destination_access_denied', 'Invalid OAuth callback state')
              )
              return
            }
            res
              .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              .end(
                '<!doctype html><html><body><h2>Personal Vault</h2><p>Google Drive connected. You may close this tab.</p></body></html>'
              )
            const addr = server.address()
            const port = typeof addr === 'object' && addr ? addr.port : 0
            server.close()
            resolve({ code: authCode, redirectUri: `http://127.0.0.1:${port}/oauth2callback` })
          } catch (err) {
            server.close()
            reject(err)
          }
        })

        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          const port = typeof addr === 'object' && addr ? addr.port : 0
          const redirect = `http://127.0.0.1:${port}/oauth2callback`
          const authParams = new URLSearchParams({
            client_id: this.clientId!,
            redirect_uri: redirect,
            response_type: 'code',
            scope: `${GOOGLE_DRIVE_FILE_SCOPE} openid email profile`,
            access_type: 'offline',
            prompt: 'consent',
            state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256'
          })
          void shell.openExternal(`${GOOGLE_OAUTH_AUTH_URL}?${authParams.toString()}`)
        })

        server.on('error', reject)
      }
    )

    const tokenBody = new URLSearchParams({
      client_id: this.clientId,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    })
    if (this.clientSecret) {
      tokenBody.set('client_secret', this.clientSecret)
    }

    const tokenRes = await this.fetchFn(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString()
    })
    if (!tokenRes.ok) {
      throw new BackupSnapshotError(
        'destination_access_denied',
        `OAuth token exchange failed (${tokenRes.status})`
      )
    }
    const tokenJson = (await tokenRes.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
    }

    let accountEmail: string | null = null
    let accountDisplayName: string | null = null
    try {
      const userRes = await this.fetchFn(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` }
      })
      if (userRes.ok) {
        const userJson = (await userRes.json()) as { email?: string; name?: string }
        accountEmail = userJson.email ?? null
        accountDisplayName = userJson.name ?? null
      }
    } catch {
      // userinfo is optional
    }

    return {
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token ?? null,
      expiresInSeconds: tokenJson.expires_in ?? 3600,
      accountEmail,
      accountDisplayName
    }
  }
}

export function createDriveBackupFolderParentDirHint(
  backupDirName = 'Personal Vault Backup'
): string {
  return backupDirName
}
