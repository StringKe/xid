// Main process orchestrator: wires safeStorage, PKCE, loopback/custom-scheme,
// token exchange, and IPC handlers into a single XidElectronApp class.
//
// One instance per Electron app; created in the main process.

import type { IpcMain } from 'electron'
import { webcrypto } from 'node:crypto'

import type {
  LoopbackCallbackServer,
  PkceChallenge,
  SignInOptions,
  XidElectronMainOptions,
} from '../types'
import { IPC_CHANNELS } from '../types'
import { buildAuthorizeUrl, generatePkceChallenge, generateState, parseCallbackUrl } from '../pkce'
import { ElectronSafeStorage } from './safe-storage'
import { XidCustomSchemeHandler } from './custom-scheme'
import { startLoopbackServer } from './loopback-server'

const TOKEN_STORAGE_KEY = 'xid:access-token'
const REFRESH_TOKEN_STORAGE_KEY = 'xid:refresh-token'
// offline_access is intentionally NOT in the default scopes here because
// refresh tokens are now persisted; include it only when explicitly requested.
const DEFAULT_SCOPES = ['openid', 'profile', 'email'] as const

// Proactively refresh when within this window of expiry (seconds).
const TOKEN_REFRESH_LEEWAY_SECONDS = 30

type StoredTokenMeta = {
  expiresAt: number
}

const SESSION_META_KEY = 'xid:session-meta'

/**
 * Main-process XID application.
 *
 * Lifecycle:
 *   1. Construct during app.whenReady() with your XidElectronMainOptions.
 *   2. Call app.init(ipcMain) once to register IPC handlers and storage.
 *   3. Call app.dispose(ipcMain) on BrowserWindow close / app quit.
 */
export class XidElectronApp {
  readonly #options: Required<
    Omit<XidElectronMainOptions, 'customScheme' | 'callbackStrategy' | 'storageDir'>
  > & {
    callbackStrategy: 'loopback' | 'custom-scheme'
    customScheme: string | undefined
    storageDir: string
  }
  readonly #storage: ElectronSafeStorage
  readonly #customSchemeHandler: XidCustomSchemeHandler | null

  // In-flight PKCE state for CSRF validation.
  #pendingPkce: PkceChallenge | null = null
  #pendingState: string | null = null
  #refreshInFlight: Promise<string | null> | null = null

  constructor(options: XidElectronMainOptions) {
    this.#options = {
      issuer: options.issuer,
      clientId: options.clientId,
      callbackStrategy: options.callbackStrategy ?? 'loopback',
      customScheme: options.customScheme,
      scopes: options.scopes ?? DEFAULT_SCOPES,
      storageDir: options.storageDir ?? defaultStorageDir(),
    }
    this.#storage = new ElectronSafeStorage(this.#options.storageDir)
    this.#customSchemeHandler =
      this.#options.callbackStrategy === 'custom-scheme' && this.#options.customScheme
        ? new XidCustomSchemeHandler(this.#options.customScheme)
        : null
  }

  /**
   * Register custom-scheme deep-link handler with the Electron app.
   * Must be called before or during app.whenReady() for custom-scheme strategy.
   */
  registerDeepLinkHandler(electronApp: import('electron').App): void {
    this.#customSchemeHandler?.register(electronApp)
  }

  /**
   * Initialize storage directory and register IPC handlers.
   * Call once inside app.whenReady().
   */
  async init(ipcMain: IpcMain): Promise<void> {
    await this.#storage.init()
    this.#storage.registerIpcHandlers(ipcMain)
    this.#registerSignInHandler(ipcMain)
    this.#registerSignOutHandler(ipcMain)
    this.#registerGetAccessTokenHandler(ipcMain)
    this.#registerGetSessionHandler(ipcMain)
    this.#registerSetTokenStorageHandler(ipcMain)
  }

  /**
   * Remove all IPC handlers. Call on app quit or BrowserWindow destroyed.
   */
  dispose(ipcMain: IpcMain): void {
    this.#storage.removeIpcHandlers(ipcMain)
    ipcMain.removeHandler(IPC_CHANNELS.SIGN_IN)
    ipcMain.removeHandler(IPC_CHANNELS.SIGN_OUT)
    ipcMain.removeHandler(IPC_CHANNELS.GET_ACCESS_TOKEN)
    ipcMain.removeHandler(IPC_CHANNELS.GET_SESSION)
    ipcMain.removeHandler(IPC_CHANNELS.SET_TOKEN_STORAGE)
  }

  // ---------------------------------------------------------------------------
  // IPC handler registration (private)
  // ---------------------------------------------------------------------------

