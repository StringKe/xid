// OAuthFlowDO 暂存的 /authorize 续跑记录:登录、MFA、选组织、consent 之后由 /authorize 续跑。
// viaPar / consentDecision 只由服务端写入,不进入 params,避免与用户可控的 query 混淆。

import { AppError } from '../lib/errors'
import { OAUTH_FLOW_STATE_TTL_MS } from '../lib/ttl'

export type StashedAuthorizeParams = Record<string, string>

export type ConsentDecision = {
  decision: 'approved' | 'denied'
  userId: string
  sessionId: string
}

export type StashedAuthorizeRecord = {
  params: StashedAuthorizeParams
  createdAt: number | null
  interactionStartedAt: number | null
  viaPar: boolean
  consentDecision: ConsentDecision | null
}

function flowStub(env: Env, tenantId: string, authzRequestId: string): DurableObjectStub {
  const ns = env.OAUTH_STATE
  return ns.get(ns.idFromName(`authz:${tenantId}:${authzRequestId}`))
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new AppError('server_error')
  return value as Record<string, unknown>
}

// 暂存的一律是 /authorize 平铺 query(全字符串)。出现非字符串值说明记录被污染或串了 key,
// 继续用会把非预期结构当成 authorize 参数(PKCE / acr 等安全字段可能被绕过)。
function parsePendingParams(value: unknown): StashedAuthorizeParams {
  const params = asObject(value)
  for (const item of Object.values(params)) {
    if (typeof item !== 'string') throw new AppError('server_error')
  }
  return params as StashedAuthorizeParams
}

function parseOptionalTimestamp(value: unknown): number | null {
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new AppError('server_error')
  return value
}

function parseConsentDecision(value: unknown): ConsentDecision | null {
  if (value === undefined) return null
  const record = asObject(value)
  const decision = record['decision']
  const userId = record['userId']
  const sessionId = record['sessionId']
  if (
    (decision !== 'approved' && decision !== 'denied') ||
    typeof userId !== 'string' ||
    typeof sessionId !== 'string'
  ) {
    throw new AppError('server_error')
  }
  return { decision, userId, sessionId }
}

function parseConsumedPendingBody(value: unknown): StashedAuthorizeRecord {
  const record = asObject(asObject(value)['record'])
  const viaPar = record['viaPar']
  if (viaPar !== undefined && typeof viaPar !== 'boolean') throw new AppError('server_error')
  return {
    params: parsePendingParams(record['pendingParams']),
    createdAt: parseOptionalTimestamp(record['createdAt']),
    interactionStartedAt: parseOptionalTimestamp(record['interactionStartedAt']),
    viaPar: viaPar === true,
    consentDecision: parseConsentDecision(record['consentDecision']),
  }
}

// 返回 false 表示 DO 未确认写入;调用方决定渲染错误页还是抛 server_error。
export async function storeStashedAuthorizeRecord(
  env: Env,
  tenantId: string,
  authzRequestId: string,
  record: StashedAuthorizeRecord,
): Promise<boolean> {
  const res = await flowStub(env, tenantId, authzRequestId).fetch('https://oauth-flow-do/store', {
    method: 'POST',
    body: JSON.stringify({
      state: authzRequestId,
      pendingParams: record.params,
      createdAt: record.createdAt ?? Date.now(),
      ...(record.interactionStartedAt === null
        ? {}
        : { interactionStartedAt: record.interactionStartedAt }),
      ...(record.viaPar ? { viaPar: true } : {}),
      ...(record.consentDecision === null ? {} : { consentDecision: record.consentDecision }),
      ttlMs: OAUTH_FLOW_STATE_TTL_MS,
    }),
  })
  return res.status === 201
}

// 只有 404(不存在)/ 410(过期)是"暂存请求确实没了"的正常结论,可返回 null 让调用方按失效处理;
// 其余状态与坏 body 都是 DO 故障,静默当作失效会让调用方退回无参数路径(丢掉 PKCE / acr 约束)。
export async function consumeStashedAuthorizeRecord(
  env: Env,
  tenantId: string,
  authzRequestId: string,
): Promise<StashedAuthorizeRecord | null> {
  const res = await flowStub(env, tenantId, authzRequestId).fetch('https://oauth-flow-do/consume', {
    method: 'POST',
    body: JSON.stringify({ state: authzRequestId }),
  })
  if (res.status === 404 || res.status === 410) return null
  if (res.status !== 200) throw new AppError('server_error')
  let body: unknown
  try {
    body = await res.json()
  } catch (error) {
    throw new AppError('server_error', { cause: error })
  }
  return parseConsumedPendingBody(body)
}

export async function restoreStashedAuthorizeRecord(
  env: Env,
  tenantId: string,
  authzRequestId: string,
  record: StashedAuthorizeRecord,
): Promise<void> {
  if (!(await storeStashedAuthorizeRecord(env, tenantId, authzRequestId, record))) {
    throw new AppError('server_error')
  }
}

export async function peekStashedAuthorizeRecord(
  env: Env,
  tenantId: string,
  authzRequestId: string,
): Promise<StashedAuthorizeRecord | null> {
  const record = await consumeStashedAuthorizeRecord(env, tenantId, authzRequestId)
  if (!record) return null
  await restoreStashedAuthorizeRecord(env, tenantId, authzRequestId, record)
  return record
}

export function parseAuthzRequestId(redirectTo?: string): string | null {
  if (!redirectTo) return null
  try {
    const url = redirectTo.startsWith('/')
      ? new URL(redirectTo, 'https://placeholder.local')
      : new URL(redirectTo)
    return url.searchParams.get('authz_request_id')
  } catch {
    return null
  }
}
