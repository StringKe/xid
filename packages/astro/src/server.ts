// server.ts:Astro SSR server 侧 helper。
// getAuth(locals):从 Astro.locals 读取 middleware 注入的 AuthResult(同步,无网络)。
// currentUser(locals, options):懒加载 /v1/me 完整 User。
// xidClient(options):server 端 Management API 入口(sk_ 认证)。

import type { XidUser } from '@xid-kit/core'
import type { Result } from '@xid-kit/types'

import type { AuthResult, XidServerClientOptions } from './types'

type LocalsLike = Record<string, unknown>

// getAuth:从 Astro.locals 读取 xidAuth(middleware 注入)。
// 直接同步读取,无网络开销。locals 不含 xidAuth 时返回未认证。
export function getAuth(locals: LocalsLike): AuthResult {
  const auth = locals['xidAuth']
  if (isAuthResult(auth)) return auth
  return UNAUTHENTICATED
}

const UNAUTHENTICATED: AuthResult = {
  userId: null,
  sessionId: null,
  orgId: null,
  orgRole: null,
  orgPermissions: null,
  claims: null,
}

function isAuthResult(v: unknown): v is AuthResult {
  return typeof v === 'object' && v !== null && 'userId' in v
}

// XidServerApiClient:server 端 Management API 入口(sk_ 认证)。
class XidServerApiClient {
  readonly #secretKey: string
  readonly #baseUrl: string
  readonly #fetcher: typeof fetch

  constructor(options: XidServerClientOptions) {
    this.#secretKey = options.secretKey
    this.#baseUrl = (options.apiUrl ?? 'https://api.xid.dev').replace(/\/+$/, '')
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
  }

  async getMe(): Promise<Result<XidUser, { message: string; status: number }>> {
    return this.#request<XidUser>('/v1/me')
  }

  async getUser(userId: string): Promise<Result<XidUser, { message: string; status: number }>> {
    return this.#request<XidUser>(`/v1/users/${encodeURIComponent(userId)}`)
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

function parseJsonSafe(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// xidClient 工厂函数:server 端 Management API 入口。
// 用法:const client = xidClient({ secretKey: import.meta.env.XID_SECRET_KEY })
export function xidClient(options: XidServerClientOptions): XidServerApiClient {
  return new XidServerApiClient(options)
}

// currentUser:从 Astro.locals 读 userId,再调 Management API /v1/users/{userId}。
export async function currentUser(
  locals: LocalsLike,
  clientOptions?: XidServerClientOptions,
): Promise<XidUser | null> {
  const authResult = getAuth(locals)
  if (!authResult.userId) return null

  // secretKey 优先从调用方传入;其次读 process.env(Node/Bun);
  // Astro SSR vite 环境下 import.meta.env 在 .astro 文件中可用,
  // 但 library 内不能静态引用,由调用方在 .astro 文件中显式传入。
  const sk =
    clientOptions?.secretKey ??
    (typeof process !== 'undefined' && process.env ? process.env['XID_SECRET_KEY'] : undefined)

  if (typeof sk !== 'string' || !sk) return null

  const client = xidClient({ secretKey: sk, ...clientOptions })
  const result = await client.getUser(authResult.userId)
  return result.ok ? result.value : null
}
