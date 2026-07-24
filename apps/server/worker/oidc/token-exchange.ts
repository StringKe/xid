// /token grant 实现 B 组(03 章 9.4-9.5):device_code(RFC8628)/ token-exchange(RFC8693)。
// device 状态走 DeviceFlowStore DO;token-exchange 验 subject_token(本 issuer 签发)+ delegation/impersonation。
// 铁律:token-exchange 仅 confidential;subject_token 类型限 access/id token;scope 只能收敛。

import { buildAccessTokenClaims, narrowScope, signAccessTokenClaims } from '@xid-kit/protocol'
import { verifyJwt } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import type { Result, XidError } from '@xid-kit/types'
import { buildVerifyKeySet, refreshTtlSecOf } from './shared'
import { TOKEN_EXCHANGE_ID_TOKEN_TTL_SEC } from '../lib/ttl'
import {
  accessOptions,
  accessTtl,
  assertActiveTokenUser,
  fail,
  issueAccessToken,
  issueIdToken,
  issueRefreshIfAllowed,
  resolveResource,
  tokenResponseBody,
  tokenType,
} from './token-issue'
import type { TokenContext } from './token-issue'

type GrantResult = Result<Record<string, unknown>, XidError>
type ApprovedDeviceGrant = { userId: string; scopes: string[]; clientId: string }

const SUBJECT_ACCESS = 'urn:ietf:params:oauth:token-type:access_token'
const SUBJECT_ID = 'urn:ietf:params:oauth:token-type:id_token'
const SUBJECT_REFRESH = 'urn:ietf:params:oauth:token-type:refresh_token'
const REQUESTED_REFRESH = SUBJECT_REFRESH
const REQUESTED_ID = SUBJECT_ID
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

// DeviceFlowStore 的非 2xx 只有携带合法 error 码时才算"协议层拒绝"(pending / slow_down / denied)。
// body 读不出来或没有 error 字段说明 DO 自己坏了,原样退化成 invalid_grant 会把基础设施故障
// 伪装成"设备码无效",设备侧据此放弃轮询;这里必须显式报 server_error。
async function parseDeviceFlowError(res: Response): Promise<Result<never, XidError>> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return fail('server_error', 'device flow error', 500)
  }
  if (!isObject(body) || typeof body['error'] !== 'string') {
    return fail('server_error', 'device flow error', 500)
  }
  const description = body['error_description']
  return fail(
    body['error'] as XidError['code'],
    typeof description === 'string' ? description : 'device flow error',
  )
}

function isApprovedDeviceGrant(body: unknown): body is ApprovedDeviceGrant & { approved: true } {
  if (!isObject(body) || body['approved'] !== true) return false
  if (typeof body['userId'] !== 'string' || body['userId'].length === 0) return false
  if (typeof body['clientId'] !== 'string' || body['clientId'].length === 0) return false
  const scopes = body['scopes']
  return Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string')
}

// 2xx 不等于"已授权":盲目 cast 会让缺 userId 的响应一路走到签发,给 undefined 用户发 token。
async function parseApprovedDeviceGrant(
  res: Response,
): Promise<Result<ApprovedDeviceGrant, XidError>> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return fail('server_error', 'device flow approval malformed', 500)
  }
  if (!isApprovedDeviceGrant(body)) {
    return fail('server_error', 'device flow approval malformed', 500)
  }
  return {
    ok: true,
    value: { userId: body.userId, scopes: body.scopes, clientId: body.clientId },
  }
}

// ---- grant=device_code(9.4)----
export async function grantDeviceCode(tc: TokenContext): Promise<GrantResult> {
  const deviceCode = tc.form['device_code']
  if (!deviceCode) return fail('invalid_request', 'device_code is required')
  const ctx = tc.c.get('tenant')
  const ns = tc.c.env.DEVICE_FLOW
  const stub = ns.get(ns.idFromName(ctx.tenantId))
  // clientId 随 poll 下发:DO 侧校验 device_code 与已认证 client 绑定一致(防 client 混淆/劫持)。
  const res = await stub.fetch('https://device-flow/poll', {
    method: 'POST',
    body: JSON.stringify({ deviceCode, clientId: tc.clientId }),
  })
  if (!res.ok) return parseDeviceFlowError(res)
  const approved = await parseApprovedDeviceGrant(res)
  if (!approved.ok) return approved
  // 兑换侧再校验一次 client 绑定(纵深防御,DO 已校验)。
  if (approved.value.clientId !== tc.clientId) {
    return fail('invalid_grant', 'device_code not bound to this client')
  }
  return issueDeviceTokens(tc, approved.value)
}

