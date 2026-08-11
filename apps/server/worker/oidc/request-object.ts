// RFC9101 JAR:仅支持 client JWKS 签名的 by-value request;JWE 与远程 request_uri 未实现。

import { importJwkForVerify, verifyJwt } from '@xid-kit/crypto'
import type { VerifyKeySet } from '@xid-kit/crypto'
import type { SigningAlg, TenantContext } from '@xid-kit/types'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import type { ClientRow } from './shared'
import { JAR_REQUEST_OBJECT_TTL_SEC } from '../lib/ttl'
import { claimReplayKey } from './replay-claim'

const REQUEST_OBJECT_FIELDS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'nonce',
  'code_challenge',
  'code_challenge_method',
  'prompt',
  'acr_values',
  'claims',
  'response_mode',
  'dpop_jkt',
  'resource',
  'authorization_details',
  'xid_intent',
] as const

type RawParams = Record<string, string>

type RequestObjectPayload = {
  iss?: string
  sub?: string
  aud?: string | readonly string[]
  exp?: number
  nbf?: number
  iat?: number
  jti?: string
  [claim: string]: unknown
}

export type RequestObjectResult =
  | { ok: true; params: RawParams }
  | { ok: false; error: string; description: string }

function fail(description: string): RequestObjectResult {
  return { ok: false, error: 'invalid_request_object', description }
}

function clientJwks(client: ClientRow): unknown[] | null {
  const jwks = client.jwks as { keys?: unknown[] } | null
  if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length === 0) return null
  return jwks.keys
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

function hasAudience(value: string | readonly string[] | undefined, expected: string): boolean {
  return Array.isArray(value) ? value.includes(expected) : value === expected
}

function checkClaims(
  payload: RequestObjectPayload,
  input: { ctx: TenantContext; clientId: string; now: number },
): string | null {
  if (payload.iss !== input.clientId) return 'request object iss must equal client_id'
  const authorizeEndpoint = `${input.ctx.issuer}/authorize`
  if (!hasAudience(payload.aud, input.ctx.issuer) && !hasAudience(payload.aud, authorizeEndpoint)) {
    return 'request object aud mismatch'
  }
  if (typeof payload.exp !== 'number' || payload.exp > input.now + JAR_REQUEST_OBJECT_TTL_SEC) {
    return 'request object exp must be <= now + 5min'
  }
  if (typeof payload.nbf !== 'number') return 'request object nbf required'
  if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
    return 'request object jti required'
  }
  if (payload.request !== undefined || payload.request_uri !== undefined) {
    return 'request object must not contain request or request_uri'
  }
  return null
}

function mergeRequestObjectParams(
  outer: RawParams,
  payload: RequestObjectPayload,
  clientId: string,
): RequestObjectResult {
  const merged: RawParams = {}
  for (const field of REQUEST_OBJECT_FIELDS) {
    const value = payload[field]
    if (value === undefined) continue
    if (field === 'authorization_details') {
      if (!Array.isArray(value)) {
        return fail('request object authorization_details must be an array')
      }
      merged[field] = JSON.stringify(value)
      continue
    }
    if (typeof value !== 'string') return fail(`request object ${field} must be a string`)
    merged[field] = value
  }
  if (outer['client_id'] !== clientId) return fail('request object client_id mismatch')
  if (merged['client_id'] !== clientId) return fail('request object client_id mismatch')
  return { ok: true, params: merged }
}

// 返回 null 表 jti 占用成功。
async function claimRequestObjectJti(
  c: Context<XidHonoEnv>,
  clientId: string,
  jti: string,
): Promise<RequestObjectResult | null> {
  const ctx = c.get('tenant')
  const ns = c.env.OAUTH_STATE
  const claim = await claimReplayKey({
    stub: ns.get(ns.idFromName(`jar:${ctx.tenantId}`)),
    key: `${clientId}#${jti}`,
    ttlMs: JAR_REQUEST_OBJECT_TTL_SEC * 1000,
  })
  if (!claim.ok) return { ok: false, error: 'server_error', description: claim.error.message }
  if (!claim.claimed) return fail('request object jti replayed')
  return null
}

export async function resolveRequestObject(input: {
  c: Context<XidHonoEnv>
  params: RawParams
  client: ClientRow
  now: number
}): Promise<RequestObjectResult> {
  const request = input.params['request']
  if (request === undefined) return { ok: true, params: input.params }
  const rawKeys = clientJwks(input.client)
  if (!rawKeys) return fail('client has no registered jwks for request object')

  const ctx = input.c.get('tenant')
  const keySet = await buildClientVerifyKeySet(rawKeys)
  const verified = await verifyJwt(request, keySet, {
    now: input.now,
    expectedIssuer: input.client.clientId,
  })
  if (!verified.ok) return fail('request object verification failed')

  const payload = verified.value.payload as RequestObjectPayload
  const claimsError = checkClaims(payload, {
    ctx,
    clientId: input.client.clientId,
    now: input.now,
  })
  if (claimsError) return fail(claimsError)

  const jtiError = await claimRequestObjectJti(
    input.c,
    input.client.clientId,
    payload.jti as string,
  )
  if (jtiError) return jtiError

  return mergeRequestObjectParams(input.params, payload, input.client.clientId)
}
