// OAuthFlowDO 暂存 authorize 参数非破坏读取(consume + re-store,与 consent-params 一致)。

import { AppError } from '../lib/errors'
import { OAUTH_FLOW_STATE_TTL_MS } from '../lib/ttl'

export type StashedAuthorizeParams = Record<string, string>
export type StashedAuthorizeRecord = {
  params: StashedAuthorizeParams
  createdAt: number | null
  interactionStartedAt: number | null
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

function parseConsumedPendingBody(value: unknown): StashedAuthorizeRecord {
  const body = asObject(value)
  const record = asObject(body['record'])
  const createdAt = record['createdAt']
  const interactionStartedAt = record['interactionStartedAt']
  if (createdAt !== undefined && (typeof createdAt !== 'number' || !Number.isFinite(createdAt))) {
    throw new AppError('server_error')
  }
  if (
    interactionStartedAt !== undefined &&
    (typeof interactionStartedAt !== 'number' || !Number.isFinite(interactionStartedAt))
  ) {
    throw new AppError('server_error')
  }
  return {
    params: parsePendingParams(record['pendingParams']),
    createdAt: typeof createdAt === 'number' ? createdAt : null,
    interactionStartedAt: typeof interactionStartedAt === 'number' ? interactionStartedAt : null,
  }
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

export async function consumeStashedAuthorizeParams(
  env: Env,
  tenantId: string,
  authzRequestId: string,
): Promise<StashedAuthorizeParams | null> {
  const record = await consumeStashedAuthorizeRecord(env, tenantId, authzRequestId)
  return record?.params ?? null
}

export async function restoreStashedAuthorizeRecord(
  env: Env,
  tenantId: string,
  authzRequestId: string,
  record: StashedAuthorizeRecord,
): Promise<void> {
  const res = await flowStub(env, tenantId, authzRequestId).fetch('https://oauth-flow-do/store', {
    method: 'POST',
    body: JSON.stringify({
      state: authzRequestId,
      pendingParams: record.params,
      createdAt: record.createdAt ?? Date.now(),
      ...(record.interactionStartedAt === null
        ? {}
        : { interactionStartedAt: record.interactionStartedAt }),
      ttlMs: OAUTH_FLOW_STATE_TTL_MS,
    }),
  })
  if (res.status !== 201) throw new AppError('server_error')
}

export async function restoreStashedAuthorizeParams(
  env: Env,
  tenantId: string,
  authzRequestId: string,
  params: StashedAuthorizeParams,
): Promise<void> {
  await restoreStashedAuthorizeRecord(env, tenantId, authzRequestId, {
    params,
    createdAt: Date.now(),
    interactionStartedAt: null,
  })
}

export async function peekStashedAuthorizeParams(
  env: Env,
  tenantId: string,
  authzRequestId: string,
): Promise<StashedAuthorizeParams | null> {
  const record = await consumeStashedAuthorizeRecord(env, tenantId, authzRequestId)
  if (!record) return null
  await restoreStashedAuthorizeRecord(env, tenantId, authzRequestId, record)
  return record.params
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
