// networkless 默认传 jwtKey 本地验签;仅显式构造 JwksCache 才回源。

import type { Jwks, PublicJwk, VerifyKeySet } from '@xid-kit/crypto'
import { importJwkForVerify } from '@xid-kit/crypto'

import { AppError } from './errors'

export type JwtKey =
  | PublicJwk
  | Jwks
  | { readonly alg: PublicJwk['alg']; readonly publicKey: CryptoKey }

function isJwks(key: JwtKey): key is Jwks {
  return 'keys' in key && Array.isArray((key as Jwks).keys)
}

function isImportedKey(key: JwtKey): key is { alg: PublicJwk['alg']; publicKey: CryptoKey } {
  return 'publicKey' in key
}

// 单 CryptoKey 无 kid 时用占位空 kid,verifyJwt 对单钥集忽略 kid;多 kid 轮换须传 JWKS。
export async function toVerifyKeySet(key: JwtKey): Promise<VerifyKeySet> {
  if (isImportedKey(key)) {
    return { keys: [{ kid: '', alg: key.alg, publicKey: key.publicKey }] }
  }
  const jwks: readonly PublicJwk[] = isJwks(key) ? key.keys : [key as PublicJwk]
  const keys = await Promise.all(
    jwks.map(async (jwk) => ({
      kid: jwk.kid,
      alg: jwk.alg,
      publicKey: await importJwkForVerify(jwk),
    })),
  )
  return { keys }
}

const DEFAULT_JWKS_TTL_SEC = 3600

export type JwksCacheOptions = {
  jwksUri: string
  ttlSec?: number
  fetchFn?: typeof fetch
}

type CacheEntry = {
  set: VerifyKeySet
  expiresAt: number
}

// 显式 opt-in 回源缓存;构造即接受网络,networkless 路径勿用。
export class JwksCache {
  private readonly jwksUri: string
  private readonly ttlSec: number
  private readonly fetchFn: typeof fetch
  private entry: CacheEntry | undefined

  constructor(options: JwksCacheOptions) {
    this.jwksUri = options.jwksUri
    this.ttlSec = options.ttlSec ?? DEFAULT_JWKS_TTL_SEC
    this.fetchFn = options.fetchFn ?? fetch
  }

  async getKeys(now: number = Math.floor(Date.now() / 1000)): Promise<VerifyKeySet> {
    if (this.entry && now < this.entry.expiresAt) {
      return this.entry.set
    }
    const set = await this.fetchKeys()
    this.entry = { set, expiresAt: now + this.ttlSec }
    return set
  }

  private async fetchKeys(): Promise<VerifyKeySet> {
    let response: Response
    try {
      response = await this.fetchFn(this.jwksUri, { headers: { accept: 'application/json' } })
    } catch (cause) {
      throw new AppError('jwks_fetch_failed', `failed to fetch JWKS from ${this.jwksUri}`, {
        cause,
      })
    }
    if (!response.ok) {
      throw new AppError(
        'jwks_fetch_failed',
        `JWKS endpoint ${this.jwksUri} returned ${response.status}`,
      )
    }
    const body = (await response.json()) as Jwks
    return toVerifyKeySet(body)
  }
}