  #registerSignInHandler(ipcMain: IpcMain): void {
    ipcMain.handle(IPC_CHANNELS.SIGN_IN, (_event, options?: SignInOptions) =>
      this.#handleSignIn(options),
    )
  }

  #registerSignOutHandler(ipcMain: IpcMain): void {
    ipcMain.handle(IPC_CHANNELS.SIGN_OUT, async () => {
      await Promise.all([
        this.#storage.removeItem(TOKEN_STORAGE_KEY),
        this.#storage.removeItem(REFRESH_TOKEN_STORAGE_KEY),
        this.#storage.removeItem(SESSION_META_KEY),
      ])
    })
  }

  #registerGetAccessTokenHandler(ipcMain: IpcMain): void {
    ipcMain.handle(IPC_CHANNELS.GET_ACCESS_TOKEN, () => this.#getAccessToken())
  }

  #registerGetSessionHandler(ipcMain: IpcMain): void {
    ipcMain.handle(IPC_CHANNELS.GET_SESSION, () => this.#getSession())
  }

  #registerSetTokenStorageHandler(ipcMain: IpcMain): void {
    // For the main-process implementation, token storage is always safeStorage-backed.
    // This handler exists to satisfy the Shared native contract; it is a no-op here
    // because the storage adapter cannot be swapped at runtime in the IPC model.
    ipcMain.handle(IPC_CHANNELS.SET_TOKEN_STORAGE, () => undefined)
  }

  // ---------------------------------------------------------------------------
  // Token management
  // ---------------------------------------------------------------------------

  async #getAccessToken(): Promise<string | null> {
    const accessToken = await this.#storage.getItem(TOKEN_STORAGE_KEY)
    const metaRaw = await this.#storage.getItem(SESSION_META_KEY)

    if (!accessToken) return null

    const isExpiring = (() => {
      if (!metaRaw) return false
      try {
        const meta = JSON.parse(metaRaw) as StoredTokenMeta
        return meta.expiresAt - TOKEN_REFRESH_LEEWAY_SECONDS <= Math.floor(Date.now() / 1000)
      } catch {
        return false
      }
    })()

    if (!isExpiring) return accessToken

    // Refresh 失败(网络错误或 invalid_grant)返回 null;invalid_grant 路径已清空 storage。
    return this.#tryRefresh()
  }

  async #tryRefresh(): Promise<string | null> {
    if (this.#refreshInFlight) return this.#refreshInFlight

    const refreshInFlight = this.#refreshAccessToken()
    this.#refreshInFlight = refreshInFlight

    try {
      return await refreshInFlight
    } finally {
      if (this.#refreshInFlight === refreshInFlight) {
        this.#refreshInFlight = null
      }
    }
  }

  async #refreshAccessToken(): Promise<string | null> {
    const refreshToken = await this.#storage.getItem(REFRESH_TOKEN_STORAGE_KEY)
    if (!refreshToken) return null

    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.#options.clientId,
        refresh_token: refreshToken,
      })

      const response = await fetch(new URL('/token', this.#options.issuer).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })

      if (!response.ok) {
        // Protocol error: refresh token is invalid/revoked — clear everything.
        await Promise.all([
          this.#storage.removeItem(TOKEN_STORAGE_KEY),
          this.#storage.removeItem(REFRESH_TOKEN_STORAGE_KEY),
          this.#storage.removeItem(SESSION_META_KEY),
        ])
        return null
      }

      const json = (await response.json()) as Record<string, unknown>
      const newAccessToken = typeof json['access_token'] === 'string' ? json['access_token'] : null
      if (!newAccessToken) return null

      const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600
      const newRefreshToken =
        typeof json['refresh_token'] === 'string' ? json['refresh_token'] : null

      await this.#storeTokens(newAccessToken, newRefreshToken, expiresIn)
      return newAccessToken
    } catch {
      // Network error: preserve existing credentials, let caller use current (possibly expired) token.
      return null
    }
  }

  async #getSession(): Promise<{ accessToken: string; expiresAt: number } | null> {
    const accessToken = await this.#getAccessToken()
    if (!accessToken) return null

    const metaRaw = await this.#storage.getItem(SESSION_META_KEY)
    let expiresAt = Math.floor(Date.now() / 1000) + 3600
    if (metaRaw) {
      try {
        const meta = JSON.parse(metaRaw) as StoredTokenMeta
        expiresAt = meta.expiresAt
      } catch {
        // Corrupted meta: fall through with default expiresAt.
      }
    }

    return { accessToken, expiresAt }
  }

  async #storeTokens(
    accessToken: string,
    refreshToken: string | null,
    expiresIn: number,
  ): Promise<void> {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn
    const meta: StoredTokenMeta = { expiresAt }
    const ops: Promise<void>[] = [
      this.#storage.setItem(TOKEN_STORAGE_KEY, accessToken),
      this.#storage.setItem(SESSION_META_KEY, JSON.stringify(meta)),
    ]
    if (refreshToken) ops.push(this.#storage.setItem(REFRESH_TOKEN_STORAGE_KEY, refreshToken))
    await Promise.all(ops)
  }

  // ---------------------------------------------------------------------------
  // Sign-in flow
  // ---------------------------------------------------------------------------

  async #handleSignIn(options?: SignInOptions): Promise<string> {
    const subtle = webcrypto.subtle
    const randomValues = (arr: Uint8Array): Uint8Array => {
      webcrypto.getRandomValues(arr)
      return arr
    }

    const pkce = await generatePkceChallenge(subtle as SubtleCrypto, randomValues)
    const state = generateState(randomValues)
    this.#pendingPkce = pkce
    this.#pendingState = state

    const callbackServer = await this.#resolveCallbackServer()
    const scopes = [...this.#options.scopes, ...(options?.scopes ?? [])]
    const authorizeUrl = buildAuthorizeUrl({
      issuer: this.#options.issuer,
      clientId: this.#options.clientId,
      redirectUri: callbackServer.redirectUri,
      scopes,
      codeChallenge: pkce.codeChallenge,
      state,
      prompt: options?.prompt,
    })

    await openExternalBrowser(authorizeUrl.toString())

    // Consume the AbortSignal if provided; reject the callback wait on abort.
    let callbackUrl: URL
    try {
      callbackUrl = await (options?.signal
        ? waitWithAbort(callbackServer.waitForCallback(), options.signal)
        : callbackServer.waitForCallback())
    } finally {
      await callbackServer.close()
    }

    return this.#exchangeCode(callbackUrl, callbackServer.redirectUri)
  }

  async #exchangeCode(callbackUrl: URL, redirectUri: string): Promise<string> {
    const parsed = parseCallbackUrl(callbackUrl)
    if (!parsed) {
      const error = callbackUrl.searchParams.get('error') ?? 'unknown'
      throw new Error(`[xid-electron] sign-in failed: ${error}`)
    }

    if (!this.#pendingState || parsed.state !== this.#pendingState) {
      // Clear PKCE state to prevent reuse of a potentially tampered flow.
      this.#pendingPkce = null
      this.#pendingState = null
      throw new Error('[xid-electron] state mismatch - possible CSRF attack')
    }
    if (!this.#pendingPkce) {
      throw new Error('[xid-electron] no pending PKCE challenge')
    }

    const codeVerifier = this.#pendingPkce.codeVerifier
    // Clear PKCE verifier immediately (one-time use).
    this.#pendingPkce = null
    this.#pendingState = null

    const tokenUrl = new URL('/token', this.#options.issuer)
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: parsed.code,
      redirect_uri: redirectUri,
      client_id: this.#options.clientId,
      code_verifier: codeVerifier,
    })

    const response = await fetch(tokenUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`[xid-electron] token exchange failed (${response.status}): ${text}`)
    }

    const json = (await response.json()) as Record<string, unknown>
    const accessToken = typeof json['access_token'] === 'string' ? json['access_token'] : null
    if (!accessToken) throw new Error('[xid-electron] token response missing access_token')

    const refreshToken = typeof json['refresh_token'] === 'string' ? json['refresh_token'] : null
    const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600

    await this.#storeTokens(accessToken, refreshToken, expiresIn)
    return accessToken
  }

  async #resolveCallbackServer(): Promise<LoopbackCallbackServer> {
    if (this.#options.callbackStrategy === 'custom-scheme' && this.#customSchemeHandler) {
      return this.#customSchemeHandler.asCallbackServer()
    }
    return startLoopbackServer()
  }
}

function defaultStorageDir(): string {
  // Try to use Electron's app.getPath('userData') for production apps.
  // Fall back to a relative path only when Electron is not yet initialized
  // (e.g. in test environments that construct XidElectronApp without a real app).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron')
    if (electron.app?.getPath) {
      return `${electron.app.getPath('userData')}/xid-tokens`
    }
  } catch {
    // Electron not available in this environment.
  }
  // Explicit caller override always takes precedence; this path is only for
  // environments where Electron's app module is not initialized.
  return './xid-tokens'
}

async function openExternalBrowser(url: string): Promise<void> {
  const { shell } = (await import('electron')) as unknown as typeof import('electron')
  await shell.openExternal(url)
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('[xid-electron] sign-in aborted'))
      return
    }
    const onAbort = () => reject(new Error('[xid-electron] sign-in aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}
