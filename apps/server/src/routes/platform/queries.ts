// platform console 数据层(TanStack Query):/v1/platform/* 读写。
// 搜索类列表用 enabled 控制(query 为空不发请求)。
// cookie session + instance_manager 才能访问;错误为 XidError。

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { XidError } from '@xid-kit/types'
import { queryKeyPrefixes, queryKeys, useApiMutation, useApiQuery } from '../../lib/queries'
import type {
  AuditEvent,
  BillingOverview,
  FeatureFlag,
  GlobalUser,
  Page,
  PlatformOrganization,
  PlatformSettings,
} from './types'

export function usePlatformOrganizationsQuery(
  cursor?: string,
  query?: string,
): UseQueryResult<Page<PlatformOrganization>, XidError> {
  return useApiQuery<Page<PlatformOrganization>>(
    queryKeys.platformOrganizations(cursor, query),
    '/v1/platform/organizations',
    { query: { limit: 20, cursor, q: query } },
  )
}

export function useGlobalUsersQuery(query: string): UseQueryResult<Page<GlobalUser>, XidError> {
  return useApiQuery<Page<GlobalUser>>(queryKeys.platformUsers(query), '/v1/platform/users', {
    enabled: Boolean(query),
    query: { limit: 20, q: query },
  })
}

export function useGlobalAuditEventsQuery(
  cursor?: string,
): UseQueryResult<Page<AuditEvent>, XidError> {
  return useApiQuery<Page<AuditEvent>>(
    queryKeys.platformAuditEvents(cursor),
    '/v1/platform/audit-events',
    { query: { limit: 30, cursor } },
  )
}

export function useFeatureFlagsQuery(): UseQueryResult<FeatureFlag[], XidError> {
  return useApiQuery<FeatureFlag[]>(queryKeys.platformFeatureFlags, '/v1/platform/feature-flags')
}

export function usePlatformSettingsQuery(): UseQueryResult<PlatformSettings, XidError> {
  return useApiQuery<PlatformSettings>(queryKeys.platformSettings, '/v1/platform/settings')
}

export function useBillingOverviewQuery(
  cursor?: string,
): UseQueryResult<Page<BillingOverview>, XidError> {
  return useApiQuery<Page<BillingOverview>>(
    queryKeys.platformBilling(cursor),
    '/v1/platform/billing',
    { query: { limit: 20, cursor } },
  )
}

export function useUpdatePlatformSettings(): UseMutationResult<
  PlatformSettings,
  XidError,
  Partial<
    Pick<
      PlatformSettings,
      'defaultLocale' | 'dataResidency' | 'mfaPolicy' | 'passwordPolicy' | 'sessionPolicy'
    >
  >
> {
  return useApiMutation<
    PlatformSettings,
    Partial<
      Pick<
        PlatformSettings,
        'defaultLocale' | 'dataResidency' | 'mfaPolicy' | 'passwordPolicy' | 'sessionPolicy'
      >
    >
  >((api, body) => api.patch<PlatformSettings>('/v1/platform/settings', body), {
    invalidate: [queryKeys.platformSettings],
  })
}

export function useSetFeatureFlagDefault(): UseMutationResult<
  FeatureFlag,
  XidError,
  { key: string; globalDefault: boolean }
> {
  return useApiMutation<FeatureFlag, { key: string; globalDefault: boolean }>(
    (api, { key, globalDefault }) =>
      api.patch<FeatureFlag>(`/v1/platform/feature-flags/${key}`, { globalDefault }),
    { invalidate: [queryKeys.platformFeatureFlags] },
  )
}

export function useUpdatePlatformOrganizationStatus(): UseMutationResult<
  PlatformOrganization,
  XidError,
  { organizationId: string; status: PlatformOrganization['status'] }
> {
  return useApiMutation<
    PlatformOrganization,
    { organizationId: string; status: PlatformOrganization['status'] }
  >(
    (api, { organizationId, status }) =>
      api.patch<PlatformOrganization>(`/v1/platform/organizations/${organizationId}`, { status }),
    { invalidate: [queryKeyPrefixes.platformOrganizations] },
  )
}
