import { trimTrailingSlashes } from '@xid-kit/core'
import type { XidUser } from '@xid-kit/core'
import type { Result } from '@xid-kit/types'

import type { AuthResult, XidServerClientOptions } from './types'

type LocalsLike = Record<string, unknown>

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

export function xidClient(options: XidServerClientOptions): XidServerApiClient {
  return new XidServerApiClient(options)
}

export async function currentUser(
  locals: LocalsLike,
  clientOptions?: XidServerClientOptions,
): Promise<XidUser | null> {
  const authResult = getAuth(locals)
  if (!authResult.userId) return null

  // secretKey 须调用方传入或读 process.env;library 内不能静态引用 import.meta.env。
  const sk =
    clientOptions?.secretKey ??
    (typeof process !== 'undefined' && process.env ? process.env['XID_SECRET_KEY'] : undefined)

  if (typeof sk !== 'string' || !sk) return null

  const client = xidClient({ secretKey: sk, ...clientOptions })
  const result = await client.getUser(authResult.userId)
  return result.ok ? result.value : null
}
