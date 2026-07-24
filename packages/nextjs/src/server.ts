// server.ts:App Router server context 函数(对标 @clerk/nextjs auth / currentUser)。
// auth():React cache 去重,读 x-xid-auth header 返回 AuthResult。
// currentUser():懒加载 /v1/me 完整 User(sk_ 认证 Management API)。
// getAuth(req):Pages Router adapter,接受 IncomingMessage/Request。
// 依赖 React cache(RSC 环境);非 RSC 使用者直接调用 readAuthFromHeaders。

import type { XidUser } from '@xid-kit/core'
import type { Result } from '@xid-kit/types'

import { parseAuthHeader, resolveAuthSecret } from './auth-header'
import type { AuthResult, XidServerClientOptions } from './types'

// Next.js headers() 类型契约(peer dep,运行时由 next/headers 提供)。
// 用条件 import 避免在非 RSC 环境崩溃。
type ReadonlyHeaders = Pick<Headers, 'get' | 'has' | 'entries' | 'keys' | 'values' | 'forEach'>

// 动态 import next/headers headers(),仅在 App Router RSC 中可用。
async function getNextHeaders(): Promise<ReadonlyHeaders> {
  // next/headers 是 Next.js 内置,不存在时 throw -> 调用方捕获降级。
  const mod = (await import('next/headers')) as unknown as {
    headers: () => ReadonlyHeaders | Promise<ReadonlyHeaders>
  }
  const result = mod.headers()
  // Next.js 15+ headers() 返回 Promise<ReadonlyHeaders>。
  return result instanceof Promise ? await result : result
}

// auth():App Router server component/server action 中调用,返回当前请求 AuthResult。
// React cache 去重:同一 RSC render 多次调用只读一次 headers。
// 注意:此处不引入 React.cache 以避免 server-only 约束影响 library bundle;
// 开发者可在自己的 server-only module 里用 cache(auth) 包装。
export async function auth(): Promise<AuthResult> {
  try {
    const headers = await getNextHeaders()
    // 兼容 ReadonlyHeaders 与标准 Headers get 签名。
    const raw = headers.get('x-xid-auth')
    // 配置 XID_AUTH_HMAC_SECRET 时,parseAuthHeader 校验 middleware 写入的 HMAC 签名,拒绝伪造头(纵深防御)。
    return parseAuthHeader(raw, resolveAuthSecret())
  } catch {
    // 非 App Router 环境(Pages Router / 纯 Node 环境):返回未认证。
    return {
      userId: null,
      sessionId: null,
      orgId: null,
      orgRole: null,
      orgPermissions: null,
      claims: null,
    }
  }
}

// getAuth(req):Pages Router adapter,从 req.headers 读取 middleware 注入的认证态。
// req 接受标准 Request 或 Pages Router IncomingMessage(含 headers record)。
//
// 安全警告:此函数信任 x-xid-auth header,该头本应只由 xidMiddleware 内部注入。
// 直接信任要求:(1) middleware matcher 覆盖该路由;(2) 部署边界剥离客户端传入的 x-xid-auth。
// 纵深防御:配置 XID_AUTH_HMAC_SECRET 后,本函数校验 middleware 的 HMAC 签名,
// 任何未经 middleware(无有效签名)的请求 -- 包括攻击者直接伪造 x-xid-auth -- 一律按未认证处理。
export async function getAuth(
  req: Request | { headers: Record<string, string | string[] | undefined> },
): Promise<AuthResult> {
  let raw: string | null = null
  if (req instanceof Request) {
    raw = req.headers.get('x-xid-auth')
  } else {
    const val = req.headers['x-xid-auth']
    raw = Array.isArray(val) ? (val[0] ?? null) : (val ?? null)
  }
  return parseAuthHeader(raw, resolveAuthSecret())
}

// XidServerApiClient:server 端 Management API 入口(sk_ 认证)。
// 对标 @clerk/nextjs clerkClient() 的服务端调用路径。
class XidServerApiClient {
  readonly #secretKey: string
  readonly #baseUrl: string
  readonly #fetcher: typeof fetch

  constructor(options: XidServerClientOptions) {
    this.#secretKey = options.secretKey
    this.#baseUrl = (options.apiUrl ?? 'https://api.xid.dev').replace(/\/+$/, '')
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
  }

  // GET /v1/me:完整 User 对象(含 organizationMemberships)。
  async getMe(): Promise<Result<XidUser, { message: string; status: number }>> {
    return this.#request<XidUser>('/v1/me')
  }

  // GET /v1/users/{userId}。
  async getUser(userId: string): Promise<Result<XidUser, { message: string; status: number }>> {
    return this.#request<XidUser>(`/v1/users/${encodeURIComponent(userId)}`)
  }

  // GET /v1/users:分页列表。
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

// currentUser():App Router server context 中读取完整 User。
// 依赖 auth() 取 userId,再调 Management API /v1/users/{userId}。
// secretKey 从 process.env.XID_SECRET_KEY 读取(与 xidClient 同一约定)。
export async function currentUser(clientOptions?: XidServerClientOptions): Promise<XidUser | null> {
  const authResult = await auth()
  if (!authResult.userId) return null

  const sk =
    clientOptions?.secretKey ??
    (typeof process !== 'undefined' ? process.env['XID_SECRET_KEY'] : undefined)
  if (!sk) return null

  const client = xidClient({ secretKey: sk, ...clientOptions })
  const result = await client.getUser(authResult.userId)
  return result.ok ? result.value : null
}
