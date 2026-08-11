// main 编排：safeStorage、PKCE、loopback/custom-scheme、换 token、IPC。每应用一个实例。

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
const LEGACY_REFRESH_TOKEN_STORAGE_KEY = 'xid:refresh-token'
// 公钥客户端尚未实现 DPoP，仅 authorization_code，不含 refresh。
const DEFAULT_SCOPES = ['openid', 'profile', 'email'] as const

type StoredTokenMeta = {
  expiresAt: number
}

const SESSION_META_KEY = 'xid:session-meta'

/**
 * whenReady 中构造 -> init 注册 IPC/存储 -> 窗口关闭/退出时 dispose。
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

  #pendingPkce: PkceChallenge | null = null
  #pendingState: string | null = null

  constructor(options: XidElectronMainOptions) {
    assertAuthorizationCodeOnlyScopes(options.scopes ?? DEFAULT_SCOPES)
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

  /** custom-scheme 策略须在 whenReady 前/中注册 deep link。 */
  registerDeepLinkHandler(electronApp: import('electron').App): void {
    this.#customSchemeHandler?.register(electronApp)
  }

  async init(ipcMain: IpcMain): Promise<void> {
    await this.#storage.init()
    await this.#storage.removeItem(LEGACY_REFRESH_TOKEN_STORAGE_KEY)
    this.#storage.registerIpcHandlers(ipcMain)
    this.#registerSignInHandler(ipcMain)
    this.#registerSignOutHandler(ipcMain)
    this.#registerGetAccessTokenHandler(ipcMain)
    this.#registerGetSessionHandler(ipcMain)
    this.#registerSetTokenStorageHandler(ipcMain)
  }

  dispose(ipcMain: IpcMain): void {
    this.#storage.removeIpcHandlers(ipcMain)
    ipcMain.removeHandler(IPC_CHANNELS.SIGN_IN)
    ipcMain.removeHandler(IPC_CHANNELS.SIGN_OUT)
    ipcMain.removeHandler(IPC_CHANNELS.GET_ACCESS_TOKEN)
    ipcMain.removeHandler(IPC_CHANNELS.GET_SESSION)
    ipcMain.removeHandler(IPC_CHANNELS.SET_TOKEN_STORAGE)
  }

  #registerSignInHandler(ipcMain: IpcMain): void {
    ipcMain.handle(IPC_CHANNELS.SIGN_IN, (_event, options?: SignInOptions) =>
      this.#handleSignIn(options),
    )
  }

  #registerSignOutHandler(ipcMain: IpcMain): void {
    ipcMain.handle(IPC_CHANNELS.SIGN_OUT, () => this.#clearLocalSession())
  }

  #registerGetAccessTokenHandler(ipcMain: IpcMain): void {
    ipcMain.handle(IPC_CHANNELS.GET_ACCESS_TOKEN, () => this.#getAccessToken())
  }

  #registerGetSessionHandler(ipcMain: IpcMain): void {
    ipcMain.handle(IPC_CHANNELS.GET_SESSION, () => this.#getSession())
  }

  #registerSetTokenStorageHandler(ipcMain: IpcMain): void {
    // Shared native 契约需要此通道；IPC 模型下 storage 不可热替换，故 no-op。
    ipcMain.handle(IPC_CHANNELS.SET_TOKEN_STORAGE, () => undefined)
  }

  async #getAccessToken(): Promise<string | null> {
    const accessToken = await this.#storage.getItem(TOKEN_STORAGE_KEY)
    const metaRaw = await this.#storage.getItem(SESSION_META_KEY)

    if (!accessToken) return null

    const meta = parseStoredTokenMeta(metaRaw)
    if (meta && meta.expiresAt > Math.floor(Date.now() / 1000)) return accessToken

    await this.#clearLocalSession()
    return null
  }

  async #getSession(): Promise<{ accessToken: string; expiresAt: number } | null> {
    const accessToken = await this.#getAccessToken()
    if (!accessToken) return null

    const metaRaw = await this.#storage.getItem(SESSION_META_KEY)
    const meta = parseStoredTokenMeta(metaRaw)
    if (!meta) {
      await this.#clearLocalSession()
      return null
    }

    return { accessToken, expiresAt: meta.expiresAt }
  }

  async #storeTokens(accessToken: string, expiresIn: number): Promise<void> {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn
    const meta: StoredTokenMeta = { expiresAt }
    await Promise.all([
      this.#storage.setItem(TOKEN_STORAGE_KEY, accessToken),
      this.#storage.setItem(SESSION_META_KEY, JSON.stringify(meta)),
      this.#storage.removeItem(LEGACY_REFRESH_TOKEN_STORAGE_KEY),
    ])
  }

  async #clearLocalSession(): Promise<void> {
    await Promise.all([
      this.#storage.removeItem(TOKEN_STORAGE_KEY),
      this.#storage.removeItem(LEGACY_REFRESH_TOKEN_STORAGE_KEY),
      this.#storage.removeItem(SESSION_META_KEY),
    ])
  }

  async #handleSignIn(options?: SignInOptions): Promise<string> {
    const subtle = webcrypto.subtle
    const randomValues = (arr: Uint8Array): Uint8Array => {
      // Node 26 类型要求 Uint8Array<ArrayBuffer>；必要时拷入再写回。
      const view =
        arr.buffer instanceof ArrayBuffer
          ? new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
          : new Uint8Array(arr)
      webcrypto.getRandomValues(view)
      if (view !== arr) arr.set(view)
      return arr
    }

    const pkce = await generatePkceChallenge(subtle as SubtleCrypto, randomValues)
    const state = generateState(randomValues)
    this.#pendingPkce = pkce
    this.#pendingState = state

    const callbackServer = await this.#resolveCallbackServer()
    const scopes = [...this.#options.scopes, ...(options?.scopes ?? [])]
    assertAuthorizationCodeOnlyScopes(scopes)
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
      // state 不匹配时立刻清 PKCE，防被篡改的流程复用 verifier。
      this.#pendingPkce = null
      this.#pendingState = null
      throw new Error('[xid-electron] state mismatch - possible CSRF attack')
    }
    if (!this.#pendingPkce) {
      throw new Error('[xid-electron] no pending PKCE challenge')
    }

    const codeVerifier = this.#pendingPkce.codeVerifier
    // verifier 一次性使用，换 token 前立即清除。
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

    const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600

    await this.#storeTokens(accessToken, expiresIn)
    return accessToken
  }

  async #resolveCallbackServer(): Promise<LoopbackCallbackServer> {
    if (this.#options.callbackStrategy === 'custom-scheme' && this.#customSchemeHandler) {
      return this.#customSchemeHandler.asCallbackServer()
    }
    return startLoopbackServer()
  }
}

function parseStoredTokenMeta(raw: string | null): StoredTokenMeta | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StoredTokenMeta>
    if (
      typeof parsed.expiresAt !== 'number' ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt <= 0
    ) {
      return null
    }
    return { expiresAt: parsed.expiresAt }
  } catch {
    return null
  }
}

function assertAuthorizationCodeOnlyScopes(scopes: readonly string[]): void {
  if (scopes.includes('offline_access')) {
    throw new TypeError(
      '[xid-electron] offline_access requires DPoP sender binding, which this SDK does not implement',
    )
  }
}

function defaultStorageDir(): string {
  // 生产走 userData；测试等 Electron 未初始化场景才回落到相对路径。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron')
    if (electron.app?.getPath) {
      return `${electron.app.getPath('userData')}/xid-tokens`
    }
  } catch {
    // Electron 不可用。
  }
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
