// Hosted Auth 续跑契约:所有登录方式发同一组 flow 字段,Worker 用 resolveHostedAuthFlow 复核。

export type SignInFlowSearch = {
  authz_request_id?: string
  continue?: string
  redirect?: string
  client_id?: string
  intent?: string
  invitation_token?: string
}

export type SignInFlowFields = {
  continue?: string
  intent?: string
  clientId?: string
  invitationToken?: string
}

// 只允许同源相对路径,避免 open redirect。
export function sameOriginPath(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value, globalThis.location.origin)
    if (url.origin === globalThis.location.origin) return url.pathname + url.search + url.hash
  } catch {
    return null
  }
  return null
}

export function authorizeResumePath(
  authzRequestId: string,
  applicationClientId?: string | null,
): string {
  const params = new URLSearchParams({ authz_request_id: authzRequestId })
  if (applicationClientId) params.set('client_id', applicationClientId)
  return `/authorize?${params.toString()}`
}

// null 时由 Worker 按请求 host 选择默认落点。
export function resolveHostedContinuation(search: SignInFlowSearch): string | null {
  if (search.authz_request_id) {
    return authorizeResumePath(search.authz_request_id, search.client_id)
  }
  return sameOriginPath(search.continue ?? search.redirect)
}

export function resolveHostedReturn(search: SignInFlowSearch, fallback: string): string {
  return resolveHostedContinuation(search) ?? fallback
}

export function buildSignInFlowFields(search: SignInFlowSearch): SignInFlowFields {
  const continuation = resolveHostedContinuation(search)
  return {
    ...(continuation ? { continue: continuation } : {}),
    ...(search.intent ? { intent: search.intent } : {}),
    ...(search.client_id ? { clientId: search.client_id } : {}),
    ...(search.invitation_token ? { invitationToken: search.invitation_token } : {}),
  }
}