async function issueDeviceTokens(
  tc: TokenContext,
  approved: { userId: string; scopes: string[] },
): Promise<GrantResult> {
  const activeUser = await assertActiveTokenUser(tc, approved.userId)
  if (!activeUser.ok) return activeUser
  const scope = approved.scopes.join(' ')
  const accessToken = await issueAccessToken(tc, {
    userId: approved.userId,
    scope,
    audience: tc.clientId,
  })
  const idToken = approved.scopes.includes('openid')
    ? await issueIdToken(tc, {
        userId: approved.userId,
        scope,
        nonce: null,
        authTime: tc.now,
        accessToken,
      })
    : null
  const refreshToken = await issueRefreshIfAllowed(tc, {
    userId: approved.userId,
    scope,
    grantContext: null,
  })
  return {
    ok: true,
    value: tokenResponseBody({
      accessToken,
      jkt: tc.dpopJkt,
      ttlSec: accessTtl(tc),
      scope,
      refreshToken,
      idToken,
    }),
  }
}

type ExchangeInput = {
  subjectToken: string
  subjectType: string
  actorToken: string | null
  actorType: string | null
}

function isSupportedExchangeTokenType(value: string): boolean {
  return value === SUBJECT_ACCESS || value === SUBJECT_ID
}

// 解析 + 基础校验 token-exchange 输入(9.5 第 2 步)。
function parseExchangeInput(tc: TokenContext): Result<ExchangeInput, XidError> {
  const subjectToken = tc.form['subject_token']
  const subjectType = tc.form['subject_token_type']
  if (!subjectToken || !subjectType) {
    return fail('invalid_request', 'subject_token and subject_token_type required')
  }
  if (!isSupportedExchangeTokenType(subjectType)) {
    return fail('invalid_request', 'subject_token_type must be access_token or id_token')
  }
  const requestedType = tc.form['requested_token_type'] ?? SUBJECT_ACCESS
  if (
    requestedType !== SUBJECT_ACCESS &&
    requestedType !== REQUESTED_REFRESH &&
    requestedType !== REQUESTED_ID
  ) {
    return fail(
      'invalid_request',
      'requested_token_type must be access_token, refresh_token, or id_token',
    )
  }
  const actorType = tc.form['actor_token_type'] ?? null
  const actorToken = tc.form['actor_token'] ?? null
  if ((actorToken === null) !== (actorType === null)) {
    return fail('invalid_request', 'actor_token and actor_token_type must be paired')
  }
  if (actorType !== null && !isSupportedExchangeTokenType(actorType)) {
    return fail('invalid_request', 'actor_token_type must be access_token or id_token')
  }
  return { ok: true, value: { subjectToken, subjectType, actorToken, actorType } }
}

type SubjectVerified = {
  subjectSub: string
  originalScope: string
  keySet: Awaited<ReturnType<typeof buildVerifyKeySet>>
}

// 验证 subject_token(本 issuer 签发,未过期,签名有效)+ 提取 sub/scope(9.5 第 3 步)。
async function verifySubjectToken(
  tc: TokenContext,
  subjectToken: string,
  subjectType: string,
): Promise<Result<SubjectVerified, XidError>> {
  const ctx = tc.c.get('tenant')
  const keySet = await buildVerifyKeySet(ctx)
  const verified = await verifyJwt(subjectToken, keySet, {
    now: tc.now,
    expectedIssuer: ctx.issuer,
  })
  if (!verified.ok) return fail('invalid_grant', 'subject_token verification failed')
  const subjectSub = verified.value.payload.sub
  if (typeof subjectSub !== 'string') return fail('invalid_grant', 'subject_token missing sub')
  if (!matchesTokenType(verified.value.payload as Record<string, unknown>, subjectType)) {
    return fail('invalid_grant', 'subject_token_type mismatch')
  }
  // subject access token 必须查 jti 撤销 denylist(同 introspect):已撤销的 token 不得再换发。
  if (subjectType === SUBJECT_ACCESS) {
    const jti = verified.value.payload.jti
    if (typeof jti === 'string') {
      const db = createTenantDb(tc.c.env.DB, ctx)
      const revoked = await db.accessTokenRevocations.findOne(
        eq(schema.accessTokenRevocations.jti, jti),
      )
      if (revoked) return fail('invalid_grant', 'subject_token has been revoked')
    }
  }
  const originalScope =
    typeof verified.value.payload.scope === 'string' ? verified.value.payload.scope : ''
  return { ok: true, value: { subjectSub, originalScope, keySet } }
}

