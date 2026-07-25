// auth-header:序列化/反序列化注入到 Request headers 的认证对象。
// xidMiddleware 把 AuthResult 序列化写入 x-xid-auth header;auth()/getAuth() 读该 header 还原,
// 避免在每个 server component / route handler 里重复调用 authenticateRequest(networkless 再验签)。
//
// 安全模型(纵深防御):x-xid-auth 携带完整 JWT claims(sub/sid/org_role/permissions),
// 任何外部可写入该 header 的路径都构成鉴权绕过。两道防线:
//   1) 部署层:middleware matcher 必须覆盖所有受保护路由,且边界(CDN/反代/Next)必须剥离
//      客户端传入的 x-xid-auth,只允许 middleware 内部注入(见 xidMiddleware 注释)。
//   2) SDK 层(本模块):配置 XID_AUTH_HMAC_SECRET 后,middleware 用该 secret 对 payload 签 HMAC-SHA256,
//      server context 校验签名后才信任;伪造头无有效签名,直接当未认证。secret 缺省时退回纯 payload,
//      此时安全性完全依赖第 1 道防线 -- 生产环境强烈建议配置 secret。
//
// 头格式:
//   - 纯文本(无 secret):<payloadJson>          payload 为 JSON.stringify(AuthResult)
//   - 签名(有 secret):  v1.<payloadB64url>.<sigBase64>   sig = HMAC-SHA256(secret, payloadB64url)

import { hmacSha256Base64, hmacSha256Verify } from '@xid-kit/crypto'

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

// 解析 secret 来源:显式传入优先,否则读 process.env.XID_AUTH_HMAC_SECRET(server-only,不入 client bundle)。
export function resolveAuthSecret(explicit?: string): string | undefined {
  if (explicit) return explicit
  if (typeof process !== 'undefined' && process.env) {
    const v = process.env['XID_AUTH_HMAC_SECRET']
    if (v) return v
  }
  return undefined
}

// 把 AuthResult 序列化为 header 值。secret 存在 -> 输出带 HMAC 签名的 envelope;否则输出纯 JSON。
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

// 从 header 值还原 AuthResult。
// 配置 secret 时:仅接受带有效签名的 envelope;无签名/签名错/格式错一律视为未认证(防伪造)。
// 未配置 secret 时:接受纯 JSON(退回部署层防线)。
export async function parseAuthHeader(
  raw: string | null | undefined,
  secret?: string,
): Promise<AuthResult> {
  if (!raw) return UNAUTHENTICATED

  const isSigned = raw.startsWith(SIGNED_PREFIX)

  if (secret) {
    // 启用签名校验:必须是签名 envelope 且校验通过。
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

  // 无 secret:兼容签名 envelope(取出 payload,但不校验)与纯 JSON。
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

// 从 Headers 读取 x-xid-auth 并还原(可选签名校验)。
export async function readAuthFromHeaders(headers: Headers, secret?: string): Promise<AuthResult> {
  return parseAuthHeader(headers.get(XID_AUTH_HEADER), secret)
}

function isAuthObject(v: unknown): v is AuthObject {
  return (
    typeof v === 'object' &&
    v !== null &&
    'userId' in v &&
    typeof (v as Record<string, unknown>)['userId'] === 'string'
  )
}

function isUnauthenticated(v: unknown): v is UnauthenticatedAuthObject {
  return (
    typeof v === 'object' &&
    v !== null &&
    'userId' in v &&
    (v as Record<string, unknown>)['userId'] === null
  )
}
