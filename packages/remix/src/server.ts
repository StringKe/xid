// Remix loader/action 服务端认证：Bearer -> 显式 JWT cookie -> 可选同源 Core exchange -> sessionStorage。
// Core opaque refresh cookie 永不本地验签。

import { trimTrailingSlashes } from '@xid-kit/core'
import type { XidUser } from '@xid-kit/core'
import { isOrganizationMembershipRole, type Result } from '@xid-kit/types'

import { authenticateRequest } from '@xid-kit/backend'
import type { AuthenticateRequestOptions, SignedInState } from '@xid-kit/backend'

import type {
  AuthObject,
  AuthResult,
  UnauthenticatedAuthObject,
  XidServerClientOptions,
} from './types'

export const UNAUTHENTICATED: UnauthenticatedAuthObject = {
  userId: null,
  sessionId: null,
  orgId: null,
  orgRole: null,
  orgPermissions: null,
  claims: null,
}

export type GetAuthOptions = AuthenticateRequestOptions & {
  // 前述来源均失败时，再读应用 session 中的 short-lived JWT。
  sessionStorage?: {
    getSession: (
      cookie: string | null | undefined,
    ) => Promise<{ get: (key: string) => string | undefined }>
  }
  sessionTokenKey?: string
}

function toAuthResult(state: { isSignedIn: boolean } & Partial<SignedInState>): AuthResult {
  if (!state.isSignedIn || !state.claims) return UNAUTHENTICATED

  const { claims } = state
  const orgId = typeof claims['active_org_id'] === 'string' ? claims['active_org_id'] : undefined
  const orgRole = isOrganizationMembershipRole(claims.org_role) ? claims.org_role : undefined
  const orgPermissions = Array.isArray(claims['org_permissions'])
    ? (claims['org_permissions'] as string[])
    : undefined

  const authObj: AuthObject = {
    userId: (state as SignedInState).userId,
    sessionId: (state as SignedInState).sessionId,
    orgId,
    orgRole,
    orgPermissions,
    claims,
  }
  return authObj
}

export async function getAuth(request: Request, options: GetAuthOptions): Promise<AuthResult> {
  const { sessionStorage, sessionTokenKey = 'xid:access_token', ...verifyOptions } = options

  const state = await authenticateRequest(request, verifyOptions)
  if (state.isSignedIn) return toAuthResult(state)

  if (sessionStorage) {
    const cookieHeader = request.headers.get('cookie')
    const session = await sessionStorage.getSession(cookieHeader)
    const token = session.get(sessionTokenKey)
    if (token) {
      // session 取出的 token 需经 synthetic Bearer 走同一验签路径。
      const syntheticRequest = new Request(request.url, {
        method: request.method,
        headers: new Headers({ authorization: `Bearer ${token}` }),
      })
      const sessionState = await authenticateRequest(syntheticRequest, verifyOptions)
      if (sessionState.isSignedIn) return toAuthResult(sessionState)
    }
  }

  return UNAUTHENTICATED
}

// Remix 约定：loader/action 中 throw Response 由框架捕获并跳转。
export async function requireAuth(
  request: Request,
  options: GetAuthOptions,
  redirectOptions: { redirectPath?: string; preserveReturnTo?: boolean } = {},
): Promise<AuthObject> {
  const { redirectPath = '/login', preserveReturnTo = true } = redirectOptions
  const auth = await getAuth(request, options)

  if (!auth.userId) {
    const origin = new URL(request.url).origin
    const redirectUrl = new URL(redirectPath, origin)
    if (preserveReturnTo) {
      redirectUrl.searchParams.set('return_to', request.url)
    }
    throw Response.redirect(redirectUrl.href, 302)
  }

  return auth as AuthObject
}

// sk_ 认证的 Management API 客户端（对标 clerkClient 服务端路径）。
class XidServerApiClient {
  readonly #secretKey: string
  readonly #baseUrl: string
  readonly #fetcher: typeof fetch

  constructor(options: XidServerClientOptions) {
    this.#secretKey = options.secretKey
    this.#baseUrl = trimTrailingSlashes(options.apiUrl ?? 'https://api.xid.dev')
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
  }

  async getMe(): Promise<Result<XidUser, { message: string; status: number }>> {
    return this.#request<XidUser>('/v1/me')
  }

  async getUser(userId: string): Promise<Result<XidUser, { message: string; status: number }>> {
    return this.#request<XidUser>(`/v1/users/${encodeURIComponent(userId)}`)
  }

  async getUserList(params?: {
    after?: string
    limit?: number
  }): Promise<
    Result<
      { data: readonly XidUser[]; nextCursor: string | null },
      { message: string; status: number }
    >
  > {
    const qs = buildQs(params)
    return this.#request(`/v1/users${qs}`)
  }

  async #request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<Result<T, { message: string; status: number }>> {
    let response: Response
    try {
      response = await this.#fetcher(`${this.#baseUrl}${path}`, {
        method: 'GET',
        ...init,
        headers: {
          Authorization: `Bearer ${this.#secretKey}`,
          Accept: 'application/json',
          ...(init?.headers as Record<string, string> | undefined),
        },
      })
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause)
      return { ok: false, error: { message: `Network error: ${msg}`, status: 0 } }
    }

    const text = await response.text()
    const parsed = parseJsonSafe(text)

    if (response.ok) {
      const data = (parsed as { data?: T } | null)?.data ?? (parsed as T)
      return { ok: true, value: data }
    }

    const errMsg =
      (parsed as { error?: { message?: string } } | null)?.error?.message ??
      `HTTP ${response.status}`
    return { ok: false, error: { message: errMsg, status: response.status } }
  }
}

function buildQs(params?: Record<string, string | number | undefined>): string {
  if (!params) return ''
  const entries = Object.entries(params).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return ''
  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  return `?${qs}`
}

function parseJsonSafe(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function xidClient(options: XidServerClientOptions): XidServerApiClient {
  return new XidServerApiClient(options)
}
