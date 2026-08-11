// /auth/config 查询装配(主 chunk 预热与页面共享);guest capability 仅秒级 short stale。

import type { QueryClient } from '@tanstack/react-query'
import { api, type ApiClient } from '../../lib/api'
import { DEFAULT_PUBLIC_AUTH_CONFIG, type PublicHostedAuthConfig } from './auth-config'

export type AuthConfigSearch = {
  authz_request_id?: string
  client_id?: string
  intent?: string
  invitation_token?: string
  login_hint?: string
  organization_id?: string
}

const AUTH_CONFIG_STALE_TIME_MS = 30_000

export function buildAuthConfigPath(input: {
  loginHint?: string | null
  organizationId?: string | null
  intent?: string | null
  invitationToken?: string | null
  authzRequestId?: string | null
  applicationClientId?: string | null
}): string {
  const params = new URLSearchParams()
  if (input.loginHint) params.set('login_hint', input.loginHint)
  if (input.organizationId) params.set('organization_id', input.organizationId)
  if (input.intent) params.set('intent', input.intent)
  if (input.invitationToken) params.set('invitation_token', input.invitationToken)
  if (input.authzRequestId) params.set('authz_request_id', input.authzRequestId)
  if (input.applicationClientId) params.set('client_id', input.applicationClientId)
  return params.size > 0 ? `/auth/config?${params.toString()}` : '/auth/config'
}

export function authConfigQueryOptions(search: AuthConfigSearch, client: ApiClient) {
  return {
    queryKey: [
      'auth-config',
      search.login_hint ?? null,
      search.organization_id ?? null,
      search.client_id ?? null,
      search.intent ?? null,
      search.invitation_token ?? null,
      search.authz_request_id ?? null,
    ] as const,
    queryFn: async (): Promise<PublicHostedAuthConfig> => {
      const configPath = buildAuthConfigPath({
        loginHint: search.login_hint,
        organizationId: search.organization_id,
        intent: search.intent,
        invitationToken: search.invitation_token,
        authzRequestId: search.authz_request_id,
        applicationClientId: search.client_id,
      })
      const result = await client.get<PublicHostedAuthConfig>(configPath)
      return result.ok ? result.value : DEFAULT_PUBLIC_AUTH_CONFIG
    },
    retry: false,
    staleTime: AUTH_CONFIG_STALE_TIME_MS,
  }
}

// 主 chunk 预热入口;失败由页面内同 key query 兜底。
export function prefetchAuthConfig(queryClient: QueryClient, search: AuthConfigSearch): void {
  void queryClient.prefetchQuery(authConfigQueryOptions(search, api))
}
