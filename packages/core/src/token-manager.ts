// short-lived JWT 缓存与到期前刷新;并发 getToken 去重,只解码 exp 不验签。

import type { Result, XidError } from '@xid-kit/types'

import type { XidApiClient, TokenResponse } from './api-client'
import type { GetTokenOptions } from './types'
import { decodeTokenClaims, isTokenExpiring } from './jwt-decode'

const DEFAULT_LEEWAY_SECONDS = 10

type CachedToken = {
  jwt: string
  expireAt: number | null
}

export class TokenManager {
  readonly #api: XidApiClient
  readonly #now: () => number
  #cache: CachedToken | null = null
  #inflight: Promise<Result<string, XidError>> | null = null
  #generation = 0

  constructor(input: { api: XidApiClient; now: () => number }) {
    this.#api = input.api
    this.#now = input.now
  }

  async getToken(options: GetTokenOptions = {}): Promise<Result<string, XidError>> {
    const leeway = options.leewaySeconds ?? DEFAULT_LEEWAY_SECONDS

    if (!options.skipCache) {
      const cached = this.#cache
      if (cached && !this.#isExpiring(cached, leeway)) {
        return { ok: true, value: cached.jwt }
      }
    }

    return this.#refresh(options)
  }

  // sign-out / 切会话后清缓存,防止旧 token 落到新上下文。
  clear(): void {
    this.#generation += 1
    this.#cache = null
    this.#inflight = null
  }

  #isExpiring(cached: CachedToken, leeway: number): boolean {
    const now = this.#now()
    if (typeof cached.expireAt === 'number') return now + leeway >= cached.expireAt
    return isTokenExpiring(cached.jwt, now, leeway)
  }

  async #refresh(options: GetTokenOptions): Promise<Result<string, XidError>> {
    const existing = this.#inflight
    if (existing) return existing

    const generation = this.#generation
    const promise = this.#fetchToken(options, generation).finally(() => {
      if (this.#inflight === promise) this.#inflight = null
    })
    this.#inflight = promise
    return promise
  }

  async #fetchToken(
    options: GetTokenOptions,
    generation: number,
  ): Promise<Result<string, XidError>> {
    const result = await this.#api.getToken({
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (!result.ok) return result

    // clear() 会抬 generation;在途完成不得把过期会话的 token 写回新会话缓存。
    if (this.#generation === generation) this.#cache = toCachedToken(result.value)
    return { ok: true, value: result.value.token }
  }
}

function toCachedToken(response: TokenResponse): CachedToken {
  const claims = decodeTokenClaims(response.token)
  return { jwt: response.token, expireAt: typeof claims?.exp === 'number' ? claims.exp : null }
}
