// token 刷新逻辑(对照 06 章:getToken 返回 short-lived JWT,建议 60s;到期前刷新)。
// 缓存当前 token,距 exp 小于 leeway 即从 /v1/sessions/token 取新;并发 getToken 去重为单次在途请求。
// 不在前端验签(crypto-boundary rule),只解码 exp 调度刷新(见 jwt-decode)。

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
  // 在途刷新去重:并发 getToken 只发一次请求。
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

  // 清缓存(sign-out / 切换会话后调用,防旧 token 泄漏到新上下文)。
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

    // A sign-out or session switch can clear state while the request is in flight. Do not let
    // that stale completion repopulate the cache for the new browser session.
    if (this.#generation === generation) this.#cache = toCachedToken(result.value)
    return { ok: true, value: result.value.token }
  }
}

function toCachedToken(response: TokenResponse): CachedToken {
  const claims = decodeTokenClaims(response.token)
  return { jwt: response.token, expireAt: typeof claims?.exp === 'number' ? claims.exp : null }
}
