// OAuthFlowDO 暂存 authorize 参数非破坏读取(consume + re-store,与 consent-params 一致)。

import { AppError } from '../lib/errors'
import { OAUTH_FLOW_STATE_TTL_MS } from '../lib/ttl'

export type StashedAuthorizeParams = Record<string, string>

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

function parseConsumedPendingBody(value: unknown): StashedAuthorizeParams {
  const body = asObject(value)
  const record = asObject(body['record'])
  return parsePendingParams(record['pendingParams'])
}

// 只有 404(不存在)/ 410(过期)是"暂存请求确实没了"的正常结论,可返回 null 让调用方按失效处理;
// 其余状态与坏 body 都是 DO 故障,静默当作失效会让调用方退回无参数路径(丢掉 PKCE / acr 约束)。
export async function consumeStashedAuthorizeParams(
  env: Env,
  tenantId: string,
  authzRequestId: string,
): Promise<StashedAuthorizeParams | null> {
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

export async function restoreStashedAuthorizeParams(
  env: Env,
  tenantId: string,
  authzRequestId: string,
  params: StashedAuthorizeParams,
): Promise<void> {
  const res = await flowStub(env, tenantId, authzRequestId).fetch('https://oauth-flow-do/store', {
    method: 'POST',
    body: JSON.stringify({
      state: authzRequestId,
      pendingParams: params,
      ttlMs: OAUTH_FLOW_STATE_TTL_MS,
    }),
  })
  // consume 已删除记录:re-store 失败必须拒绝请求,否则调用方拿着"读到了"的结论继续,
  // 而后续步骤(consent 提交 / MFA 续跑)再也读不到暂存参数。
  if (res.status !== 201) throw new AppError('server_error')
}

export async function peekStashedAuthorizeParams(
  env: Env,
  tenantId: string,
  authzRequestId: string,
): Promise<StashedAuthorizeParams | null> {
  const pending = await consumeStashedAuthorizeParams(env, tenantId, authzRequestId)
  if (!pending) return null
  await restoreStashedAuthorizeParams(env, tenantId, authzRequestId, pending)
  return pending
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
