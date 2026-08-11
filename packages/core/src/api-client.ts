// 同域认证 API:/v1/ + credentials:include(cookie);可预期失败 -> Result,传输/意外 -> throw。

import { isOrganizationMembershipRole } from '@xid-kit/types'
import type {
  ActiveOrganizationResponse,
  ActiveSessionResponse,
  BrowserAuthOrganization,
  BrowserAuthSession,
  BrowserAuthUser,
  BrowserMeResponse,
  Result,
  SessionTokenResponse,
  XidError,
} from '@xid-kit/types'

import type {
  CreateApiKeyInput,
  ListSessionsInput,
  ListUsersInput,
  ManagementSession,
  ManagementUser,
  SignInAnonymouslyInput,
  SignInPasswordInput,
  SignInResult,
  SessionStatus,
  XidApiKey,
  XidApiKeyWithSecret,
  XidOrganization,
  XidOrganizationMembership,
  XidPage,
  XidSession,
  XidUser,
} from './types'
import type { SignOutResponse } from './saml-logout'
import type { PasskeyRegistrationOptions, PasskeyRegistrationVerifyBody } from './webauthn'
import { XidNetworkError, isXidErrorShape, makeXidError } from './errors'
import { trimTrailingSlashes } from './url'

export type TokenResponse = SessionTokenResponse

export type ClientStateResponse = {
  activeSessionId: string | null
  sessions: readonly XidSession[]
  user: XidUser | null
}

type RequestInput = {
  path: string
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
  auth?: 'cookie' | 'secret'
}

type UserWire = {
  id: string
  username?: string | null
  externalId?: string | null
  firstName?: string | null
  lastName?: string | null
  displayName?: string | null
  status?: string
  publicMetadata?: Record<string, unknown>
  locale?: string | null
  createdAt?: number
  updatedAt?: number
}

type SessionWire = {
  id: string
  userId: string
  activeOrgId?: string | null
  status?: string
  expiresAt?: number
  createdAt?: number
}

type OrganizationWire = {
  id: string
  slug: string
  name: string
  publicMetadata?: Record<string, unknown>
  createdAt?: number
  updatedAt?: number
}

const JSON_CONTENT_TYPE = 'application/json'

type ApiKeyWire = {
  id: string
  name: string
  key_prefix: string
  environment: string
  scopes: string[]
  last_used_at: number | null
  expires_at: number | null
  revoked_at: number | null
  created_at: number
}

type ApiKeyWithSecretWire = ApiKeyWire & {
  key: string
}

type V1PageWire<T> = {
  data: T[]
  next_cursor: string | null
  has_more: boolean
}

export class XidApiClient {
  readonly #baseUrl: string
  readonly #fetcher: typeof fetch
  readonly #secretKey: string | null

  constructor(options: { apiUrl?: string; fetcher?: typeof fetch; secretKey?: string }) {
    this.#baseUrl = trimTrailingSlashes(options.apiUrl ?? '')
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
    this.#secretKey = options.secretKey ?? null
  }

