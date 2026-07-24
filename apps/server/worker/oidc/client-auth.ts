// 客户端认证(03 章 9.6,RFC6749 2.3 / RFC7591)。按 client 注册的 token_endpoint_auth_method
// 选定唯一一种校验:client_secret_basic / client_secret_post / private_key_jwt / none(public)。
// client_secret 哈希存储(SHA-256),constant-time 比对;不存明文(见 oidc-oauth rule)。

import { sha256Hex, verifyJwt } from '@xid-kit/crypto'
import type { VerifyKeySet } from '@xid-kit/crypto'
import { importJwkForVerify } from '@xid-kit/crypto'
import type { SigningAlg, TenantContext, XidError } from '@xid-kit/types'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { readTlsClientAuth, verifyTlsClientAuth } from './mtls'
import type { ClientRow } from './shared'
import { PRIVATE_KEY_JWT_WINDOW_SEC } from '../lib/ttl'
import { claimReplayKey } from './replay-claim'

const PRIVATE_KEY_JWT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

// 解析后的 client 认证凭证(从 Authorization 头 + body 提取)。
export type ClientCredentials = {
  basic: { clientId: string; secret: string } | null
  postClientId: string | null
  postSecret: string | null
  assertionType: string | null
  assertion: string | null
}

// constant-time 字符串比较(避免泄露哈希前缀匹配长度)。
function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ba = enc.encode(a)
  const bb = enc.encode(b)
  let diff = ba.length ^ bb.length
  const len = Math.max(ba.length, bb.length)
  for (let i = 0; i < len; i++) {
    diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}

function clientError(httpStatus: number, message: string, wwwAuthenticate?: string): XidError {
  const err: XidError = { code: 'invalid_client', message, httpStatus }
  if (wwwAuthenticate) err.meta = { paramName: wwwAuthenticate }
  return err
}

function invalidRequest(message: string): XidError {
  return { code: 'invalid_request', message, httpStatus: 400 }
}

// 从 Authorization: Basic 头解析 client_id:secret(RFC6749 2.3.1)。
export function parseBasicAuth(header: string | undefined): {
  clientId: string
  secret: string
} | null {
  if (!header || !header.startsWith('Basic ')) return null
  try {
    const decoded = atob(header.slice('Basic '.length).trim())
    const idx = decoded.indexOf(':')
    if (idx < 0) return null
    return { clientId: decoded.slice(0, idx), secret: decoded.slice(idx + 1) }
  } catch {
    return null
  }
}

// 提供两种凭证(Basic + body secret/assertion)即 invalid_request(9.6)。
function hasMultipleCredentials(creds: ClientCredentials): boolean {
  const ways = [creds.basic !== null, creds.postSecret !== null, creds.assertion !== null].filter(
    Boolean,
  ).length
  return ways > 1
}

export type ClientAuthResult = { ok: true; clientId: string } | { ok: false; error: XidError }

type AssertionPayload = {
  sub?: string
  aud?: string | readonly string[]
  exp?: number
  jti?: string
}

// 校验 client_assertion claims(sub=client_id / aud / exp<=now+5min / jti 必存)。返回 null 表通过。
function checkAssertionClaims(
  p: AssertionPayload,
  input: { client: ClientRow; ctx: TenantContext; tokenEndpoint: string; now: number },
): XidError | null {
  if (p.sub !== input.client.clientId) {
    return clientError(401, 'client_assertion sub must equal client_id')
  }
  const audOk = Array.isArray(p.aud)
    ? p.aud.includes(input.tokenEndpoint) || p.aud.includes(input.ctx.issuer)
    : p.aud === input.tokenEndpoint || p.aud === input.ctx.issuer
  if (!audOk) return clientError(401, 'client_assertion aud mismatch')
  if (typeof p.exp !== 'number' || p.exp > input.now + 300) {
    return clientError(401, 'client_assertion exp must be <= now + 5min')
  }
  if (typeof p.jti !== 'string' || p.jti.length === 0) {
    return clientError(401, 'client_assertion jti required')
  }
  return null
}

// jti 一次性占用由 OAuthFlowDO 单次 claim 保证。返回 null 表占用成功。
async function claimAssertionJti(
  c: Context<XidHonoEnv>,
  clientId: string,
  jti: string,
): Promise<ClientAuthResult | null> {
  const ctx = c.get('tenant')
  const ns = c.env.OAUTH_STATE
  const claim = await claimReplayKey({
    stub: ns.get(ns.idFromName(`pkjwt:${ctx.tenantId}`)),
    key: `${clientId}#${jti}`,
    ttlMs: PRIVATE_KEY_JWT_WINDOW_SEC * 1000,
  })
  if (!claim.ok) return { ok: false, error: claim.error }
  if (!claim.claimed) return { ok: false, error: clientError(401, 'client_assertion jti replayed') }
  return null
}

