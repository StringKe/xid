// /auth/config 查询装配:queryKey/queryFn 在 SignInPage 懒 chunk 内外共享。
// main.tsx 在 chunk 瀑布(locale catalog -> SignInPage 懒 chunk)完成前用同一装配预热,
// 使配置请求与 JS 下载并行;staleTime 避免预热结果在页面挂载时立即判 stale 而重复请求。
// config 内含一次性 guest capability,只允许秒级短 stale,不做长缓存。

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

// 页面 chunk 外的预热入口(main.tsx)。失败不处理:页面内 query 会以同 key 自行兜底。
export function prefetchAuthConfig(queryClient: QueryClient, search: AuthConfigSearch): void {
  void queryClient.prefetchQuery(authConfigQueryOptions(search, api))
}