  async getToken(input: { signal?: AbortSignal } = {}): Promise<Result<TokenResponse, XidError>> {
    const result = await this.#request<unknown>({
      path: '/v1/sessions/token',
      method: 'POST',
      body: {},
      signal: input.signal,
    })
    if (!result.ok) return result
    if (
      !isRecord(result.value) ||
      typeof result.value.token !== 'string' ||
      result.value.token.trim().length === 0
    ) {
      throw new XidNetworkError('Invalid /v1/sessions/token response')
    }
    return { ok: true, value: { token: result.value.token } }
  }

  async loadState(
    input: { signal?: AbortSignal } = {},
  ): Promise<Result<ClientStateResponse, XidError>> {
    const result = await this.#request<unknown>({
      path: '/v1/me',
      signal: input.signal,
    })
    if (!result.ok) return result
    try {
      return { ok: true, value: normalizeClientState(result.value) }
    } catch (error) {
      if (error instanceof XidNetworkError) throw error
      throw new XidNetworkError('Invalid /v1/me response', { cause: error })
    }
  }

  async signInPassword(input: SignInPasswordInput): Promise<Result<SignInResult, XidError>> {
    const result = await this.#request<SignInResult>({
      path: '/auth/password/sign-in',
      method: 'POST',
      body: {
        identifier: input.identifier,
        password: input.password,
        turnstileToken: input.turnstileToken ?? null,
      },
      signal: input.signal,
    })
    return result.ok ? { ok: true, value: result.value ?? {} } : result
  }

  // Set-Cookie 建 session;响应仅 sessionId/onboarding,完整状态靠 /v1/me。
  async signInAnonymously(
    input: SignInAnonymouslyInput = {},
  ): Promise<Result<{ sessionId: string; redirectUrl: string }, XidError>> {
    // /auth/guest 只要同源 /auth/config 现发的一次性 capability,禁止缓存复用。
    const configResult = await this.#request<unknown>({
      path: '/auth/config?intent=sign-up',
      signal: input.signal,
    })
    if (!configResult.ok) return configResult
    const capabilityToken = readGuestCapabilityToken(configResult.value)
    if (capabilityToken === null) {
      return {
        ok: false,
        error: makeXidError(
          'invalid_request',
          'The request is missing a required parameter or is malformed.',
        ),
      }
    }

    const result = await this.#request<unknown>({
      path: '/auth/guest',
      method: 'POST',
      body: {
        capabilityToken,
        turnstileToken: input.turnstileToken ?? null,
      },
      signal: input.signal,
    })
    if (!result.ok) return result
    if (
      !isRecord(result.value) ||
      typeof result.value.sessionId !== 'string' ||
      result.value.sessionId.trim().length === 0 ||
      typeof result.value.redirectUrl !== 'string' ||
      result.value.redirectUrl.trim().length === 0
    ) {
      throw new XidNetworkError('Invalid /auth/guest response')
    }
    return {
      ok: true,
      value: {
        sessionId: result.value.sessionId,
        redirectUrl: result.value.redirectUrl,
      },
    }
  }

  // guest session 下 verify 后走 in-place link,非 guest 仅添加 passkey。
  async passkeyRegisterOptions(
    input: { signal?: AbortSignal } = {},
  ): Promise<Result<PasskeyRegistrationOptions, XidError>> {
    return this.#request<PasskeyRegistrationOptions>({
      path: '/auth/passkey/register/options',
      method: 'POST',
      signal: input.signal,
    })
  }

  async passkeyRegisterVerify(
    body: PasskeyRegistrationVerifyBody,
    input: { signal?: AbortSignal } = {},
  ): Promise<Result<null, XidError>> {
    const result = await this.#request<unknown>({
      path: '/auth/passkey/register/verify',
      method: 'POST',
      body,
      signal: input.signal,
    })
    return result.ok ? { ok: true, value: null } : result
  }

  async getOrganization(input: {
    organizationId: string
    signal?: AbortSignal
  }): Promise<Result<XidOrganization, XidError>> {
    return this.#request<XidOrganization>({
      path: `/v1/organizations/${encodeURIComponent(input.organizationId)}`,
      signal: input.signal,
    })
  }

  async setActiveSession(input: {
    sessionId: string
    signal?: AbortSignal
  }): Promise<Result<ActiveSessionResponse, XidError>> {
    return this.#request<ActiveSessionResponse>({
      path: '/v1/sessions/active',
      method: 'POST',
      body: { sessionId: input.sessionId },
      signal: input.signal,
    })
  }

  async setActiveOrganization(input: {
    organizationId: string | null
    signal?: AbortSignal
  }): Promise<Result<ActiveOrganizationResponse, XidError>> {
    return this.#request<ActiveOrganizationResponse>({
      path: '/v1/sessions/active-organization',
      method: 'POST',
      body: { organizationId: input.organizationId },
      signal: input.signal,
    })
  }

  // 只登当前 active;指定其他 session 须先切换。
  async signOut(input: { signal?: AbortSignal } = {}): Promise<Result<SignOutResponse, XidError>> {
    return this.#request<SignOutResponse>({
      path: '/auth/sign-out',
      method: 'POST',
      signal: input.signal,
    })
  }

  async listApiKeys(
    input: { limit?: number; cursor?: string | null; signal?: AbortSignal } = {},
  ): Promise<Result<XidPage<XidApiKey>, XidError>> {
    const search = new URLSearchParams()
    if (input.limit !== undefined) search.set('limit', String(input.limit))
    if (input.cursor) search.set('cursor', input.cursor)
    const suffix = search.toString()
    const result = await this.#request<V1PageWire<ApiKeyWire>>({
      path: suffix ? `/v1/api-keys?${suffix}` : '/v1/api-keys',
      signal: input.signal,
    })
    return result.ok ? { ok: true, value: mapPage(result.value, mapApiKey) } : result
  }

  async createApiKey(input: CreateApiKeyInput): Promise<Result<XidApiKeyWithSecret, XidError>> {
    const result = await this.#request<ApiKeyWithSecretWire>({
      path: '/v1/api-keys',
      method: 'POST',
      body: {
        name: input.name,
        environment: input.environment ?? 'live',
        scopes: input.scopes ?? [],
        ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
      },
      signal: input.signal,
    })
    return result.ok ? { ok: true, value: mapApiKeyWithSecret(result.value) } : result
  }

  async revokeApiKey(input: {
    id: string
    signal?: AbortSignal
  }): Promise<Result<XidApiKey, XidError>> {
    const result = await this.#request<ApiKeyWire>({
      path: `/v1/api-keys/${encodeURIComponent(input.id)}`,
      method: 'DELETE',
      signal: input.signal,
    })
    return result.ok ? { ok: true, value: mapApiKey(result.value) } : result
  }

  async listUsers(input: ListUsersInput = {}): Promise<Result<XidPage<ManagementUser>, XidError>> {
    const search = new URLSearchParams()
    if (input.limit !== undefined) search.set('limit', String(input.limit))
    if (input.cursor) search.set('cursor', input.cursor)
    if (input.search) search.set('search', input.search)
    const suffix = search.toString()
    const result = await this.#request<V1PageWire<UserWire>>({
      path: suffix ? `/v1/users?${suffix}` : '/v1/users',
      signal: input.signal,
      auth: 'secret',
    })
    return result.ok ? { ok: true, value: mapPage(result.value, mapManagementUser) } : result
  }

  async getUser(input: {
    userId: string
    signal?: AbortSignal
  }): Promise<Result<ManagementUser, XidError>> {
    const result = await this.#request<UserWire>({
      path: `/v1/users/${encodeURIComponent(input.userId)}`,
      signal: input.signal,
      auth: 'secret',
    })
    return result.ok ? { ok: true, value: mapManagementUser(result.value) } : result
  }

  async listOrganizations(
    input: {
      limit?: number
      cursor?: string | null
      signal?: AbortSignal
    } = {},
  ): Promise<Result<XidPage<XidOrganization>, XidError>> {
    const search = new URLSearchParams()
    if (input.limit !== undefined) search.set('limit', String(input.limit))
    if (input.cursor) search.set('cursor', input.cursor)
    const suffix = search.toString()
    const result = await this.#request<V1PageWire<OrganizationWire>>({
      path: suffix ? `/v1/organizations?${suffix}` : '/v1/organizations',
      signal: input.signal,
      auth: 'secret',
    })
    return result.ok
      ? { ok: true, value: mapPage(result.value, mapManagementOrganization) }
      : result
  }

  async listSessions(
    input: ListSessionsInput = {},
  ): Promise<Result<XidPage<ManagementSession>, XidError>> {
    const search = new URLSearchParams()
    if (input.limit !== undefined) search.set('limit', String(input.limit))
    if (input.cursor) search.set('cursor', input.cursor)
    if (input.userId) search.set('user_id', input.userId)
    const suffix = search.toString()
    const result = await this.#request<V1PageWire<SessionWire>>({
      path: suffix ? `/v1/sessions?${suffix}` : '/v1/sessions',
      signal: input.signal,
      auth: 'secret',
    })
    return result.ok ? { ok: true, value: mapPage(result.value, mapManagementSession) } : result
  }

  async #request<T>(input: RequestInput): Promise<Result<T, XidError>> {
    const response = await this.#sendRequest(input)
    return this.#parseResponse<T>(response)
  }

  async #sendRequest(input: RequestInput): Promise<Response> {
    const headers: Record<string, string> = { Accept: JSON_CONTENT_TYPE }
    if (input.body !== undefined) headers['Content-Type'] = JSON_CONTENT_TYPE
    const useSecret =
      input.auth === 'secret' || (input.auth !== 'cookie' && this.#secretKey !== null)
    if (useSecret) {
      if (!this.#secretKey) {
        throw new XidNetworkError('Management API requires secretKey in XidApiClient options')
      }
      headers.Authorization = `Bearer ${this.#secretKey}`
    }

    try {
      return await this.#fetcher(`${this.#baseUrl}${input.path}`, {
        method: input.method ?? 'GET',
        headers,
        credentials: useSecret ? 'omit' : 'include',
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      })
    } catch (cause) {
      throw new XidNetworkError(`Request to ${input.path} failed`, { cause })
    }
  }

  async #parseResponse<T>(response: Response): Promise<Result<T, XidError>> {
    const text = await response.text()
    const parsed = parseJsonOrNull(text)

    if (response.ok) {
      return { ok: true, value: unwrapDataEnvelope<T>(parsed) }
    }

    const errorBody = (parsed as { error?: unknown })?.error ?? parsed
    if (isXidErrorShape(errorBody)) {
      return {
        ok: false,
        error: { ...errorBody, httpStatus: errorBody.httpStatus || response.status },
      }
    }

    throw new XidNetworkError(`Request failed with status ${response.status}`, {
      status: response.status,
    })
  }
}