// private_key_jwt 验签(9.6):验签(client 注册公钥)+ iss=sub=client_id,aud=token endpoint
// 或 issuer,exp<=now+5min,jti 一次性防重放。
async function verifyPrivateKeyJwt(input: {
  c: Context<XidHonoEnv>
  assertion: string
  client: ClientRow
  ctx: TenantContext
  tokenEndpoint: string
  now: number
}): Promise<ClientAuthResult> {
  const jwks = input.client.jwks as { keys?: unknown[] } | null
  if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    return { ok: false, error: clientError(401, 'client has no registered jwks') }
  }
  const keySet = await buildClientVerifyKeySet(jwks.keys)
  const verified = await verifyJwt(input.assertion, keySet, {
    now: input.now,
    expectedIssuer: input.client.clientId,
  })
  if (!verified.ok) {
    return { ok: false, error: clientError(401, 'client_assertion verification failed') }
  }
  const payload = verified.value.payload as AssertionPayload
  const claimErr = checkAssertionClaims(payload, input)
  if (claimErr) return { ok: false, error: claimErr }
  const jtiErr = await claimAssertionJti(input.c, input.client.clientId, payload.jti as string)
  if (jtiErr) return jtiErr
  return { ok: true, clientId: input.client.clientId }
}

async function buildClientVerifyKeySet(rawKeys: unknown[]): Promise<VerifyKeySet> {
  const keys = await Promise.all(
    rawKeys.map(async (raw) => {
      const jwk = raw as JsonWebKey & { kid?: string; alg?: string }
      const alg = (jwk.alg as SigningAlg | undefined) ?? 'ES256'
      return {
        kid: jwk.kid ?? 'client',
        alg,
        publicKey: await importJwkForVerify({
          ...jwk,
          kid: jwk.kid ?? 'client',
          use: 'sig' as const,
          alg,
        }),
      }
    }),
  )
  return { keys }
}

// confidential 共享密钥校验(client_secret_basic / client_secret_post)。
async function verifySharedSecret(
  client: ClientRow,
  secret: string,
  wwwAuthenticate?: string,
): Promise<ClientAuthResult> {
  if (!client.clientSecretHash) {
    return { ok: false, error: clientError(401, 'client has no secret', wwwAuthenticate) }
  }
  const presentedHash = await sha256Hex(secret)
  if (!constantTimeEqual(presentedHash, client.clientSecretHash)) {
    return { ok: false, error: clientError(401, 'client secret mismatch', wwwAuthenticate) }
  }
  return { ok: true, clientId: client.clientId }
}

type AuthInput = {
  c: Context<XidHonoEnv>
  client: ClientRow
  creds: ClientCredentials
  ctx: TenantContext
  tokenEndpoint: string
  now: number
}

// 凭证一致性前置(多方式并存 / client_id 不一致 -> invalid_request)。返回 null 表通过。
function preflightCredentials(creds: ClientCredentials): XidError | null {
  if (hasMultipleCredentials(creds)) {
    return invalidRequest('multiple client authentication methods presented')
  }
  if (creds.basic && creds.postClientId && creds.basic.clientId !== creds.postClientId) {
    return invalidRequest('client_id mismatch between Basic and body')
  }
  return null
}

function authBasic(input: AuthInput): Promise<ClientAuthResult> | ClientAuthResult {
  if (!input.creds.basic) {
    return { ok: false, error: clientError(401, 'Basic credentials required', 'Basic') }
  }
  return verifySharedSecret(input.client, input.creds.basic.secret, 'Basic')
}

function authPost(input: AuthInput): Promise<ClientAuthResult> | ClientAuthResult {
  if (input.creds.postSecret === null) {
    return { ok: false, error: clientError(401, 'client_secret required in body') }
  }
  return verifySharedSecret(input.client, input.creds.postSecret)
}

function authTlsClient(input: AuthInput): ClientAuthResult {
  const tls = readTlsClientAuth(input.c)
  if (!tls || !verifyTlsClientAuth(input.client, tls)) {
    return { ok: false, error: clientError(401, 'tls client certificate authentication failed') }
  }
  return { ok: true, clientId: input.client.clientId }
}

function authPrivateKeyJwt(input: AuthInput): Promise<ClientAuthResult> | ClientAuthResult {
  if (
    input.creds.assertionType !== PRIVATE_KEY_JWT_ASSERTION_TYPE ||
    input.creds.assertion === null
  ) {
    return { ok: false, error: clientError(401, 'client_assertion required') }
  }
  return verifyPrivateKeyJwt({
    c: input.c,
    assertion: input.creds.assertion,
    client: input.client,
    ctx: input.ctx,
    tokenEndpoint: input.tokenEndpoint,
    now: input.now,
  })
}

// 主入口:按 client.tokenEndpointAuthMethod 校验,只接受注册的那一种(9.6)。
export async function authenticateClient(input: AuthInput): Promise<ClientAuthResult> {
  const preflightErr = preflightCredentials(input.creds)
  if (preflightErr) return { ok: false, error: preflightErr }

  const method = input.client.tokenEndpointAuthMethod
  switch (method) {
    case 'none':
      return { ok: true, clientId: input.client.clientId }
    case 'client_secret_basic':
      return authBasic(input)
    case 'client_secret_post':
      return authPost(input)
    case 'private_key_jwt':
      return authPrivateKeyJwt(input)
    case 'tls_client_auth':
    case 'self_signed_tls_client_auth':
      return authTlsClient(input)
    default:
      return { ok: false, error: clientError(401, `unsupported auth method ${method}`) }
  }
}

export { PRIVATE_KEY_JWT_ASSERTION_TYPE }
