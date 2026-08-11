// 在 middleware 与 auth()/getAuth() 之间序列化 AuthResult，避免每个 RSC/handler 再跑 networkless 验签。
// 安全：x-xid-auth 含完整 claims，外部可写即鉴权绕过。部署边界须剥离客户端该头且 matcher 覆盖受保护路由；
// 配置 XID_AUTH_HMAC_SECRET 后对本模块 payload 做 HMAC（缺省则完全依赖部署层，生产强烈建议开启）。
// 格式：无 secret 为纯 JSON；有 secret 为 v1.<payloadB64url>.<HMAC-SHA256(secret, payloadB64url)>。

import { hmacSha256Base64, hmacSha256Verify } from '@xid-kit/crypto'
import { isOrganizationMembershipRole } from '@xid-kit/types'

import type { AuthObject, AuthResult, UnauthenticatedAuthObject } from './types'
import { XID_AUTH_HEADER } from './types'

const SIGNED_PREFIX = 'v1.'
const encoder = new TextEncoder()

const UNAUTHENTICATED: UnauthenticatedAuthObject = {
  userId: null,
  sessionId: null,
  orgId: null,
  orgRole: null,
  orgPermissions: null,
  claims: null,
}

function base64UrlEncode(input: string): string {
  const bytes = encoder.encode(input)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replaceAll('=', '')
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

// 显式参数优先，否则读 process.env（server-only，不入 client bundle）。
export function resolveAuthSecret(explicit?: string): string | undefined {
  if (explicit) return explicit
  if (typeof process !== 'undefined' && process.env) {
    const v = process.env['XID_AUTH_HMAC_SECRET']
    if (v) return v
  }
  return undefined
}

export async function serializeAuthHeader(auth: AuthResult, secret?: string): Promise<string> {
  const payload = JSON.stringify(auth)
  if (!secret) return payload
  const payloadB64 = base64UrlEncode(payload)
  const sig = await hmacSha256Base64(encoder.encode(secret), payloadB64)
  return `${SIGNED_PREFIX}${payloadB64}.${sig}`
}

function decodeAuthObject(parsed: unknown): AuthResult {
  if (isAuthObject(parsed)) return parsed
  if (isUnauthenticated(parsed)) return UNAUTHENTICATED
  return UNAUTHENTICATED
}

// 有 secret：仅接受有效 HMAC envelope，其余一律未认证。无 secret：接受纯 JSON，也解签 envelope 但不验签。
export async function parseAuthHeader(
  raw: string | null | undefined,
  secret?: string,
): Promise<AuthResult> {
  if (!raw) return UNAUTHENTICATED

  const isSigned = raw.startsWith(SIGNED_PREFIX)

  if (secret) {
    if (!isSigned) return UNAUTHENTICATED
    const rest = raw.slice(SIGNED_PREFIX.length)
    const dot = rest.lastIndexOf('.')
    if (dot <= 0) return UNAUTHENTICATED
    const payloadB64 = rest.slice(0, dot)
    const sig = rest.slice(dot + 1)
    const valid = await hmacSha256Verify(encoder.encode(secret), payloadB64, sig)
    if (!valid) return UNAUTHENTICATED
    try {
      return decodeAuthObject(JSON.parse(base64UrlDecode(payloadB64)) as unknown)
    } catch {
      return UNAUTHENTICATED
    }
  }

  try {
    if (isSigned) {
      const rest = raw.slice(SIGNED_PREFIX.length)
      const dot = rest.lastIndexOf('.')
      if (dot <= 0) return UNAUTHENTICATED
      return decodeAuthObject(JSON.parse(base64UrlDecode(rest.slice(0, dot))) as unknown)
    }
    return decodeAuthObject(JSON.parse(raw) as unknown)
  } catch {
    return UNAUTHENTICATED
  }
}

export async function readAuthFromHeaders(headers: Headers, secret?: string): Promise<AuthResult> {
  return parseAuthHeader(headers.get(XID_AUTH_HEADER), secret)
}

function isAuthObject(v: unknown): v is AuthObject {
  if (typeof v !== 'object' || v === null) return false
  const record = v as Record<string, unknown>
  if (typeof record['userId'] !== 'string') return false
  if (record['orgRole'] !== undefined && !isOrganizationMembershipRole(record['orgRole'])) {
    return false
  }
  const claims = record['claims']
  if (
    typeof claims === 'object' &&
    claims !== null &&
    (claims as Record<string, unknown>)['org_role'] !== undefined &&
    !isOrganizationMembershipRole((claims as Record<string, unknown>)['org_role'])
  ) {
    return false
  }
  return true
}

function isUnauthenticated(v: unknown): v is UnauthenticatedAuthObject {
  return (
    typeof v === 'object' &&
    v !== null &&
    'userId' in v &&
    (v as Record<string, unknown>)['userId'] === null
  )
}