function parseJsonOrNull(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function unwrapDataEnvelope<T>(parsed: unknown): T {
  if (typeof parsed !== 'object' || parsed === null) return parsed as T
  const record = parsed as Record<string, unknown>
  if ('next_cursor' in record || 'has_more' in record || 'nextCursor' in record) return parsed as T
  return 'data' in record ? (record.data as T) : (parsed as T)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readGuestCapabilityToken(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.guest)) return null
  const token = value.guest.capabilityToken
  return typeof token === 'string' && token.length > 0 ? token : null
}

function hasNullableString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === null || typeof record[key] === 'string'
}

function hasValidOrganizationRole(value: unknown): boolean {
  return isRecord(value) && isOrganizationMembershipRole(value.role)
}

function hasValidMembershipRoles(user: Record<string, unknown> | null): boolean {
  if (user === null || user.organizationMemberships === undefined) return true
  return (
    Array.isArray(user.organizationMemberships) &&
    user.organizationMemberships.every(
      (membership) => isRecord(membership) && isOrganizationMembershipRole(membership.role),
    )
  )
}

function normalizeClientState(value: unknown): ClientStateResponse {
  if (!isRecord(value)) {
    throw new XidNetworkError('Invalid /v1/me response')
  }

  if (!('activeOrg' in value)) {
    if (
      !('activeSessionId' in value) ||
      !hasNullableString(value, 'activeSessionId') ||
      !Array.isArray(value.sessions) ||
      !('user' in value) ||
      (value.user !== null && !isRecord(value.user)) ||
      !hasValidMembershipRoles(value.user as Record<string, unknown> | null)
    ) {
      throw new XidNetworkError('Invalid /v1/me response')
    }
    return value as ClientStateResponse
  }

  if (
    !('activeSessionId' in value) ||
    !hasNullableString(value, 'activeSessionId') ||
    !Array.isArray(value.sessions) ||
    !Array.isArray(value.organizations) ||
    !('user' in value) ||
    !('session' in value) ||
    !('activeOrg' in value) ||
    (value.user !== null && !isRecord(value.user)) ||
    (value.session !== null && !isRecord(value.session)) ||
    (value.activeOrg !== null && !isRecord(value.activeOrg)) ||
    !value.organizations.every(hasValidOrganizationRole) ||
    (value.activeOrg !== null && !hasValidOrganizationRole(value.activeOrg)) ||
    (value.user === null) !== (value.session === null)
  ) {
    throw new XidNetworkError('Invalid /v1/me response')
  }

  const browserState = value as BrowserMeResponse
  if (!browserState.user || !browserState.session) {
    return { activeSessionId: null, sessions: [], user: null }
  }

  const organizationMemberships = browserState.organizations.map(mapMeOrganizationMembership)
  const user = mapMeUser(browserState.user, organizationMemberships)
  const sessions = browserState.sessions.map((session) =>
    mapMeSession(session, session.userId, session.activeOrganizationId),
  )
  return {
    activeSessionId: browserState.activeSessionId ?? browserState.session.id,
    sessions,
    user,
  }
}

