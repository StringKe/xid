// 浏览器登录态:只读状态与 getToken;refresh 在 HttpOnly cookie,不持密钥。

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
  SignInSilentInput,
  UpgradeGuestWithPasskeyInput,
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
import { createPasskeyCredential } from './webauthn'
import { XidStore } from './store'

export class XidClient {
  readonly #store = new XidStore()
  readonly #api: XidApiClient
  readonly #tokens: TokenManager
  readonly #now: () => number
  readonly #oidc: BrowserOidcSession | null
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

  subscribe(listener: XidStateListener): Unsubscribe {
    return this.#store.subscribe(listener)
  }

  getSnapshot = (): XidState => this.#store.getSnapshot()

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

  get isAnonymous(): boolean {
    return isGuestUser(this.#store.getSnapshot().user)
  }

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

  // 本地已有有效 session 则不请求(惰性);否则 POST /auth/guest 后重拉状态。
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
    // cookie 已换会话,旧 token 不得继续用。
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

  // worker verify 后原地转正并轮换 session cookie,收尾须清 token 并重拉 /v1/me。
  async upgradeGuestWithPasskey(
    input: UpgradeGuestWithPasskeyInput = {},
  ): Promise<Result<XidState, XidError>> {
    if (this.#oidc) return unsupportedInOidcMode()
    if (!isGuestUser(this.#store.getSnapshot().user)) {
      return {
        ok: false,
        error: makeXidError(
          'validation_failed',
          'Only an anonymous (guest) user can be upgraded with a passkey.',
        ),
      }
    }

    const optionsResult = await this.#api.passkeyRegisterOptions({ signal: input.signal })
    if (!optionsResult.ok) return optionsResult
    const ceremonyResult = await createPasskeyCredential(optionsResult.value, {
      ...(input.deviceName ? { deviceName: input.deviceName } : {}),
    })
    if (!ceremonyResult.ok) return ceremonyResult
    const verifyResult = await this.#api.passkeyRegisterVerify(ceremonyResult.value, {
      signal: input.signal,
    })
    if (!verifyResult.ok) return verifyResult

    this.#tokens.clear()
    await this.load(input.signal ? { signal: input.signal } : {})
    return { ok: true, value: this.#store.getSnapshot() }
  }

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
    // org claims 已变,须清缓存强制重取 token。
    this.#tokens.clear()
    await this.load(input.signal ? { signal: input.signal } : {})
    return { ok: true, value: this.#store.getSnapshot() }
  }

  // 指定其他 session 时先切换再 /auth/sign-out;成功后重拉以落到剩余 session 或匿名壳。
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
      // silent 回跳被拒 -> 失败 Result,不污染 session。
      if ('silentError' in value) {
        return {
          ok: false,
          error: makeXidError(
            value.silentError,
            `OIDC silent authorization failed: ${value.silentError}.`,
            { httpStatus: 401 },
          ),
        }
      }
      const session = await this.#oidc.load(input.signal)
      this.#store.setState(this.#oidc.stateFromSession(session))
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: toXidError(error) }
    }
  }

  // iframe + prompt=none 的 best-effort;交互类拒绝或超时应再调 signInSilentWithRedirect。
  async signInSilent(
    input: SignInSilentInput = {},
  ): Promise<Result<HandleRedirectCallbackResult, XidError>> {
    if (!this.#oidc) return unsupportedOutsideOidcMode()
    try {
      const result = await this.#oidc.signInSilent(input)
      if (!result.ok) return result
      const session = await this.#oidc.load(input.signal)
      this.#store.setState(this.#oidc.stateFromSession(session))
      return result
    } catch (error) {
      return { ok: false, error: toXidError(error) }
    }
  }

  // 顶层 redirect + prompt=none 兜底;回跳由 handleRedirectCallback 收尾。
  async signInSilentWithRedirect(
    input: { returnUrl?: string; signal?: AbortSignal } = {},
  ): Promise<Result<null, XidError>> {
    if (!this.#oidc) return unsupportedOutsideOidcMode()
    try {
      await this.#oidc.signInSilentWithRedirect(input)
      return { ok: true, value: null }
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

function resolveActiveSession(snapshot: ClientStateResponse): XidSession | null {
  if (snapshot.activeSessionId) {
    const match = snapshot.sessions.find((s) => s.id === snapshot.activeSessionId)
    if (match) return match
  }
  return snapshot.sessions.find((s) => s.status === 'active') ?? null
}
