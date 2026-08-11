// OIDC CIBA 最小子集(Client Initiated Backchannel Authentication)。

import { base64UrlEncode } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import type { IssuedRefreshToken } from '@xid-kit/protocol'
import { eq } from 'drizzle-orm'
import type { Result, TenantContext, XidError } from '@xid-kit/types'
import type { Context, Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { AppError, isAppError } from '../lib/errors'
import type { CibaRecord } from '../durable-objects/ciba-store'
import { authenticateClient, extractClientCredentials } from './client-auth'
import { findClient, findDisallowedScope, oauthError, parseUniqueForm } from './shared'
import type { ClientRow } from './shared'
import {
  accessTtl,
  assertActiveTokenUser,
  fail,
  issueAccessToken,
  issueIdToken,
  persistRefresh,
  prepareRefreshIfAllowed,
  tokenResponseBody,
} from './token-issue'
import type { TokenContext } from './token-issue'
import {
  CIBA_AUTH_REQ_TTL_SEC,
  CIBA_ISSUANCE_RESERVATION_TTL_SEC,
  CIBA_POLL_INTERVAL_SEC,
} from '../lib/ttl'

export const CIBA_GRANT = 'urn:openid:params:grant-type:ciba'
const CIBA_AUTH_REQ_ID_BYTES = 32

function cibaStub(env: Env, tenantId: string, authReqId: string): DurableObjectStub {
  const ns = env.CIBA_STATE
  return ns.get(ns.idFromName(`ciba:${tenantId}:${authReqId}`))
}

async function readCiba(env: Env, tenantId: string, authReqId: string): Promise<CibaRecord | null> {
  const response = await cibaStub(env, tenantId, authReqId).fetch('https://ciba-store/read', {
    method: 'POST',
  })
  if (response.status === 404 || response.status === 410) return null
  if (response.status !== 200) throw new AppError('server_error')
  return readRecordResponse(response)
}

async function createCiba(
  env: Env,
  tenantId: string,
  authReqId: string,
  record: CibaRecord,
): Promise<void> {
  const response = await cibaStub(env, tenantId, authReqId).fetch('https://ciba-store/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  })
  if (response.status !== 201) throw new AppError('server_error')
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
  const response = await cibaStub(input.env, input.ctx.tenantId, input.authReqId).fetch(
    'https://ciba-store/approve',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: input.userId }),
    },
  )
  if (response.status === 200) return true
  if (response.status === 404 || response.status === 409 || response.status === 410) return false
  throw new AppError('server_error')
}

export async function denyCibaRequest(input: {
  env: Env
  tenantId: string
  authReqId: string
}): Promise<boolean> {
  const response = await cibaStub(input.env, input.tenantId, input.authReqId).fetch(
    'https://ciba-store/deny',
    { method: 'POST' },
  )
  if (response.status === 200) return true
  if (response.status === 404 || response.status === 409 || response.status === 410) return false
  throw new AppError('server_error')
}

type CibaReservation = {
  record: CibaRecord
  reservationId: string
}

async function reserveCiba(input: {
  env: Env
  tenantId: string
  authReqId: string
  clientId: string
  nowSec: number
}): Promise<Result<CibaReservation, XidError>> {
  const response = await cibaStub(input.env, input.tenantId, input.authReqId).fetch(
    'https://ciba-store/poll',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: input.clientId,
        nowSec: input.nowSec,
        intervalSec: CIBA_POLL_INTERVAL_SEC,
        reservationTtlSec: CIBA_ISSUANCE_RESERVATION_TTL_SEC,
      }),
    },
  )
  if (response.status === 404) return fail('invalid_grant', 'unknown auth_req_id')
  if (response.status === 410) return fail('expired_token', 'auth_req_id expired')
  if (response.status === 202) return fail('authorization_pending', 'authentication pending')
  if (response.status === 429) {
    return fail('slow_down', `polling interval is ${CIBA_POLL_INTERVAL_SEC} seconds`)
  }
  if (response.status === 403) return fail('access_denied', 'authentication denied')
  if (response.status === 409) return fail('invalid_grant', 'auth_req_id already consumed')
  if (response.status !== 200) return fail('server_error', 'CIBA state unavailable', 500)
  return { ok: true, value: await readReservationResponse(response) }
}