function mapMeUser(
  user: BrowserAuthUser,
  organizationMemberships: readonly XidOrganizationMembership[],
): XidUser {
  const parts = splitName(user.name ?? null)
  return {
    id: user.id,
    primaryEmailAddress: user.email ?? null,
    primaryPhoneNumber: null,
    emailVerified: user.emailVerified ?? false,
    firstName: parts.firstName,
    lastName: parts.lastName,
    fullName: user.name ?? null,
    username: null,
    imageUrl: user.imageUrl ?? null,
    hasImage: user.imageUrl !== null && user.imageUrl !== undefined,
    ...(typeof user.provisioned_by === 'string' ? { provisionedBy: user.provisioned_by } : {}),
    publicMetadata: {},
    organizationMemberships,
    createdAt: 0,
    updatedAt: 0,
  }
}

function splitName(name: string | null): { firstName: string | null; lastName: string | null } {
  if (!name) return { firstName: null, lastName: null }
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: null, lastName: null }
  return {
    firstName: parts[0] ?? null,
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : null,
  }
}

function mapMeOrganizationMembership(row: BrowserAuthOrganization): XidOrganizationMembership {
  return {
    id: `mem:${row.id}`,
    organization: mapMeOrganization(row),
    role: row.role,
    permissions: row.permissions ?? [],
    createdAt: 0,
  }
}

