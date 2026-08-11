// Host -> TenantContext 注入;issuer/密钥/rpId/策略唯一来源。失败统一 404,不泄露租户是否存在。

import { sha256Hex } from '@xid-kit/crypto'
import {
  resolveTenantContext,
  resolveTenantContextByApplicationClientId,
  resolveTenantContextBySessionHash,
} from '@xid-kit/db'
import type { MiddlewareHandler } from 'hono'
import { readRefreshTokenCookiesInPriorityOrder } from '../lib/cookies'
import { sessionCandidateFromRow } from '../lib/session'
import type { XidHonoEnv } from '../lib/types'

// 模糊 404:不区分"主机无对应租户"/"租户被暂停",统一最小响应体。
function notFound(): Response {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  })
}

const CLIENT_QUERY_PATHS = new Set([
  '/authorize',
  '/userinfo',
  '/end_session',
  '/check_session',
  '/sign-in',
  '/sign-up',
  '/auth/config',
  '/consent',
  '/mfa',
  '/select-organization',
  '/account/security',
])
const CLIENT_FORM_PATHS = new Set([
  '/par',
  '/token',
  '/introspect',
  '/revoke',
  '/device_authorization',
  '/backchannel_authentication',
])

function decodeBasicClientId(header: string | undefined): string | null {
  const match = header?.match(/^Basic\s+(.+)$/i)
  if (!match?.[1]) return null
  try {
    const decoded = atob(match[1])
    const separator = decoded.indexOf(':')
    if (separator < 0) return null
    return decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, ' '))
  } catch {
    return null
  }
}

type ProtocolClientHint =
  | { kind: 'none' }
  | { kind: 'valid'; clientId: string }
  | { kind: 'invalid' }

async function protocolClientHint(request: Request): Promise<ProtocolClientHint> {
  const url = new URL(request.url)
  if (CLIENT_QUERY_PATHS.has(url.pathname)) {
    if (!url.searchParams.has('client_id')) return { kind: 'none' }
    const values = url.searchParams.getAll('client_id')
    const clientId = values.length === 1 ? values[0]?.trim() : ''
    return clientId ? { kind: 'valid', clientId } : { kind: 'invalid' }
  }
  if (url.pathname.startsWith('/register/')) {
    try {
      const value = decodeURIComponent(url.pathname.slice('/register/'.length)).trim()
      return value ? { kind: 'valid', clientId: value } : { kind: 'invalid' }
    } catch {
      return { kind: 'invalid' }
    }
  }
  if (!CLIENT_FORM_PATHS.has(url.pathname) || request.method !== 'POST') return { kind: 'none' }
  const authorization = request.headers.get('authorization') ?? undefined
  if (authorization !== undefined) {
    const basic = decodeBasicClientId(authorization)
    return basic ? { kind: 'valid', clientId: basic } : { kind: 'invalid' }
  }
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/x-www-form-urlencoded')) return { kind: 'none' }
  try {
    const form = await request.clone().formData()
    if (!form.has('client_id')) return { kind: 'none' }
    const values = form.getAll('client_id')
    const clientId = values.length === 1 && typeof values[0] === 'string' ? values[0].trim() : ''
    return clientId ? { kind: 'valid', clientId } : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}

// 解析 TenantContext 并注入。失败短路返回 404,不进入后续 handler。
export const tenantMiddleware: MiddlewareHandler<XidHonoEnv> = async (c, next) => {
  const clientHint = await protocolClientHint(c.req.raw)
  if (clientHint.kind === 'valid') {
    const protocolTenant = await resolveTenantContextByApplicationClientId(
      c.req.raw,
      c.env,
      clientHint.clientId,
    )
    if (protocolTenant.ok) {
      c.set('tenant', protocolTenant.value)
      await next()
      return
    }
    // 有 client_id 时不可回落到无关浏览器 cookie;未知/停用 client 仍进 Host 解析上下文以返回协议错误。
    const hostTenant = await resolveTenantContext(c.req.raw, c.env)
    if (!hostTenant.ok) return notFound()
    c.set('tenant', hostTenant.value)
    await next()
    return
  }
  if (clientHint.kind === 'invalid') {
    const hostTenant = await resolveTenantContext(c.req.raw, c.env)
    if (!hostTenant.ok) return notFound()
    c.set('tenant', hostTenant.value)
    await next()
    return
  }

  const tokens = readRefreshTokenCookiesInPriorityOrder(c)
  for (const token of tokens) {
    const refreshTokenHash = await sha256Hex(token)
    const sessionResult = await resolveTenantContextBySessionHash(
      c.req.raw,
      c.env,
      refreshTokenHash,
    )
    if (!sessionResult.ok) continue
    c.set('tenant', sessionResult.value.tenant)
    if (sessionResult.value.status === 'resolved' && sessionResult.value.session) {
      c.set(
        'sessionCandidate',
        sessionCandidateFromRow(refreshTokenHash, sessionResult.value.session),
      )
    }
    await next()
    return
  }
  const result = await resolveTenantContext(c.req.raw, c.env)
  if (!result.ok) return notFound()
  c.set('tenant', result.value)
  await next()
}
