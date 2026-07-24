// client 认证辅助:client_secret_basic / client_secret_post / private_key_jwt / none+PKCE。
// 见 oidc-oauth rule / docs/design/03-oidc-oauth.md 客户端认证表。
// 铁律:TenantContext 从 c.get('tenant') 取;D1 查询走 @xid-kit/db 租户查询层;
//        client_secret 哈希比较,不存明文。

import { eq } from 'drizzle-orm'
import { sha256Hex, verifyJwt, importJwkForVerify } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import type { SigningAlg, Result } from '@xid-kit/types'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../../lib/types'
import { readTlsClientAuth, verifyTlsClientAuth } from '../../oidc/mtls'
import { tlsSubjectDnFromClient } from '../../oidc/mtls'
import { claimReplayKey } from '../../oidc/replay-claim'
import { PRIVATE_KEY_JWT_WINDOW_SEC } from '../../lib/ttl'

export type AuthenticatedClient = {
  clientId: string
  clientType: string
  allowedGrantTypes: string[]
  allowedScopes: string[]
  requirePkce: boolean
  dpopBoundAccessTokens: boolean
  accessTokenTtlSec: number | null
  idTokenSignedAlg: string
  redirectUris: string[]
  firstParty: boolean
}

export type ClientAuthOptions = {
  requireConfidential?: boolean
}

type ClientRow = typeof schema.applications.$inferSelect

type ParsedCredentials = {
  clientId: string | null
  clientSecret: string | null
  clientAssertionType: string | null
  clientAssertion: string | null
}

function rowToClient(row: ClientRow): AuthenticatedClient {
  return {
    clientId: row.clientId,
    clientType: row.clientType,
    allowedGrantTypes: row.allowedGrantTypes,
    allowedScopes: row.allowedScopes,
    requirePkce: row.requirePkce,
    dpopBoundAccessTokens: row.dpopBoundAccessTokens,
    accessTokenTtlSec: row.accessTokenTtlSec,
    idTokenSignedAlg: row.idTokenSignedAlg,
    redirectUris: row.redirectUris,
    firstParty: row.firstParty,
  }
}

function clientErr(message: string): Result<never, { message: string }> {
  return { ok: false, error: { message } }
}

// Constant-time string comparison(防时序侧信道)。
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// Basic auth 解析:Authorization: Basic base64(client_id:client_secret)。
function parseBasicAuth(authHeader: string): { clientId: string; clientSecret: string } | null {
  const match = /^Basic\s+(.+)$/i.exec(authHeader)
  if (!match || !match[1]) return null
  let decoded: string
  try {
    decoded = atob(match[1])
  } catch {
    return null
  }
  const colon = decoded.indexOf(':')
  if (colon < 1) return null
  return { clientId: decoded.slice(0, colon), clientSecret: decoded.slice(colon + 1) }
}

// form body 解析:client_secret_post / private_key_jwt / none。
async function parseFormCredentials(c: Context<XidHonoEnv>): Promise<Partial<ParsedCredentials>> {
  try {
    const form = await c.req.formData()
    const clientId = form.get('client_id')
    const clientSecret = form.get('client_secret')
    const clientAssertionType = form.get('client_assertion_type')
    const clientAssertion = form.get('client_assertion')
    return {
      clientId: typeof clientId === 'string' ? clientId : null,
      clientSecret:
        typeof clientSecret === 'string' && clientSecret.length > 0 ? clientSecret : null,
      clientAssertionType: typeof clientAssertionType === 'string' ? clientAssertionType : null,
      clientAssertion: typeof clientAssertion === 'string' ? clientAssertion : null,
    }
  } catch {
    return {}
  }
}

// 解析所有认证凭证来源:Basic header 优先,再 form body 补充。
async function extractCredentials(c: Context<XidHonoEnv>): Promise<ParsedCredentials> {
  const creds: ParsedCredentials = {
    clientId: null,
    clientSecret: null,
    clientAssertionType: null,
    clientAssertion: null,
  }
  const authHeader = c.req.header('authorization') ?? ''
  if (authHeader) {
    const basic = parseBasicAuth(authHeader)
    if (basic) {
      creds.clientId = basic.clientId
      creds.clientSecret = basic.clientSecret
    }
  }
  const form = await parseFormCredentials(c)
  if (!creds.clientId && form.clientId) creds.clientId = form.clientId
  if (!creds.clientSecret && form.clientSecret) creds.clientSecret = form.clientSecret
  if (form.clientAssertionType) creds.clientAssertionType = form.clientAssertionType
  if (form.clientAssertion) creds.clientAssertion = form.clientAssertion
  return creds
}

