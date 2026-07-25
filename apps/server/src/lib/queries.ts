// TanStack Query 数据层:把 api.ts 的 Result<T> 调用封装成 useQuery/useMutation hooks,
// 约定:
//   - queryKey 走 queryKeys 工厂(扁平命名空间,失效时按前缀 invalidate)。
//   - queryFn 经 unwrap 把 Result<T> 失败抛成 XidError(契约冻结),成功返回 value;
//     react-query 的 error 即 XidError,页面用 error.code 走 lingui、meta.paramName 映射字段。
//   - mutation 成功后按受影响 queryKey 前缀 invalidate,触发自动 refetch。
//   - credentials/401:沿用 api client(credentials:'include' + onUnauthorized),hooks 取 useAuth().api。

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  QueryKey,
  UseMutationOptions,
  UseMutationResult,
  UseQueryOptions,
  UseQueryResult,
} from '@tanstack/react-query'
import type { Result, XidError } from '@xid-kit/types'
import { useAuth } from './auth-context'
import type { ApiClient, ApiRequestOptions } from './api'
import type { MeResponse } from './auth-context'

// --- queryKey 工厂 ---
// 扁平 as const 元组;列表 key 末位带可变参(orgId/cursor/query)便于精确与前缀失效。

export const queryKeys = {
  me: ['me'] as const,
  meProfile: ['me', 'profile'] as const,
  meMfaFactors: ['me', 'mfa-factors'] as const,
  mePasskeys: ['me', 'passkeys'] as const,
  meSocialConnections: ['me', 'social-connections'] as const,
  meSessions: ['me', 'sessions'] as const,
  meTrustedDevices: ['me', 'trusted-devices'] as const,
  users: (query?: string) => ['users', { query: query ?? null }] as const,
  user: (userId: string) => ['users', userId] as const,
  organizations: (cursor?: string) => ['organizations', { cursor: cursor ?? null }] as const,
  organization: (orgId: string) => ['organizations', orgId] as const,
  orgMembers: (orgId: string, cursor?: string) =>
    ['organizations', orgId, 'members', { cursor: cursor ?? null }] as const,
  orgInvitations: (orgId: string, cursor?: string) =>
    ['organizations', orgId, 'invitations', { cursor: cursor ?? null }] as const,
  orgRoles: (orgId: string) => ['organizations', orgId, 'roles'] as const,
  orgSsoConnections: (orgId: string) => ['organizations', orgId, 'sso-connections'] as const,
  orgOutboundSamlApps: (orgId: string) => ['organizations', orgId, 'outbound-saml-apps'] as const,
  orgScimDirectories: (orgId: string) => ['organizations', orgId, 'directories'] as const,
  orgScimTargets: (orgId: string) => ['organizations', orgId, 'scim-targets'] as const,
  orgDomains: (orgId: string) => ['organizations', orgId, 'domains'] as const,
  orgBranding: (orgId: string) => ['organizations', orgId, 'branding'] as const,
  orgAuthPolicy: (orgId: string) => ['organizations', orgId, 'auth-policy'] as const,
  orgDeliveryChannels: (orgId: string) => ['organizations', orgId, 'delivery-channels'] as const,
  orgSocialProviders: (orgId: string) => ['organizations', orgId, 'social-providers'] as const,
  orgAuditEvents: (orgId: string, cursor?: string) =>
    ['organizations', orgId, 'audit-events', { cursor: cursor ?? null }] as const,
  applications: (cursor?: string) => ['applications', { cursor: cursor ?? null }] as const,
  application: (appId: string) => ['applications', appId] as const,
  webhooks: (cursor?: string) => ['webhooks', { cursor: cursor ?? null }] as const,
  apiKeys: (cursor?: string) => ['api-keys', { cursor: cursor ?? null }] as const,
  platformOrganizations: (cursor?: string, query?: string) =>
    ['platform', 'organizations', { cursor: cursor ?? null, query: query ?? null }] as const,
  platformUsers: (query?: string) => ['platform', 'users', { query: query ?? null }] as const,
  platformAuditEvents: (cursor?: string) =>
    ['platform', 'audit-events', { cursor: cursor ?? null }] as const,
  platformFeatureFlags: ['platform', 'feature-flags'] as const,
  platformSettings: ['platform', 'settings'] as const,
  platformBilling: (cursor?: string) =>
    ['platform', 'billing', { cursor: cursor ?? null }] as const,
} as const

