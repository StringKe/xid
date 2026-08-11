// main / renderer / preload 共享类型；不 import electron（peer，环境不同）。

export type SecureStorageAdapter = {
  readonly setItem: (key: string, value: string) => Promise<void>
  readonly getItem: (key: string) => Promise<string | null>
  readonly removeItem: (key: string) => Promise<void>
}

// main 与 preload 共用的 IPC 通道名唯一来源。
export const IPC_CHANNELS = {
  STORAGE_SET: 'xid:storage:set',
  STORAGE_GET: 'xid:storage:get',
  STORAGE_REMOVE: 'xid:storage:remove',
  SIGN_IN: 'xid:sign-in',
  SIGN_IN_CALLBACK: 'xid:sign-in:callback',
  SIGN_OUT: 'xid:sign-out',
  GET_ACCESS_TOKEN: 'xid:get-access-token',
  GET_SESSION: 'xid:get-session',
  // IPC 模型下 storage 固定为 safeStorage，此通道为契约 parity 的 no-op。
  SET_TOKEN_STORAGE: 'xid:set-token-storage',
} as const

export type IpcChannels = typeof IPC_CHANNELS

export const XID_BRIDGE_KEY = 'xidBridge' as const

export type XidBridge = {
  readonly storage: SecureStorageAdapter
  readonly signIn: (options?: SignInOptions) => Promise<string>
  readonly signOut: () => Promise<void>
  /** 对齐 Shared native `getAccessToken()`：未登录或需重新授权时返回 null。 */
  readonly getAccessToken: () => Promise<string | null>
  /** 对齐 Shared native `getSession()`。 */
  readonly getSession: () => Promise<{ accessToken: string; expiresAt: number } | null>
  /**
   * 对齐 Shared native `setTokenStorage()`；IPC 模型下 storage 固定，此处为 no-op。
   */
  readonly setTokenStorage: () => Promise<void>
}

export type SignInOptions = {
  readonly scopes?: readonly string[]
  readonly prompt?: string
  readonly signal?: AbortSignal
}

export type LoopbackCallbackServer = {
  /** 形如 `http://127.0.0.1:<port>/callback`，写入 authorize 请求。 */
  readonly redirectUri: string
  /** 等待 OAuth 回调；超时默认 300_000ms。 */
  readonly waitForCallback: (options?: { timeoutMs?: number }) => Promise<URL>
  /** 关闭监听；可安全重复调用。 */
  readonly close: () => Promise<void>
}

export type StartLoopbackServer = () => Promise<LoopbackCallbackServer>

export type XidElectronMainOptions = {
  readonly issuer: string
  /** 公钥客户端，无 client_secret。 */
  readonly clientId: string
  /**
   * `loopback`：RFC 8252 s.7.3 本机 HTTP；`custom-scheme`：已注册自定义协议。
   * 默认 loopback。
   */
  readonly callbackStrategy?: 'loopback' | 'custom-scheme'
  /**
   * 仅 custom-scheme 时使用；须先 `app.setAsDefaultProtocolClient`。
   * 例：`myapp` -> `myapp://callback`。
   */
  readonly customScheme?: string
  /**
   * 默认 openid profile email。
   * 在实现 DPoP 前拒绝 offline_access。
   */
  readonly scopes?: readonly string[]
  /** 加密 token 目录；默认 userData/xid-tokens。 */
  readonly storageDir?: string
}

export type PkceChallenge = {
  readonly codeVerifier: string
  readonly codeChallenge: string
  readonly codeChallengeMethod: 'S256'
}