// private_key_jwt 校验单个 JWK:验签(client 注册公钥)+ aud=token_endpoint + exp<=5min + jti 必存。
// 返回验证通过的 jti(供一次性占用),失败返回 null。
async function tryVerifyOneJwk(
  assertion: string,
  clientId: string,
  tokenEndpoint: string,
  jwk: Record<string, unknown>,
): Promise<string | null> {
  const alg = (jwk['alg'] as string | undefined) ?? 'RS256'
  const publicKey = await importJwkForVerify(jwk as unknown as import('@xid-kit/crypto').PublicJwk)
  const now = Math.floor(Date.now() / 1000)
  const result = await verifyJwt(
    assertion,
    { alg: alg as SigningAlg, publicKey },
    {
      expectedIssuer: clientId,
      expectedAudience: tokenEndpoint,
      now,
      clockToleranceSec: 30,
    },
  )
  if (!result.ok) return null
  const payload = result.value.payload
  if (payload.sub !== clientId) return null
  const iat = typeof payload.iat === 'number' ? payload.iat : 0
  if (typeof payload.exp !== 'number' || payload.exp - iat > 300) return null
  const jti = payload.jti
  if (typeof jti !== 'string' || jti.length === 0) return null
  return jti
}

// private_key_jwt 校验(oidc-oauth rule):任一注册公钥验签通过即返回 jti,失败返回 null。
async function verifyPrivateKeyJwt(
  assertion: string,
  clientId: string,
  tokenEndpoint: string,
  row: ClientRow,
): Promise<string | null> {
  if (!row.jwks || typeof row.jwks !== 'object') return null
  const jwksRaw = row.jwks as Record<string, unknown>
  const keysArr = Array.isArray(jwksRaw['keys']) ? (jwksRaw['keys'] as unknown[]) : []
  for (const jwk of keysArr) {
    try {
      const jti = await tryVerifyOneJwk(
        assertion,
        clientId,
        tokenEndpoint,
        jwk as Record<string, unknown>,
      )
      if (jti !== null) return jti
    } catch {
      continue
    }
  }
  return null
}

// jti 一次性占用由 OAuthFlowDO 单次 claim 保证。
async function claimAssertionJti(
  c: Context<XidHonoEnv>,
  clientId: string,
  jti: string,
): Promise<Result<true, { message: string }>> {
  const ctx = c.get('tenant')
  const ns = c.env.OAUTH_STATE
  const claim = await claimReplayKey({
    stub: ns.get(ns.idFromName(`pkjwt:${ctx.tenantId}`)),
    key: `${clientId}#${jti}`,
    ttlMs: PRIVATE_KEY_JWT_WINDOW_SEC * 1000,
  })
  if (!claim.ok) return clientErr(claim.error.message)
  if (!claim.claimed) return clientErr('client_assertion jti replayed')
  return { ok: true, value: true }
}

// secret-based 认证(client_secret_basic / client_secret_post)。
async function authenticateBySecret(
  row: ClientRow,
  clientSecret: string | null,
): Promise<Result<AuthenticatedClient, { message: string }>> {
  if (!clientSecret) return clientErr('client_secret missing')
  if (!row.clientSecretHash) return clientErr('client has no secret configured')
  const supplied = await sha256Hex(clientSecret)
  if (!timingSafeEqual(supplied, row.clientSecretHash)) return clientErr('invalid client_secret')
  return { ok: true, value: rowToClient(row) }
}

// private_key_jwt 认证(验签 + claims + jti 一次性防重放)。
async function authenticateByAssertion(
  c: Context<XidHonoEnv>,
  row: ClientRow,
  creds: ParsedCredentials,
  issuer: string,
): Promise<Result<AuthenticatedClient, { message: string }>> {
  const expectedType = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  if (creds.clientAssertionType !== expectedType) return clientErr('invalid client_assertion_type')
  if (!creds.clientAssertion) return clientErr('client_assertion missing')
  const tokenEndpoint = `${issuer}/token`
  const jti = await verifyPrivateKeyJwt(creds.clientAssertion, row.clientId, tokenEndpoint, row)
  if (jti === null) return clientErr('invalid client_assertion')
  const claim = await claimAssertionJti(c, row.clientId, jti)
  if (!claim.ok) return claim
  return { ok: true, value: rowToClient(row) }
}

// 主认证函数:按 token_endpoint_auth_method 分支认证。
// requireConfidential=true 时拒绝 public client(none 方法)。
export async function authenticateClient(
  c: Context<XidHonoEnv>,
  opts: ClientAuthOptions = {},
): Promise<Result<AuthenticatedClient, { message: string }>> {
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)
  const creds = await extractCredentials(c)

  if (!creds.clientId) return clientErr('client_id missing')

  const row = await db.applications.findOne(eq(schema.applications.clientId, creds.clientId))
  if (!row) return clientErr('client not found')
  if (row.status !== 'active') return clientErr('client inactive')

  const method = row.tokenEndpointAuthMethod

  if (method === 'none') {
    if (opts.requireConfidential) return clientErr('confidential client required')
    return { ok: true, value: rowToClient(row) }
  }
  if (method === 'client_secret_basic' || method === 'client_secret_post') {
    return authenticateBySecret(row, creds.clientSecret)
  }
  if (method === 'private_key_jwt') {
    return authenticateByAssertion(c, row, creds, ctx.issuer)
  }
  if (method === 'tls_client_auth' || method === 'self_signed_tls_client_auth') {
    const tls = readTlsClientAuth(c)
    if (!tls || !verifyTlsClientAuth(row, tls) || !tlsSubjectDnFromClient(row)) {
      return clientErr('tls client certificate authentication failed')
    }
    return { ok: true, value: rowToClient(row) }
  }
  return clientErr(`unsupported token_endpoint_auth_method: ${method}`)
}
