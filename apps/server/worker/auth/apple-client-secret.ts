// Sign in with Apple 的 client_secret 是 ES256 JWT(iss=Team ID, sub=client_id,
// aud=https://appleid.apple.com, exp 不超过 6 个月)。配置了 APPLE_TEAM_ID、APPLE_KEY_ID、
// APPLE_PRIVATE_KEY(.p8 PKCS#8 PEM)时按需签发短期 JWT 并在 isolate 内缓存到临近过期。

import { signJwt } from '@xid-kit/crypto'
import { AppError } from '../lib/errors'
import {
  APPLE_CLIENT_SECRET_LIFETIME_SEC,
  APPLE_CLIENT_SECRET_REFRESH_MARGIN_SEC,
} from '../lib/ttl'

const APPLE_AUDIENCE = 'https://appleid.apple.com'

export type AppleSigningConfig = {
  teamId: string
  keyId: string
  privateKeyPem: string
}

export type AppleSigningState =
  | { kind: 'complete'; config: AppleSigningConfig }
  | { kind: 'absent' }
  | { kind: 'partial' }

function presentValue(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

// 三个变量全有才签发;全无回落到静态 APPLE_CLIENT_SECRET;只配一部分是配置错误,调用方 fail closed。
export function appleSigningState(env: Env): AppleSigningState {
  const teamId = presentValue(env.APPLE_TEAM_ID)
  const keyId = presentValue(env.APPLE_KEY_ID)
  const privateKeyPem = presentValue(env.APPLE_PRIVATE_KEY)
  if (teamId && keyId && privateKeyPem) {
    return { kind: 'complete', config: { teamId, keyId, privateKeyPem } }
  }
  if (!teamId && !keyId && !privateKeyPem) return { kind: 'absent' }
  return { kind: 'partial' }
}

function pkcs8Bytes(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replaceAll('\\n', '\n')
    .replace(/-----(?:BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')
  const raw = atob(body)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function importApplePrivateKey(pem: string): Promise<CryptoKey> {
  let bytes: Uint8Array<ArrayBuffer> | null = null
  try {
    bytes = pkcs8Bytes(pem)
    return await crypto.subtle.importKey(
      'pkcs8',
      bytes,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
  } catch (cause) {
    throw new AppError('server_error', { cause })
  } finally {
    bytes?.fill(0)
  }
}

type CachedSecret = {
  privateKeyPem: string
  key: Promise<CryptoKey>
  token: string | null
  expiresAt: number
}

const secretCache = new Map<string, CachedSecret>()

function cacheEntry(config: AppleSigningConfig, clientId: string): CachedSecret {
  const cacheKey = `${config.teamId}:${config.keyId}:${clientId}`
  const existing = secretCache.get(cacheKey)
  if (existing && existing.privateKeyPem === config.privateKeyPem) return existing
  const entry: CachedSecret = {
    privateKeyPem: config.privateKeyPem,
    key: importApplePrivateKey(config.privateKeyPem),
    token: null,
    expiresAt: 0,
  }
  // 导入失败不留在缓存里,下次请求重新读取 Secret。
  void entry.key.catch(() => secretCache.delete(cacheKey))
  secretCache.set(cacheKey, entry)
  return entry
}

export async function appleClientSecret(
  config: AppleSigningConfig,
  clientId: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const entry = cacheEntry(config, clientId)
  if (entry.token && nowSec < entry.expiresAt - APPLE_CLIENT_SECRET_REFRESH_MARGIN_SEC) {
    return entry.token
  }
  const expiresAt = nowSec + APPLE_CLIENT_SECRET_LIFETIME_SEC
  const token = await signJwt(
    {
      header: { alg: 'ES256', kid: config.keyId },
      payload: {
        iss: config.teamId,
        sub: clientId,
        aud: APPLE_AUDIENCE,
        iat: nowSec,
        exp: expiresAt,
      },
    },
    await entry.key,
  )
  entry.token = token
  entry.expiresAt = expiresAt
  return token
}
