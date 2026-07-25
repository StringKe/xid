// 认证 API 客户端:封装对 worker 的同域 fetch(对照 06 章 Backend API 封装认证)。
// 约定(api-sdk-conventions rule):/v1/ 前缀、Bearer 由 HttpOnly cookie 承载(credentials: include)、
// 错误体为 XidAPIError 结构。可预期失败 -> Result<_, XidError>;传输/意外 -> throw XidNetworkError。

import type { Result, XidError } from '@xid-kit/types'

import type {
  CreateApiKeyInput,
  ListSessionsInput,
  ListUsersInput,
  ManagementSession,
  ManagementUser,
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
import { XidNetworkError, isXidErrorShape } from './errors'
import { trimTrailingSlashes } from './url'

// worker 颁发的 short-lived JWT 响应(对照 /v1/sessions/token)。
export type TokenResponse = {
  jwt: string
  // 服务端回传过期(秒,epoch),可选;缺失时 core 解码 jwt.exp。
  expireAt?: number
}

// 登录态快照响应(/v1/me):一次拉齐 session/user/sessions 列表,减少往返。
export type ClientStateResponse = {
  activeSessionId: string | null
  sessions: readonly XidSession[]
  user: XidUser | null
}

type MeUserWire = {
  id: string
  email?: string
  emailVerified?: boolean
  name?: string | null
  imageUrl?: string | null
}

type MeOrganizationWire = {
  id: string
  slug: string
  name: string
  role: string
  permissions?: string[]
}

type MeSessionWire = {
  id: string
  expiresAt: string
  isImpersonation: boolean
}

type MeResponseWire = {
  user: MeUserWire
  activeOrg: MeOrganizationWire | null
  organizations: MeOrganizationWire[]
  session: MeSessionWire
}

export type ActiveOrganizationResponse = {
  session: {
    id: string
    expiresAt: string
    isImpersonation: boolean
  }
  activeOrganizationId: string | null
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
    // 同域默认走相对路径,跨域显式传 apiUrl。去尾斜杠统一拼接。
    this.#baseUrl = trimTrailingSlashes(options.apiUrl ?? '')
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
    this.#secretKey = options.secretKey ?? null
  }

  async getToken(
    input: { template?: string; signal?: AbortSignal } = {},
  ): Promise<Result<TokenResponse, XidError>> {
    return this.#request<TokenResponse>({
      path: '/v1/sessions/token',
      method: 'POST',
      body: input.template ? { template: input.template } : {},
      signal: input.signal,
    })
  }

  async loadState(
    input: { signal?: AbortSignal } = {},
  ): Promise<Result<ClientStateResponse, XidError>> {
    const result = await this.#request<ClientStateResponse | MeResponseWire>({
      path: '/v1/me',
      signal: input.signal,
    })
    if (!result.ok) return result
    return { ok: true, value: normalizeClientState(result.value) }
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

  async getOrganization(input: {
    organizationId: string
    signal?: AbortSignal
  }): Promise<Result<XidOrganization, XidError>> {
    return this.#request<XidOrganization>({
      path: `/v1/organizations/${encodeURIComponent(input.organizationId)}`,
      signal: input.signal,
    })
  }

  // 多会话切换:把指定 session 设为活跃(worker 改 cookie 指向),回传新激活态。
  async setActiveSession(input: {
    sessionId: string
    signal?: AbortSignal
  }): Promise<Result<ClientStateResponse, XidError>> {
    return this.#request<ClientStateResponse>({
      path: '/v1/sessions/active',
      method: 'POST',
      body: { sessionId: input.sessionId },
      signal: input.signal,
    })
  }

  // 切换当前 session 的 active org(对照 02 章 active org + token 注入 org claims)。
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

  // 登出:sessionId 省略则登出全部会话(对照 06 章 sign-out)。worker 清 cookie。
  async signOut(
    input: { sessionId?: string; signal?: AbortSignal } = {},
  ): Promise<Result<null, XidError>> {
    const result = await this.#request<unknown>({
      path: '/v1/sessions/sign-out',
      method: 'POST',
      body: input.sessionId ? { sessionId: input.sessionId } : {},
      signal: input.signal,
    })
    return result.ok ? { ok: true, value: null } : result
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

  // 发请求:补 headers / credentials,网络层失败 throw XidNetworkError(传输不可恢复)。
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

  // 解析响应:2xx -> Result.ok;XidError 结构体 -> Result.error;其余 -> throw XidNetworkError。
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

function normalizeClientState(value: ClientStateResponse | MeResponseWire): ClientStateResponse {
  if ('sessions' in value) return value

  const organizationMemberships = value.organizations.map(mapMeOrganizationMembership)
  const user = mapMeUser(value.user, organizationMemberships)
  const session = mapMeSession(value.session, value.user.id, value.activeOrg?.id ?? null)
  return {
    activeSessionId: session.id,
    sessions: [session],
    user,
  }
}

function mapMeUser(
  user: MeUserWire,
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

function mapMeOrganizationMembership(row: MeOrganizationWire): XidOrganizationMembership {
  return {
    id: `mem:${row.id}`,
    organization: mapMeOrganization(row),
    role: row.role,
    permissions: row.permissions ?? [],
    createdAt: 0,
  }
}

function mapMeOrganization(row: MeOrganizationWire): XidOrganization {
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
  session: MeSessionWire,
  userId: string,
  activeOrganizationId: string | null,
): XidSession {
  const expireAt = Math.floor(Date.parse(session.expiresAt) / 1000)
  return {
    id: session.id,
    status: 'active' satisfies SessionStatus,
    userId,
    activeOrganizationId,
    lastActiveAt: 0,
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
