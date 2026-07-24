// OIDC CIBA (Client Initiated Backchannel Authentication) minimal subset.

import { createTenantDb, schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import type { Result, TenantContext, XidError } from '@xid-kit/types'
import type { Context, Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { authenticateClient, parseBasicAuth } from './client-auth'
import type { ClientCredentials } from './client-auth'
import { findClient, findDisallowedScope, oauthError, parseUniqueForm } from './shared'
import type { ClientRow } from './shared'
import {
  accessTtl,
  assertActiveTokenUser,
  fail,
  issueAccessToken,
  issueIdToken,
  issueRefreshIfAllowed,
  tokenResponseBody,
} from './token-issue'
import type { TokenContext } from './token-issue'
import { CIBA_AUTH_REQ_TTL_SEC, CIBA_POLL_INTERVAL_SEC } from '../lib/ttl'
import { claimReplayKey } from './replay-claim'

export const CIBA_GRANT = 'urn:openid:params:grant-type:ciba'

type CibaRecord = {
  clientId: string
  scope: string
  loginHint: string
  status: 'pending' | 'approved' | 'denied' | 'consumed'
  userId?: string
  expiresAt: number
  // 上次 pending 轮询时间(epoch 秒):CIBA Core 11 要求客户端按 interval 轮询,过快回 slow_down。
  lastPollAt?: number
}

function cibaKey(tenantId: string, authReqId: string): string {
  return `ciba:${tenantId}:${authReqId}`
}

async function readCiba(env: Env, tenantId: string, authReqId: string): Promise<CibaRecord | null> {
  const raw = await env.CACHE.get(cibaKey(tenantId, authReqId), 'json')
  return (raw as CibaRecord | null) ?? null
}

async function writeCiba(
  env: Env,
  tenantId: string,
  authReqId: string,
  record: CibaRecord,
): Promise<void> {
  const ttl = Math.max(1, record.expiresAt - Math.floor(Date.now() / 1000))
  await env.CACHE.put(cibaKey(tenantId, authReqId), JSON.stringify(record), { expirationTtl: ttl })
}

export async function lookupCibaRequest(
  env: Env,
  tenantId: string,
  authReqId: string,
): Promise<CibaRecord | null> {
  const record = await readCiba(env, tenantId, authReqId)
  if (!record) return null
  if (record.expiresAt <= Math.floor(Date.now() / 1000)) return null
  return record
}

async function loginHintMatchesUser(
  env: Env,
  ctx: TenantContext,
  loginHint: string,
  userId: string,
): Promise<boolean> {
  const normalizedHint = loginHint.trim().toLowerCase()
  if (userId === loginHint.trim()) return true
  const db = createTenantDb(env.DB, ctx)
  const user = await db.users.findOne(eq(schema.users.id, userId))
  if (!user || user.deletedAt !== null || user.status !== 'active') return false
  if (user.primaryEmailId) {
    const email = await db.userEmails.findOne(eq(schema.userEmails.id, user.primaryEmailId))
    if (email && email.email.toLowerCase() === normalizedHint) return true
  }
  return false
}

export async function approveCibaRequest(input: {
  env: Env
  ctx: TenantContext
  authReqId: string
  userId: string
}): Promise<boolean> {
  const record = await readCiba(input.env, input.ctx.tenantId, input.authReqId)
  if (!record || record.status !== 'pending') return false
  if (record.expiresAt <= Math.floor(Date.now() / 1000)) return false
  if (!(await loginHintMatchesUser(input.env, input.ctx, record.loginHint, input.userId))) {
    return false
  }
  record.status = 'approved'
  record.userId = input.userId
  await writeCiba(input.env, input.ctx.tenantId, input.authReqId, record)
  return true
}

export async function denyCibaRequest(input: {
  env: Env
  tenantId: string
  authReqId: string
}): Promise<boolean> {
  const record = await readCiba(input.env, input.tenantId, input.authReqId)
  if (!record || record.status !== 'pending') return false
  record.status = 'denied'
  await writeCiba(input.env, input.tenantId, input.authReqId, record)
  return true
}

// Atomically claim auth_req_id redemption via OAuthFlowDO.
async function claimCibaRedemption(
  c: Context<XidHonoEnv>,
  tenantId: string,
  authReqId: string,
): Promise<Result<true, XidError>> {
  const ns = c.env.OAUTH_STATE
  const claim = await claimReplayKey({
    stub: ns.get(ns.idFromName(`ciba:${tenantId}`)),
    key: authReqId,
    ttlMs: CIBA_AUTH_REQ_TTL_SEC * 1000,
  })
  if (!claim.ok) return { ok: false, error: claim.error }
  if (!claim.claimed) return fail('invalid_grant', 'auth_req_id already consumed')
  return { ok: true, value: true }
}

function extractCredentials(
  authHeader: string | undefined,
  form: Record<string, string>,
): ClientCredentials {
  return {
    basic: parseBasicAuth(authHeader),
    postClientId: form['client_id'] ?? null,
    postSecret: form['client_secret'] ?? null,
    assertionType: form['client_assertion_type'] ?? null,
    assertion: form['client_assertion'] ?? null,
  }
}

async function resolveBackchannelClient(
  c: Context<XidHonoEnv>,
  form: Record<string, string>,
  now: number,
): Promise<{ client: ClientRow; clientId: string } | Response> {
  const ctx = c.get('tenant')
  const creds = extractCredentials(c.req.header('authorization'), form)
  const clientId = creds.basic?.clientId ?? creds.postClientId ?? form['client_id']
  if (!clientId) {
    return oauthError(c, {
      status: 401,
      error: 'invalid_client',
      description: 'client authentication required',
    })
  }
  const client = await findClient(c, clientId)
  if (!client) {
    return oauthError(c, { status: 401, error: 'invalid_client', description: 'unknown client' })
  }
  const auth = await authenticateClient({
    c,
    client,
    creds,
    ctx,
    tokenEndpoint: `${ctx.issuer}/token`,
    now,
  })
  if (!auth.ok) {
    return oauthError(c, {
      status: auth.error.httpStatus,
      error: auth.error.code,
      description: auth.error.message,
    })
  }
  return { client, clientId: auth.clientId }
}

async function handleBackchannelAuthentication(c: Context<XidHonoEnv>): Promise<Response> {
  // parseUniqueForm 自带重复参数防护(RFC6749 3.1)与 string 形状保证,scope/login_hint 不再需 typeof 守卫。
  const form = await parseUniqueForm(c)
  if (form instanceof Response) return form
  const now = Math.floor(Date.now() / 1000)
  const clientResult = await resolveBackchannelClient(c, form, now)
  if (clientResult instanceof Response) return clientResult
  const { client, clientId } = clientResult

  const scope = form['scope'] ?? 'openid'
  const loginHint = form['login_hint']
  if (!loginHint) {
    return oauthError(c, {
      status: 400,
      error: 'invalid_request',
      description: 'login_hint is required',
    })
  }
  if (!client.allowedGrantTypes.includes(CIBA_GRANT)) {
    return oauthError(c, {
      status: 400,
      error: 'unauthorized_client',
      description: 'CIBA grant not allowed for this client',
    })
  }

  // scope 必须 ⊆ client.allowedScopes(对齐 device.ts validateScopes):CIBA 曾直接落库,
  // 客户端可借 backchannel 越白名单提权(如自报 admin scope)。
  const disallowedScope = findDisallowedScope(
    client.allowedScopes,
    scope.split(' ').filter(Boolean),
  )
  if (disallowedScope) {
    return oauthError(c, {
      status: 400,
      error: 'invalid_scope',
      description: `scope "${disallowedScope}" not allowed for this client`,
    })
  }

  const authReqId = crypto.randomUUID()
  const ctx = c.get('tenant')
  const record: CibaRecord = {
    clientId,
    scope,
    loginHint,
    status: 'pending',
    expiresAt: now + CIBA_AUTH_REQ_TTL_SEC,
  }
  await writeCiba(c.env, ctx.tenantId, authReqId, record)

  return c.json(
    {
      auth_req_id: authReqId,
      expires_in: CIBA_AUTH_REQ_TTL_SEC,
      interval: CIBA_POLL_INTERVAL_SEC,
    },
    200,
    { 'cache-control': 'no-store', pragma: 'no-cache' },
  )
}

export async function grantCiba(
  tc: TokenContext,
): Promise<Result<Record<string, unknown>, XidError>> {
  const authReqId = tc.form['auth_req_id']
  if (!authReqId) return fail('invalid_request', 'auth_req_id is required')
  const ctx = tc.c.get('tenant')
  const record = await readCiba(tc.c.env, ctx.tenantId, authReqId)
  if (!record) return fail('invalid_grant', 'unknown auth_req_id')
  if (record.clientId !== tc.clientId)
    return fail('invalid_grant', 'auth_req_id not bound to this client')
  if (record.expiresAt <= tc.now) return fail('expired_token', 'auth_req_id expired')
  if (record.status === 'pending') {
    // 轮询限速只对 pending 生效:终态(approved/denied/consumed)响应是最终语义,不拦。
    if (record.lastPollAt !== undefined && tc.now - record.lastPollAt < CIBA_POLL_INTERVAL_SEC) {
      return fail('slow_down', `polling interval is ${CIBA_POLL_INTERVAL_SEC} seconds`)
    }
    record.lastPollAt = tc.now
    await writeCiba(tc.c.env, ctx.tenantId, authReqId, record)
    return fail('authorization_pending', 'authentication pending')
  }
  if (record.status === 'denied') return fail('access_denied', 'authentication denied')
  if (record.status === 'consumed') return fail('invalid_grant', 'auth_req_id already consumed')
  if (!record.userId) return fail('invalid_grant', 'authentication incomplete')

  const redemption = await claimCibaRedemption(tc.c, ctx.tenantId, authReqId)
  if (!redemption.ok) return redemption

  const activeUser = await assertActiveTokenUser(tc, record.userId)
  if (!activeUser.ok) return activeUser

  const accessToken = await issueAccessToken(tc, {
    userId: record.userId,
    scope: record.scope,
    audience: tc.clientId,
  })
  const idToken = record.scope.split(' ').includes('openid')
    ? await issueIdToken(tc, {
        userId: record.userId,
        scope: record.scope,
        nonce: null,
        authTime: tc.now,
        accessToken,
      })
    : null
  const refreshToken = await issueRefreshIfAllowed(tc, {
    userId: record.userId,
    scope: record.scope,
    grantContext: null,
  })

  record.status = 'consumed'
  await writeCiba(tc.c.env, ctx.tenantId, authReqId, record)

  return {
    ok: true,
    value: tokenResponseBody({
      accessToken,
      jkt: tc.dpopJkt,
      ttlSec: accessTtl(tc),
      scope: record.scope,
      refreshToken,
      idToken,
    }),
  }
}

export function registerCibaRoutes(app: Hono<XidHonoEnv>): void {
  app.post('/backchannel_authentication', handleBackchannelAuthentication)
}