function matchesTokenType(payload: Record<string, unknown>, tokenTypeValue: string): boolean {
  if (tokenTypeValue === SUBJECT_ACCESS) {
    return typeof payload['scope'] === 'string' && typeof payload['client_id'] === 'string'
  }
  if (tokenTypeValue === SUBJECT_ID) {
    return typeof payload['azp'] === 'string' && typeof payload['client_id'] !== 'string'
  }
  return false
}

// ---- grant=token-exchange(9.5)----
export async function grantTokenExchange(tc: TokenContext): Promise<GrantResult> {
  if (tc.client.clientType === 'public') {
    return fail('invalid_client', 'token-exchange requires confidential client', 401)
  }
  if (!tc.client.firstParty) {
    return fail('invalid_grant', 'token-exchange requires a first-party client')
  }
  const parsed = parseExchangeInput(tc)
  if (!parsed.ok) return parsed
  const subject = await verifySubjectToken(tc, parsed.value.subjectToken, parsed.value.subjectType)
  if (!subject.ok) return subject

  const narrowed = narrowScope(subject.value.originalScope, tc.form['scope'] ?? null)
  if (!narrowed.ok) return narrowed

  // resource/audience(RFC8707/8693)白名单:带 resource 时必须是已注册 audience。
  const resource = await resolveResource(tc, tc.form['resource'] ?? tc.form['audience'] ?? null)
  if (!resource.ok) return resource

  const requestedType = tc.form['requested_token_type'] ?? SUBJECT_ACCESS
  const exchangeInput = {
    subjectSub: subject.value.subjectSub,
    scope: narrowed.value,
    actorToken: parsed.value.actorToken,
    actorType: parsed.value.actorType,
    audience: resource.value ?? tc.clientId,
    keySet: subject.value.keySet,
    requestedType,
    subjectType: parsed.value.subjectType,
    subjectToken: parsed.value.subjectToken,
  }
  if (requestedType === REQUESTED_REFRESH) return issueExchangedRefresh(tc, exchangeInput)
  if (requestedType === REQUESTED_ID) return issueExchangedIdToken(tc, exchangeInput)
  return issueExchanged(tc, exchangeInput)
}

// delegation(有 actor_token)签发含 act claim;impersonation 直接以 subject sub 签发。
async function issueExchanged(
  tc: TokenContext,
  input: {
    subjectSub: string
    scope: string
    actorToken: string | null
    actorType: string | null
    audience: string
    keySet: Awaited<ReturnType<typeof buildVerifyKeySet>>
  },
): Promise<GrantResult> {
  const ctx = tc.c.get('tenant')
  const activeUser = await assertActiveTokenUser(tc, input.subjectSub)
  if (!activeUser.ok) return activeUser
  const actSub = await resolveActor(tc, input.actorToken, input.actorType, input.keySet)
  if (actSub && !actSub.ok) return actSub.error
  const options = accessOptions({ tc })
  if (actSub && actSub.ok) options.act = { sub: actSub.sub }
  const claims = buildAccessTokenClaims({
    ctx,
    subject: { userId: input.subjectSub },
    clientId: tc.clientId,
    scope: input.scope,
    audience: input.audience,
    now: tc.now,
    ttlSec: accessTtl(tc),
    options,
  })
  const accessToken = await signAccessTokenClaims(ctx, tc.signer.privateKey, claims)
  return {
    ok: true,
    value: {
      access_token: accessToken,
      issued_token_type: SUBJECT_ACCESS,
      token_type: tokenType(tc.dpopJkt),
      expires_in: accessTtl(tc),
      scope: input.scope,
    },
  }
}

