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

// 每个 template(含默认)独立缓存槽:默认 session token 与自定义模板 token 互不覆盖。
const DEFAULT_TEMPLATE = '__default__'

export class TokenManager {
  readonly #api: XidApiClient
  readonly #now: () => number
  readonly #cache = new Map<string, CachedToken>()
  // 在途刷新去重:同一 template 并发只发一次请求。
  readonly #inflight = new Map<string, Promise<Result<string, XidError>>>()

  constructor(input: { api: XidApiClient; now: () => number }) {
    this.#api = input.api
    this.#now = input.now
  }

  async getToken(options: GetTokenOptions = {}): Promise<Result<string, XidError>> {
    const template = options.template ?? DEFAULT_TEMPLATE
    const leeway = options.leewaySeconds ?? DEFAULT_LEEWAY_SECONDS

    if (!options.skipCache) {
      const cached = this.#cache.get(template)
      if (cached && !this.#isExpiring(cached, leeway)) {
        return { ok: true, value: cached.jwt }
      }
    }

    return this.#refresh(template, options)
  }

  // 清缓存(sign-out / 切换会话后调用,防旧 token 泄漏到新上下文)。
  clear(): void {
    this.#cache.clear()
    this.#inflight.clear()
  }

  #isExpiring(cached: CachedToken, leeway: number): boolean {
    const now = this.#now()
    if (typeof cached.expireAt === 'number') return now + leeway >= cached.expireAt
    return isTokenExpiring(cached.jwt, now, leeway)
  }

  async #refresh(template: string, options: GetTokenOptions): Promise<Result<string, XidError>> {
    const existing = this.#inflight.get(template)
    if (existing) return existing

    const promise = this.#fetchToken(template, options).finally(() => {
      this.#inflight.delete(template)
    })
    this.#inflight.set(template, promise)
    return promise
  }

  async #fetchToken(template: string, options: GetTokenOptions): Promise<Result<string, XidError>> {
    const requestTemplate = template === DEFAULT_TEMPLATE ? undefined : template
    const result = await this.#api.getToken({
      ...(requestTemplate ? { template: requestTemplate } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (!result.ok) return result

    this.#cache.set(template, toCachedToken(result.value))
    return { ok: true, value: result.value.jwt }
  }
}

function toCachedToken(response: TokenResponse): CachedToken {
  if (typeof response.expireAt === 'number') {
    return { jwt: response.jwt, expireAt: response.expireAt }
  }
  const claims = decodeTokenClaims(response.jwt)
  return { jwt: response.jwt, expireAt: typeof claims?.exp === 'number' ? claims.exp : null }
}
