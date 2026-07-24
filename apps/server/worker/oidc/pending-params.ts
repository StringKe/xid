// OAuthFlowDO 暂存 authorize 参数非破坏读取(consume + re-store,与 consent-params 一致)。

import { OAUTH_FLOW_STATE_TTL_MS } from '../lib/ttl'

export type StashedAuthorizeParams = Record<string, string>

function flowStub(env: Env, tenantId: string, authzRequestId: string): DurableObjectStub {
  const ns = env.OAUTH_STATE
  return ns.get(ns.idFromName(`authz:${tenantId}:${authzRequestId}`))
}

async function consumePending(
  env: Env,
  tenantId: string,
  authzRequestId: string,
): Promise<StashedAuthorizeParams | null> {
  const res = await flowStub(env, tenantId, authzRequestId).fetch('https://oauth-flow-do/consume', {
    method: 'POST',
    body: JSON.stringify({ state: authzRequestId }),
  })
  if (res.status !== 200) return null
  const body = (await res.json()) as { record?: { pendingParams?: StashedAuthorizeParams } }
  return body.record?.pendingParams ?? null
}

async function restorePending(
  env: Env,
  tenantId: string,
  authzRequestId: string,
  params: StashedAuthorizeParams,
): Promise<void> {
  await flowStub(env, tenantId, authzRequestId).fetch('https://oauth-flow-do/store', {
    method: 'POST',
    body: JSON.stringify({
      state: authzRequestId,
      pendingParams: params,
      ttlMs: OAUTH_FLOW_STATE_TTL_MS,
    }),
  })
}

export async function peekStashedAuthorizeParams(
  env: Env,
  tenantId: string,
  authzRequestId: string,
): Promise<StashedAuthorizeParams | null> {
  const pending = await consumePending(env, tenantId, authzRequestId)
  if (!pending) return null
  await restorePending(env, tenantId, authzRequestId, pending)
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