function mapMeOrganization(row: BrowserAuthOrganization): XidOrganization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    imageUrl: null,
    hasImage: false,
    membersCount: 0,
    publicMetadata: {},
    createdAt: 0,
  }
}

function mapMeSession(
  session: BrowserAuthSession,
  userId: string,
  activeOrganizationId: string | null,
): XidSession {
  const expireAt = Math.floor(Date.parse(session.expiresAt) / 1000)
  return {
    id: session.id,
    status: (session.status === 'active' ? 'active' : 'pending') satisfies SessionStatus,
    userId,
    activeOrganizationId,
    lastActiveAt: Math.floor(Date.parse(session.lastActiveAt) / 1000),
    expireAt,
    abandonAt: expireAt,
    createdAt: 0,
  }
}

function mapApiKey(row: ApiKeyWire): XidApiKey {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    environment: row.environment,
    scopes: row.scopes,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  }
}

function mapApiKeyWithSecret(row: ApiKeyWithSecretWire): XidApiKeyWithSecret {
  return { ...mapApiKey(row), key: row.key }
}

function mapPage<TIn, TOut>(page: V1PageWire<TIn>, mapItem: (item: TIn) => TOut): XidPage<TOut> {
  return {
    data: page.data.map(mapItem),
    nextCursor: page.next_cursor,
    hasMore: page.has_more,
  }
}

function mapManagementUser(row: UserWire): ManagementUser {
  return {
    id: row.id,
    username: row.username ?? null,
    externalId: row.externalId ?? null,
    firstName: row.firstName ?? null,
    lastName: row.lastName ?? null,
    displayName: row.displayName ?? null,
    status: row.status ?? 'active',
    publicMetadata: row.publicMetadata ?? {},
    locale: row.locale ?? null,
    createdAt: row.createdAt ?? 0,
    updatedAt: row.updatedAt ?? 0,
  }
}

function mapManagementOrganization(row: OrganizationWire): XidOrganization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    imageUrl: null,
    hasImage: false,
    membersCount: 0,
    publicMetadata: row.publicMetadata ?? {},
    createdAt: row.createdAt ?? 0,
  }
}

function mapManagementSession(row: SessionWire): ManagementSession {
  return {
    id: row.id,
    userId: row.userId,
    activeOrgId: row.activeOrgId ?? null,
    status: row.status ?? 'active',
    expiresAt: row.expiresAt ?? 0,
    createdAt: row.createdAt ?? 0,
  }
}