// 失效前缀:列表 query 的 key 末位带 cursor 对象,invalidate 用 3 段前缀(react-query 部分匹配命中所有分页变体)。
export const queryKeyPrefixes = {
  organizations: ['organizations'] as const,
  orgMembers: (orgId: string) => ['organizations', orgId, 'members'] as const,
  orgInvitations: (orgId: string) => ['organizations', orgId, 'invitations'] as const,
  orgSsoConnections: (orgId: string) => ['organizations', orgId, 'sso-connections'] as const,
  orgScimDirectories: (orgId: string) => ['organizations', orgId, 'directories'] as const,
  orgScimTargets: (orgId: string) => ['organizations', orgId, 'scim-targets'] as const,
  applications: ['applications'] as const,
  webhooks: ['webhooks'] as const,
  apiKeys: ['api-keys'] as const,
  users: ['users'] as const,
  platformOrganizations: ['platform', 'organizations'] as const,
  platformUsers: ['platform', 'users'] as const,
  platformAuditEvents: ['platform', 'audit-events'] as const,
  platformBilling: ['platform', 'billing'] as const,
} as const

// --- queryFn 基础:Result<T> -> throw XidError | return value ---

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value
  throw result.error
}

// path/options 组合的 GET queryFn 工厂(列表/详情通用)。
function getFn<T>(
  api: ApiClient,
  path: string,
  options?: Omit<ApiRequestOptions, 'method' | 'body'>,
) {
  return async ({ signal }: { signal: AbortSignal }): Promise<T> =>
    unwrap(await api.get<T>(path, { ...options, signal }))
}

// --- 通用 query/mutation 包装(显式 XidError 错误类型) ---

type QueryConfig<T> = Omit<UseQueryOptions<T, XidError, T, QueryKey>, 'queryKey' | 'queryFn'>

// 读:queryKey + path,自动注入共享 api client、AbortSignal、XidError 错误类型。
export function useApiQuery<T>(
  key: QueryKey,
  path: string,
  config?: QueryConfig<T> & { query?: ApiRequestOptions['query'] },
): UseQueryResult<T, XidError> {
  const { api } = useAuth()
  const { query, ...rest } = config ?? {}
  return useQuery<T, XidError, T, QueryKey>({
    queryKey: key,
    queryFn: getFn<T>(api, path, query ? { query } : undefined),
    ...rest,
  })
}

type MutationConfig<TData, TVars> = Omit<
  UseMutationOptions<TData, XidError, TVars>,
  'mutationFn'
> & {
  // mutation 成功后失效的 queryKey 前缀列表(react-query 默认按前缀匹配子键)。
  invalidate?: readonly QueryKey[]
}

// 写:mutationFn 拿 api client,成功后按 invalidate 列表失效。
export function useApiMutation<TData, TVars>(
  mutationFn: (api: ApiClient, vars: TVars) => Promise<Result<TData>>,
  config?: MutationConfig<TData, TVars>,
): UseMutationResult<TData, XidError, TVars> {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  const { invalidate, onSuccess, ...rest } = config ?? {}
  return useMutation<TData, XidError, TVars>({
    mutationFn: async (vars) => unwrap(await mutationFn(api, vars)),
    onSuccess: (data, vars, onMutateResult, ctx) => {
      if (invalidate) {
        for (const key of invalidate) void queryClient.invalidateQueries({ queryKey: key })
      }
      onSuccess?.(data, vars, onMutateResult, ctx)
    },
    ...rest,
  })
}

// --- /v1/me 会话(auth-context 复用) ---

// 当前会话上下文。staleTime 给一个非 0(query.ts 默认 30s 已覆盖),401 由 api client 归一。
export function useMe(config?: QueryConfig<MeResponse>): UseQueryResult<MeResponse, XidError> {
  return useApiQuery<MeResponse>(queryKeys.me, '/v1/me', config)
}
