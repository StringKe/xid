// JWKS 解析与缓存(见 signing-keys rule:JWKS 经 KV 缓存 TTL 1h,SDK networkless 验证直读公钥不回源)。
// networkless 铁律:默认传入 jwtKey(公钥)本地验签,不发网络;仅在显式构造 JwksCache 时才回源。
// 公钥导入复用 @xid-kit/crypto importJwkForVerify,不重造验签/密钥导入。

import type { Jwks, PublicJwk, VerifyKeySet } from '@xid-kit/crypto'
import { importJwkForVerify } from '@xid-kit/crypto'

import { AppError } from './errors'

// 后端 SDK 接受的公钥形态:单条 JWK、JWKS、或已导入的 CryptoKey(配 alg)。
// 与 @xid-kit/types SigningAlg 对齐(ES256/RS256/PS256)。
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

// 把 JwtKey 归一为 crypto.verifyJwt 期望的 VerifyKeySet(按 kid 选公钥,支持多 kid 并存)。
// 已导入的 CryptoKey 没有 kid,用占位空 kid;verifyJwt 对单钥集忽略 kid 直接验签(token 带真实 kid 也能过),
// 故单 CryptoKey 形态对任意 kid 的 token 可用。多 kid 轮换场景仍应传 JWKS 让 verifyJwt 按 token header.kid 精确选钥。
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
  // JWKS endpoint(如 https://{tenant}.xid.dev/jwks)。
  jwksUri: string
  // 缓存 TTL(秒),默认 3600(对齐 KV JWKS 缓存 TTL 1h,见 signing-keys rule)。
  ttlSec?: number
  // 注入 fetch(测试/自定义运行时);默认全局 fetch。
  fetchFn?: typeof fetch
}

type CacheEntry = {
  set: VerifyKeySet
  expiresAt: number
}

// 可选回源:从 JWKS endpoint 拉取并按 TTL 缓存,供未持有 jwtKey 的运行时使用。
// networkless 默认路径不构造此类;构造即明确接受网络回源。
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

  // 返回 verify key set;命中未过期缓存直接返回,否则回源刷新。
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
