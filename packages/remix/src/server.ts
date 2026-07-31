// server.ts: Remix loader/action server 认证 helpers。
// getAuth(request, options): 从 Request 提取并验证 XID session,返回 AuthResult。
// requireAuth(request, options): 未登录时 throw Response redirect,已登录返回 AuthObject。
// xidClient(options): server 端 Management API 入口(sk_ 认证)。
//
// 认证优先级:Authorization: Bearer -> 显式应用 JWT cookie -> 可选同源 Core exchange ->
// XID session storage token。Core opaque refresh cookie 永不在本地验签。
// 见 docs/design/06-developer-experience.md SDK 分层、api-sdk-conventions rule。

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

// getAuth 配置:验证选项 + 可选 sessionStorage 集成。
export type GetAuthOptions = AuthenticateRequestOptions & {
  // 如前述来源均未认证,则在 sessionStorage 中查找应用保存的 short-lived JWT。
  sessionStorage?: {
    getSession: (
      cookie: string | null | undefined,
    ) => Promise<{ get: (key: string) => string | undefined }>
  }
  // 从 sessionStorage 取 token 的 session key,默认 xid:access_token。
  sessionTokenKey?: string
}

// 将 @xid-kit/backend SignedInState 转换为 AuthResult。
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

// getAuth: Remix loader/action helper。
// 从 Request 中提取并验证 XID session,返回 AuthResult。
//
// 用法(loader):
//   export async function loader({ request }: LoaderFunctionArgs) {
//     const auth = await getAuth(request, { jwtKey: process.env.XID_JWT_KEY })
//     if (!auth.userId) return redirect('/login')
//     return json({ userId: auth.userId })
//   }
export async function getAuth(request: Request, options: GetAuthOptions): Promise<AuthResult> {
  const { sessionStorage, sessionTokenKey = 'xid:access_token', ...verifyOptions } = options

  // 先尝试 Bearer / 显式 JWT cookie / 同源 Core exchange。
  const state = await authenticateRequest(request, verifyOptions)
  if (state.isSignedIn) return toAuthResult(state)

  // 若提供了 sessionStorage,尝试从中读取 access_token。
  if (sessionStorage) {
    const cookieHeader = request.headers.get('cookie')
    const session = await sessionStorage.getSession(cookieHeader)
    const token = session.get(sessionTokenKey)
    if (token) {
      // 用从 session 取出的 token 构建临时 Bearer request 重新验签。
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

// requireAuth: 未登录时 throw Response redirect,已登录时返回 AuthObject。
// Remix 约定:loader/action 中 throw Response 会被框架捕获并跳转。
//
// 用法(loader):
//   export async function loader({ request }: LoaderFunctionArgs) {
//     const auth = await requireAuth(request, { jwtKey: process.env.XID_JWT_KEY })
//     return json({ userId: auth.userId })
//   }
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

// XidServerApiClient: server 端 Management API 入口(sk_ 认证)。
// 对标 @clerk/remix clerkClient 的服务端调用路径。
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

// xidClient 工厂函数:server 端 Management API 入口。
// 用法:const client = xidClient({ secretKey: process.env.XID_SECRET_KEY! })
export function xidClient(options: XidServerClientOptions): XidServerApiClient {
  return new XidServerApiClient(options)
}
