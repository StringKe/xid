// XidClient:浏览器登录态核心(对标 @clerk/clerk-js Clerk 类)。
// 职责:load/cache 登录态、multi-session 切换、active org 切换、getToken(short-lived JWT)、sign-out。
// opaque refresh credential 存 HttpOnly cookie(worker 设),SDK 只读状态并按需换取 JWT;
// 不读取 refresh credential,也不持任何密钥。

import type { Result, XidError } from '@xid-kit/types'

import type {
  GetTokenOptions,
  CreateApiKeyInput,
  CreateAuthorizationUrlInput,
  ListSessionsInput,
  ListUsersInput,
  ManagementSession,
  ManagementUser,
  SignInAnonymouslyInput,
  SignInAnonymouslyResult,
  SignInPasswordInput,
  SignInResult,
  HandleRedirectCallbackResult,
  XidApiKey,
  XidApiKeyWithSecret,
  XidClientOptions,
  XidOrganization,
  XidPage,
  XidSession,
  XidState,
  XidStateListener,
  XidUser,
  Unsubscribe,
} from './types'
import { XidApiClient, type ClientStateResponse } from './api-client'
import { BrowserOidcError, BrowserOidcSession } from './browser-oidc'
import { executeBrowserSamlLogout } from './saml-logout'
import { makeXidError } from './errors'
import { isGuestUser } from './guest'
import { TokenManager } from './token-manager'
import { XidStore } from './store'

export class XidClient {
  readonly #store = new XidStore()
  readonly #api: XidApiClient
  readonly #tokens: TokenManager
  readonly #now: () => number
  readonly #oidc: BrowserOidcSession | null
  // active org 解析缓存:org id -> Organization(避免每次重拉)。
  readonly #orgCache = new Map<string, XidOrganization>()