async function mutateCibaReservation(input: {
  env: Env
  tenantId: string
  authReqId: string
  clientId: string
  reservationId: string
  action: 'abort' | 'finalize'
}): Promise<'updated' | 'ownership_lost'> {
  const attempts = input.action === 'finalize' ? 2 : 1
  let lastFailure: unknown = new Error(`CIBA ${input.action} did not run`)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response
    try {
      response = await cibaStub(input.env, input.tenantId, input.authReqId).fetch(
        `https://ciba-store/${input.action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: input.clientId,
            reservationId: input.reservationId,
          }),
        },
      )
    } catch (error) {
      lastFailure = error
      continue
    }
    if (response.status === 200) return 'updated'
    if (
      input.action === 'abort' &&
      (response.status === 404 || response.status === 409 || response.status === 410)
    ) {
      return 'ownership_lost'
    }
    lastFailure = new Error(`CIBA ${input.action} failed with status ${response.status}`)
    if (response.status < 500) break
  }
  if (input.action === 'finalize') {
    try {
      const record = await readCiba(input.env, input.tenantId, input.authReqId)
      if (record?.status === 'consumed' && record.finalizedReservationId === input.reservationId) {
        return 'updated'
      }
    } catch (confirmationError) {
      lastFailure = new AggregateError(
        [lastFailure, confirmationError],
        'CIBA finalize outcome could not be confirmed',
      )
    }
  }
  throw new AppError('server_error', { cause: lastFailure })
}

async function readRecordResponse(response: Response): Promise<CibaRecord> {
  const body: unknown = await response.json()
  if (
    typeof body !== 'object' ||
    body === null ||
    !('record' in body) ||
    !isCibaRecord(body.record)
  ) {
    throw new AppError('server_error')
  }
  return body.record
}

async function readReservationResponse(response: Response): Promise<CibaReservation> {
  const body: unknown = await response.json()
  if (
    typeof body !== 'object' ||
    body === null ||
    !('record' in body) ||
    !isCibaRecord(body.record) ||
    !('reservationId' in body) ||
    typeof body.reservationId !== 'string' ||
    body.reservationId.length === 0
  ) {
    throw new AppError('server_error')
  }
  return { record: body.record, reservationId: body.reservationId }
}

function isCibaRecord(value: unknown): value is CibaRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['clientId'] === 'string' &&
    typeof record['scope'] === 'string' &&
    typeof record['loginHint'] === 'string' &&
    typeof record['expiresAt'] === 'number' &&
    (record['status'] === 'pending' ||
      record['status'] === 'approved' ||
      record['status'] === 'issuing' ||
      record['status'] === 'denied' ||
      record['status'] === 'consumed') &&
    (record['userId'] === undefined || typeof record['userId'] === 'string') &&
    (record['lastPollAt'] === undefined || typeof record['lastPollAt'] === 'number') &&
    (record['reservationId'] === undefined || typeof record['reservationId'] === 'string') &&
    (record['reservationExpiresAt'] === undefined ||
      typeof record['reservationExpiresAt'] === 'number') &&
    (record['finalizedReservationId'] === undefined ||
      typeof record['finalizedReservationId'] === 'string')
  )
}

async function resolveBackchannelClient(
  c: Context<XidHonoEnv>,
  form: Record<string, string>,
  now: number,
): Promise<{ client: ClientRow; clientId: string } | Response> {
  const ctx = c.get('tenant')
  const creds = extractClientCredentials(c.req.header('authorization'), form)
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
  // parseUniqueForm 自带重复参数防护(RFC6749 3.1)与 string 形状保证,scope/login_hint 无需 typeof 守卫。
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

  // scope 必须 ⊆ client.allowedScopes(对齐 device.ts validateScopes):不校验则
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

  const authReqId = base64UrlEncode(crypto.getRandomValues(new Uint8Array(CIBA_AUTH_REQ_ID_BYTES)))
  const ctx = c.get('tenant')
  const record: CibaRecord = {
    clientId,
    scope,
    loginHint,
    status: 'pending',
    expiresAt: now + CIBA_AUTH_REQ_TTL_SEC,
  }
  await createCiba(c.env, ctx.tenantId, authReqId, record)

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
  const reserved = await reserveCiba({
    env: tc.c.env,
    tenantId: ctx.tenantId,
    authReqId,
    clientId: tc.clientId,
    nowSec: tc.now,
  })
  if (!reserved.ok) return reserved
  const { record, reservationId } = reserved.value
  const mutation = {
    env: tc.c.env,
    tenantId: ctx.tenantId,
    authReqId,
    clientId: tc.clientId,
    reservationId,
  }
  let issuedRefresh: IssuedRefreshToken | null = null

  try {
    if (!record.userId) throw new AppError('server_error')

    const activeUser = await assertActiveTokenUser(tc, record.userId)
    if (!activeUser.ok) {
      await mutateCibaReservation({ ...mutation, action: 'finalize' })
      return activeUser
    }

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
    issuedRefresh = await prepareRefreshIfAllowed(tc, {
      userId: record.userId,
      scope: record.scope,
      grantContext: null,
    })
    if (issuedRefresh) await persistRefresh(tc, issuedRefresh.record)

    const response = tokenResponseBody({
      accessToken,
      jkt: tc.dpopJkt,
      ttlSec: accessTtl(tc),
      scope: record.scope,
      refreshToken: issuedRefresh?.token ?? null,
      idToken,
    })
    await mutateCibaReservation({ ...mutation, action: 'finalize' })
    return { ok: true, value: response }
  } catch (error) {
    const recoveryErrors: unknown[] = []
    if (issuedRefresh) {
      try {
        const db = createTenantDb(tc.c.env.DB, ctx)
        await db.refreshTokens.hardDelete(eq(schema.refreshTokens.id, issuedRefresh.record.id))
      } catch (rollbackError) {
        recoveryErrors.push(rollbackError)
      }
    }
    try {
      await mutateCibaReservation({ ...mutation, action: 'abort' })
    } catch (abortError) {
      recoveryErrors.push(abortError)
    }
    if (recoveryErrors.length > 0) {
      throw new AppError('server_error', {
        cause: new AggregateError([error, ...recoveryErrors], 'CIBA issuance recovery failed'),
      })
    }
    throw isAppError(error) ? error : new AppError('server_error', { cause: error })
  }
}

export function registerCibaRoutes(app: Hono<XidHonoEnv>): void {
  app.post('/backchannel_authentication', handleBackchannelAuthentication)
}
