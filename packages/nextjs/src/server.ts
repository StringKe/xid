// App Router server context（对标 @clerk/nextjs auth / currentUser）；Pages 用 getAuth。

import { trimTrailingSlashes } from '@xid-kit/core'
import type { XidUser } from '@xid-kit/core'
import type { Result } from '@xid-kit/types'

import { parseAuthHeader, resolveAuthSecret } from './auth-header'
import type { AuthResult, XidServerClientOptions } from './types'

// peer dep 契约；动态 import 避免非 RSC 环境硬依赖 next/headers 崩溃。
type ReadonlyHeaders = Pick<Headers, 'get' | 'has' | 'entries' | 'keys' | 'values' | 'forEach'>

async function getNextHeaders(): Promise<ReadonlyHeaders> {
  const mod = (await import('next/headers')) as unknown as {
    headers: () => ReadonlyHeaders | Promise<ReadonlyHeaders>
  }
  const result = mod.headers()
  // Next.js 15+ 返回 Promise。
  return result instanceof Promise ? await result : result
}

// 不在此引入 React.cache，以免 server-only 约束污染 library bundle；需要去重时在调用方 cache(auth)。
export async function auth(): Promise<AuthResult> {
  try {
    const headers = await getNextHeaders()
    const raw = headers.get('x-xid-auth')
    return parseAuthHeader(raw, resolveAuthSecret())
  } catch {
    // 非 App Router（Pages / 纯 Node）：无法读 headers，按未认证。
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

// 信任 middleware 注入的 x-xid-auth：matcher 须覆盖路由，部署边界须剥离客户端该头；
// 配置 XID_AUTH_HMAC_SECRET 后校验签名，无有效签名一律未认证。
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

// secretKey 默认读 process.env.XID_SECRET_KEY（与 xidClient 约定一致）。
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