  constructor(options: XidClientOptions = {}) {
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.#oidc = options.mode === 'oidc' ? new BrowserOidcSession(options) : null
    if (options.mode !== 'oidc') assertSameOriginCookieOptions(options)
    this.#api = new XidApiClient({
      ...(options.mode === 'oidc'
        ? { apiUrl: options.issuer }
        : {
            ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
            ...(options.secretKey ? { secretKey: options.secretKey } : {}),
          }),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    })
    this.#tokens = new TokenManager({ api: this.#api, now: this.#now })
  }

  // 订阅状态变更(框架层 useSyncExternalStore 用)。
  subscribe(listener: XidStateListener): Unsubscribe {
    return this.#store.subscribe(listener)
  }

  getSnapshot = (): XidState => this.#store.getSnapshot()

  // 资源访问器(对照 06 章资源访问器:user/organization/session 状态)。
  get user(): XidUser | null {
    return this.#store.getSnapshot().user
  }

  get session(): XidSession | null {
    return this.#store.getSnapshot().session
  }

  get organization(): XidOrganization | null {
    return this.#store.getSnapshot().organization
  }

  get sessions(): readonly XidSession[] {
    return this.#store.getSnapshot().sessions
  }

  get isSignedIn(): boolean {
    return this.#store.getSnapshot().isSignedIn
  }

  // guest 判定:当前用户由匿名开通(provisionedBy === 'anonymous')。
  get isAnonymous(): boolean {
    return isGuestUser(this.#store.getSnapshot().user)
  }

  // 初始化:拉取登录态快照(/v1/me)。SDK 启动时调用一次,失败置 error/degraded 状态。
  async load(input: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.#oidc) {
      try {
        const session = await this.#oidc.load(input.signal)
        this.#store.setState(this.#oidc.stateFromSession(session))
      } catch (error) {
        this.#store.setState({
          status: 'degraded',
          isLoaded: true,
          isSignedIn: false,
          session: null,
          user: null,
          organization: null,
          sessions: [],
          error: toXidError(error),
        })
      }
      return
    }
    const result = await this.#api.loadState({ ...(input.signal ? { signal: input.signal } : {}) })
    if (!result.ok) {
      this.#store.setState({
        status: 'degraded',
        isLoaded: true,
        error: result.error,
      })
      return
    }
    await this.#applyState(result.value)
  }

  // getToken:到期前刷新的 short-lived JWT(对照 06 章 networkless 验证前置)。
  async getToken(options: GetTokenOptions = {}): Promise<Result<string, XidError>> {
    if (this.#oidc) {
      const token = await this.#oidc.getAccessToken()
      return token
        ? { ok: true, value: token }
        : {
            ok: false,
            error: makeXidError('session_not_found', 'No active session was found.', {
              httpStatus: 401,
            }),
          }
    }
    return this.#tokens.getToken(options)
  }

  async signInPassword(input: SignInPasswordInput): Promise<Result<SignInResult, XidError>> {
    if (this.#oidc) return unsupportedInOidcMode()
    const result = await this.#api.signInPassword(input)
    if (!result.ok) return result
    if (result.value.nextStep === 'verify_email') return result
    await this.load(input.signal ? { signal: input.signal } : {})
    return result
  }

  // guest 开通(Firebase signInAnonymously 惰性语义):本地已有有效 session 直接返回,
  // 不发请求;否则 POST /auth/guest 建立 cookie session 并重拉状态。
  async signInAnonymously(
    input: SignInAnonymouslyInput = {},
  ): Promise<Result<SignInAnonymouslyResult, XidError>> {
    if (this.#oidc) return unsupportedInOidcMode()
    const snapshot = this.#store.getSnapshot()
    if (snapshot.isSignedIn && snapshot.session) {
      return {
        ok: true,
        value: {
          ...snapshot,
          state: snapshot,
          sessionId: snapshot.session.id,
          redirectUrl: null,
          nextStep: 'complete',
        },
      }
    }

    const result = await this.#api.signInAnonymously({
      turnstileToken: input.turnstileToken ?? null,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (!result.ok) return result
    // 新 session 的 cookie 已换人,缓存的 token 属于旧会话,必须清掉。
    this.#tokens.clear()
    await this.load(input.signal ? { signal: input.signal } : {})
    const state = this.#store.getSnapshot()
    return {
      ok: true,
      value: {
        ...state,
        state,
        sessionId: result.value.sessionId,
        redirectUrl: result.value.redirectUrl,
        nextStep: 'redirect',
      },
    }
  }

  // multi-session 切换:把目标 session 设为活跃,刷新派生态并清 token 缓存。
  async setActiveSession(input: {
    sessionId: string
    signal?: AbortSignal
  }): Promise<Result<XidState, XidError>> {
    if (this.#oidc) return unsupportedInOidcMode()
    const result = await this.#api.setActiveSession({
      sessionId: input.sessionId,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (!result.ok) return result
    this.#tokens.clear()
    this.#orgCache.clear()
    this.#store.reset()
    await this.load(input.signal ? { signal: input.signal } : {})
    return { ok: true, value: this.#store.getSnapshot() }
  }

  // 切换当前 session 的 active org;null = 退回个人上下文。
  async setActiveOrganization(input: {
    organizationId: string | null
    signal?: AbortSignal
  }): Promise<Result<XidState, XidError>> {
    if (this.#oidc) return unsupportedInOidcMode()
    const result = await this.#api.setActiveOrganization({
      organizationId: input.organizationId,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (!result.ok) return result
    // org 切换改变 token claims(org_id/org_role/permissions),必须清缓存强制下次重取。
    this.#tokens.clear()
    await this.load(input.signal ? { signal: input.signal } : {})
    return { ok: true, value: this.#store.getSnapshot() }
  }

  // 登出当前 session。若指定另一个 browser-held session,先把它设为 active 再走同一
  // /auth/sign-out 契约;成功后重拉 /v1/me,以便自动落到剩余 session 或匿名壳。
  async signOut(
    input: { sessionId?: string; signal?: AbortSignal } = {},
  ): Promise<Result<null, XidError>> {
    if (this.#oidc) {
      await this.#oidc.clear()
      this.#store.setState(this.#oidc.stateFromSession(null))
      return { ok: true, value: null }
    }
    if (input.sessionId && input.sessionId !== this.session?.id) {
      const selected = await this.setActiveSession({
        sessionId: input.sessionId,
        ...(input.signal ? { signal: input.signal } : {}),
      })
      if (!selected.ok) return selected
    }

    const result = await this.#api.signOut({
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (!result.ok) return result
    this.#tokens.clear()
    this.#orgCache.clear()
    this.#store.reset()
    if (executeBrowserSamlLogout(result.value.samlLogout)) {
      return { ok: true, value: null }
    }
    await this.load(input.signal ? { signal: input.signal } : {})
    return { ok: true, value: null }
  }

  async listApiKeys(
    input: { limit?: number; cursor?: string | null; signal?: AbortSignal } = {},
  ): Promise<Result<XidPage<XidApiKey>, XidError>> {
    if (this.#oidc) return unsupportedInOidcMode()
    return this.#api.listApiKeys(input)
  }

  async createApiKey(input: CreateApiKeyInput): Promise<Result<XidApiKeyWithSecret, XidError>> {
    if (this.#oidc) return unsupportedInOidcMode()
    return this.#api.createApiKey(input)
  }

  async revokeApiKey(input: {
    id: string
    signal?: AbortSignal
  }): Promise<Result<XidApiKey, XidError>> {
    if (this.#oidc) return unsupportedInOidcMode()
    return this.#api.revokeApiKey(input)
  }

  async listUsers(input: ListUsersInput = {}): Promise<Result<XidPage<ManagementUser>, XidError>> {
    if (this.#oidc) return unsupportedInOidcMode()
    return this.#api.listUsers(input)
  }

  async getUser(input: {
    userId: string
    signal?: AbortSignal
  }): Promise<Result<ManagementUser, XidError>> {
    if (this.#oidc) return unsupportedInOidcMode()
    return this.#api.getUser(input)
  }

  async listOrganizations(
    input: {
      limit?: number
      cursor?: string | null
      signal?: AbortSignal
    } = {},
  ): Promise<Result<XidPage<XidOrganization>, XidError>> {
    if (this.#oidc) return unsupportedInOidcMode()
    return this.#api.listOrganizations(input)
  }

  async listSessions(
    input: ListSessionsInput = {},
  ): Promise<Result<XidPage<ManagementSession>, XidError>> {
    if (this.#oidc) return unsupportedInOidcMode()
    return this.#api.listSessions(input)
  }

  async createAuthorizationUrl(
    input: CreateAuthorizationUrlInput = {},
  ): Promise<Result<string, XidError>> {
    if (!this.#oidc) return unsupportedOutsideOidcMode()
    try {
      return { ok: true, value: await this.#oidc.createAuthorizationUrl(input) }
    } catch (error) {
      return { ok: false, error: toXidError(error) }
    }
  }

  async handleRedirectCallback(
    callbackUrl: string,
    input: { signal?: AbortSignal } = {},
  ): Promise<Result<HandleRedirectCallbackResult, XidError>> {
    if (!this.#oidc) return unsupportedOutsideOidcMode()
    try {
      const value = await this.#oidc.handleRedirectCallback(callbackUrl, input.signal)
      const session = await this.#oidc.load(input.signal)
      this.#store.setState(this.#oidc.stateFromSession(session))
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: toXidError(error) }
    }
  }

  async createEndSessionUrl(): Promise<Result<string | null, XidError>> {
    if (!this.#oidc) return unsupportedOutsideOidcMode()
    try {
      return { ok: true, value: await this.#oidc.endSessionUrl() }
    } catch (error) {
      return { ok: false, error: toXidError(error) }
    }
  }

  // 把后端快照映射为 store 状态:解析活跃 session、active org,组装派生态。
  async #applyState(snapshot: ClientStateResponse): Promise<void> {
    const session = resolveActiveSession(snapshot)
    const isSignedIn = session !== null && session.status === 'active' && snapshot.user !== null
    const organization = session ? await this.#resolveOrganization(session, snapshot.user) : null

    this.#store.setState({
      status: 'ready',
      isLoaded: true,
      isSignedIn,
      session,
      user: snapshot.user,
      organization,
      sessions: snapshot.sessions,
      error: null,
    })
  }

  // 解析 active org:优先从 user 的成员关系命中,未命中再回源 /v1/organizations/{id}。
  async #resolveOrganization(
    session: XidSession,
    user: XidUser | null,
  ): Promise<XidOrganization | null> {
    const orgId = session.activeOrganizationId
    if (!orgId) return null

    const fromMembership = user?.organizationMemberships.find(
      (membership) => membership.organization.id === orgId,
    )?.organization
    if (fromMembership) {
      this.#orgCache.set(orgId, fromMembership)
      return fromMembership
    }

    const cached = this.#orgCache.get(orgId)
    if (cached) return cached

    const result = await this.#api.getOrganization({ organizationId: orgId })
    if (!result.ok) return null
    this.#orgCache.set(orgId, result.value)
    return result.value
  }
}

function assertSameOriginCookieOptions(options: Exclude<XidClientOptions, { mode: 'oidc' }>): void {
  if (!options.apiUrl || options.secretKey || typeof globalThis.location === 'undefined') return
  const target = new URL(options.apiUrl, globalThis.location.href)
  if (target.origin !== globalThis.location.origin) {
    throw new TypeError(
      'same-origin mode requires apiUrl to use the current page origin; use mode="oidc" for a cross-origin issuer',
    )
  }
}

function unsupportedInOidcMode<T>(): Result<T, XidError> {
  return {
    ok: false,
    error: makeXidError(
      'invalid_request',
      'This operation is available only in same-origin Core mode.',
    ),
  }
}

function unsupportedOutsideOidcMode<T>(): Result<T, XidError> {
  return {
    ok: false,
    error: makeXidError('invalid_request', 'This operation requires OIDC mode.'),
  }
}

function toXidError(error: unknown): XidError {
  if (error instanceof BrowserOidcError) {
    return makeXidError(error.code, error.message, { httpStatus: error.httpStatus })
  }
  return makeXidError('server_error', 'An unexpected authentication error occurred.', {
    httpStatus: 500,
  })
}

// 选活跃 session:后端指定的 activeSessionId 优先,回退首个 active 状态会话。
function resolveActiveSession(snapshot: ClientStateResponse): XidSession | null {
  if (snapshot.activeSessionId) {
    const match = snapshot.sessions.find((s) => s.id === snapshot.activeSessionId)
    if (match) return match
  }
  return snapshot.sessions.find((s) => s.status === 'active') ?? null
}
