// @xid-kit/electron 共享类型契约:main / renderer / preload 三端共用。
// 不 import electron -- electron 是 peerDependency,环境不同(main:Node+Electron, renderer:browser)。

// ---------------------------------------------------------------------------
// Secure storage adapter (renderer-side contract over contextBridge IPC)
// ---------------------------------------------------------------------------

/**
 * Async key-value storage backed by Electron safeStorage in the main process.
 * The renderer calls these through the contextBridge IPC bridge exposed in the
 * preload script; the main process handles the IPC and calls safeStorage.*
 */
export type SecureStorageAdapter = {
  readonly setItem: (key: string, value: string) => Promise<void>
  readonly getItem: (key: string) => Promise<string | null>
  readonly removeItem: (key: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// IPC channel names (single source of truth -- import in both main & preload)
// ---------------------------------------------------------------------------

export const IPC_CHANNELS = {
  STORAGE_SET: 'xid:storage:set',
  STORAGE_GET: 'xid:storage:get',
  STORAGE_REMOVE: 'xid:storage:remove',
  // OAuth sign-in triggered from renderer -> main opens system browser
  SIGN_IN: 'xid:sign-in',
  // Main -> renderer: deliver OAuth callback URL after system browser redirect
  SIGN_IN_CALLBACK: 'xid:sign-in:callback',
  // Renderer requests sign-out
  SIGN_OUT: 'xid:sign-out',
  // Renderer requests access token (with transparent refresh if near expiry)
  GET_ACCESS_TOKEN: 'xid:get-access-token',
  // Renderer requests full session object
  GET_SESSION: 'xid:get-session',
  // Renderer requests token storage swap (no-op in IPC model; parity with contract)
  SET_TOKEN_STORAGE: 'xid:set-token-storage',
} as const

export type IpcChannels = typeof IPC_CHANNELS

// ---------------------------------------------------------------------------
// ContextBridge API exposed to the renderer
// ---------------------------------------------------------------------------

/**
 * The shape of `window.xidBridge` exposed by the preload script.
 * Use XID_BRIDGE_KEY to reference the window property name.
 */
export const XID_BRIDGE_KEY = 'xidBridge' as const

export type XidBridge = {
  readonly storage: SecureStorageAdapter
  /**
   * Open the system browser to the XID hosted sign-in page and wait for the
   * OAuth authorization code to be delivered back (via loopback or custom
   * scheme). Resolves with the access token JWT on success.
   */
  readonly signIn: (options?: SignInOptions) => Promise<string>
  readonly signOut: () => Promise<void>
  /**
   * Return the current access token, transparently refreshing if near expiry.
   * Returns null when not signed in.
   * Aligns with the Shared native contract `getAccessToken()`.
   */
  readonly getAccessToken: () => Promise<string | null>
  /**
   * Return the current session (accessToken + expiresAt), or null if not signed in.
   * Aligns with the Shared native contract `getSession()`.
   */
  readonly getSession: () => Promise<{ accessToken: string; expiresAt: number } | null>
  /**
   * Replace the token storage adapter. No-op in the IPC bridge model
   * (storage is always safeStorage-backed); exposed for API surface parity
   * with the Shared native contract `setTokenStorage()`.
   */
  readonly setTokenStorage: () => Promise<void>
}

// ---------------------------------------------------------------------------
// OAuth / sign-in options
// ---------------------------------------------------------------------------

export type SignInOptions = {
  /** Extra OAuth scopes to request (e.g. 'openid profile email'). */
  readonly scopes?: readonly string[]
  /** Custom prompt parameter (e.g. 'login', 'consent'). */
  readonly prompt?: string
  /** Abort signal to cancel the sign-in flow. */
  readonly signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Loopback callback server contract
// ---------------------------------------------------------------------------

export type LoopbackCallbackServer = {
  /**
   * The loopback redirect_uri to register with the OIDC authorization request.
   * Format: `http://127.0.0.1:<port>/callback`
   */
  readonly redirectUri: string
  /**
   * Waits for the OAuth authorization code callback.
   * Resolves with the full callback URL (containing code + state query params).
   * Rejects after `timeoutMs` milliseconds (default 300 000).
   */
  readonly waitForCallback: (options?: { timeoutMs?: number }) => Promise<URL>
  /** Close the HTTP listener. Safe to call multiple times. */
  readonly close: () => Promise<void>
}

export type StartLoopbackServer = () => Promise<LoopbackCallbackServer>

// ---------------------------------------------------------------------------
// Main process XidApp options
// ---------------------------------------------------------------------------

export type XidElectronMainOptions = {
  /** XID issuer URL, e.g. https://xid.dev */
  readonly issuer: string
  /** OAuth client_id (public client — no client secret). */
  readonly clientId: string
  /**
   * Preferred callback strategy.
   * - 'loopback': RFC 8252 s.7.3, starts HTTP server on 127.0.0.1
   * - 'custom-scheme': uses a registered custom protocol (e.g. myapp://callback)
   * Default: 'loopback'
   */
  readonly callbackStrategy?: 'loopback' | 'custom-scheme'
  /**
   * Custom protocol scheme (used when callbackStrategy === 'custom-scheme').
   * Must be registered with app.setAsDefaultProtocolClient() before calling.
   * Example: 'myapp' → redirect_uri = 'myapp://callback'
   */
  readonly customScheme?: string
  /**
   * OAuth scopes to request. Defaults to 'openid profile email offline_access'.
   */
  readonly scopes?: readonly string[]
  /**
   * Storage directory for encrypted token blobs.
   * Defaults to app.getPath('userData') + '/xid-tokens'.
   */
  readonly storageDir?: string
}

// ---------------------------------------------------------------------------
// PKCE result (shared between main and tests)
// ---------------------------------------------------------------------------

export type PkceChallenge = {
  readonly codeVerifier: string
  readonly codeChallenge: string
  readonly codeChallengeMethod: 'S256'
}