type ActorResult = { ok: true; sub: string } | { ok: false; error: GrantResult }

// actor_token 验签 -> act.sub(delegation);无 actor 返回 null(impersonation)。
async function resolveActor(
  tc: TokenContext,
  actorToken: string | null,
  actorType: string | null,
  keySet: Awaited<ReturnType<typeof buildVerifyKeySet>>,
): Promise<ActorResult | null> {
  if (actorToken === null) return null
  if (actorType === null)
    return { ok: false, error: fail('invalid_request', 'actor_token_type required') }
  const ctx = tc.c.get('tenant')
  const actor = await verifyJwt(actorToken, keySet, { now: tc.now, expectedIssuer: ctx.issuer })
  if (
    !actor.ok ||
    typeof actor.value.payload.sub !== 'string' ||
    !matchesTokenType(actor.value.payload as Record<string, unknown>, actorType)
  ) {
    return { ok: false, error: fail('invalid_grant', 'actor_token verification failed') }
  }
  return { ok: true, sub: actor.value.payload.sub }
}

async function issueExchangedRefresh(
  tc: TokenContext,
  input: {
    subjectSub: string
    scope: string
    actorToken: string | null
    actorType: string | null
    audience: string
    keySet: Awaited<ReturnType<typeof buildVerifyKeySet>>
    subjectType: string
    subjectToken: string
  },
): Promise<GrantResult> {
  if (input.subjectType !== SUBJECT_ACCESS) {
    return fail('invalid_request', 'refresh_token exchange requires subject access token')
  }
  const activeUser = await assertActiveTokenUser(tc, input.subjectSub)
  if (!activeUser.ok) return activeUser
  const actSub = await resolveActor(tc, input.actorToken, input.actorType, input.keySet)
  if (actSub && !actSub.ok) return actSub.error
  if (!input.scope.split(' ').includes('offline_access')) {
    return fail('invalid_scope', 'refresh_token exchange requires offline_access scope')
  }
  const refreshToken = await issueRefreshIfAllowed(tc, {
    userId: input.subjectSub,
    scope: input.scope,
    grantContext: null,
  })
  if (!refreshToken) return fail('invalid_grant', 'refresh_token issuance not allowed')
  return {
    ok: true,
    value: {
      access_token: refreshToken,
      issued_token_type: REQUESTED_REFRESH,
      token_type: 'N/A',
      expires_in: refreshTtlSecOf(tc.c.get('tenant')).idleTtlSec,
      scope: input.scope,
    },
  }
}

async function issueExchangedIdToken(
  tc: TokenContext,
  input: {
    subjectSub: string
    scope: string
    actorToken: string | null
    actorType: string | null
    audience: string
    keySet: Awaited<ReturnType<typeof buildVerifyKeySet>>
    subjectType: string
  },
): Promise<GrantResult> {
  if (input.subjectType !== SUBJECT_ACCESS && input.subjectType !== SUBJECT_ID) {
    return fail('invalid_request', 'id_token exchange requires subject access or id token')
  }
  const activeUser = await assertActiveTokenUser(tc, input.subjectSub)
  if (!activeUser.ok) return activeUser
  const actSub = await resolveActor(tc, input.actorToken, input.actorType, input.keySet)
  if (actSub && !actSub.ok) return actSub.error
  const accessToken = await issueAccessToken(tc, {
    userId: input.subjectSub,
    scope: input.scope,
    audience: input.audience,
  })
  const idToken = await issueIdToken(tc, {
    userId: input.subjectSub,
    scope: input.scope,
    nonce: null,
    authTime: tc.now,
    accessToken,
    ttlSec: TOKEN_EXCHANGE_ID_TOKEN_TTL_SEC,
    ...(actSub && actSub.ok ? { act: { sub: actSub.sub } } : {}),
  })
  return {
    ok: true,
    value: {
      access_token: idToken,
      issued_token_type: REQUESTED_ID,
      token_type: 'N/A',
      expires_in: TOKEN_EXCHANGE_ID_TOKEN_TTL_SEC,
      scope: input.scope,
    },
  }
}

export { DEVICE_CODE_GRANT, TOKEN_EXCHANGE_GRANT, REQUESTED_REFRESH, REQUESTED_ID }
