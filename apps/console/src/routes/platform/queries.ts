// 列表走 useApiInfiniteQuery 累积分页;搜索 query 为空时 enabled=false,不发空请求。

import type {
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from '@tanstack/react-query'
import type {
  AuditChainVerification,
  BillingConfig,
  ComplianceDocument,
  GlobalUser,
  InstanceManagerAssignment,
  OrganizationQuotaDetail,
  OrganizationQuotaPatch,
  PlatformAnnouncement,
  PlatformAuditEvent,
  PlatformOrganization,
  PlatformPage,
  PlatformSettings,
  PlatformSettingsPatch,
  QueueDeadLetter,
  QueueDeadLetterReplay,
  StatusIncident,
  StripeHostedSession,
  UsageOverview,
  XidError,
} from '@xid-kit/types'
import {
  queryKeyPrefixes,
  queryKeys,
  useApiInfiniteQuery,
  useApiMutation,
  useApiQuery,
} from '@xid-kit/web-ui/queries'

export type PlatformList<T> = UseInfiniteQueryResult<PlatformPage<T>, XidError>

export function useInstanceManagerAssignmentsList(): PlatformList<InstanceManagerAssignment> {
  return useApiInfiniteQuery<PlatformPage<InstanceManagerAssignment>>(
    queryKeys.platformManagerAssignments,
    '/v1/platform/manager-assignments',
    { query: { limit: 50 } },
  )
}

export function useCreateInstanceManagerAssignment(): UseMutationResult<
  InstanceManagerAssignment,
  XidError,
  { user_id: string }
> {
  return useApiMutation<InstanceManagerAssignment, { user_id: string }>(
    (api, payload) =>
      api.post<InstanceManagerAssignment>('/v1/platform/manager-assignments', payload),
    { invalidate: [queryKeyPrefixes.platformManagerAssignments] },
  )
}

export function useDeleteInstanceManagerAssignment(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, assignmentId) => api.del<unknown>(`/v1/platform/manager-assignments/${assignmentId}`),
    { invalidate: [queryKeyPrefixes.platformManagerAssignments] },
  )
}

export function usePlatformOrganizationsList(query: string): PlatformList<PlatformOrganization> {
  return useApiInfiniteQuery<PlatformPage<PlatformOrganization>>(
    queryKeys.platformOrganizations(query),
    '/v1/platform/organizations',
    { query: { limit: 20, q: query || undefined } },
  )
}

export function useGlobalUsersList(query: string): PlatformList<GlobalUser> {
  return useApiInfiniteQuery<PlatformPage<GlobalUser>>(
    queryKeys.platformUsers(query),
    '/v1/platform/users',
    { enabled: Boolean(query), query: { limit: 20, q: query } },
  )
}

export function useGlobalAuditEventsList(): PlatformList<PlatformAuditEvent> {
  return useApiInfiniteQuery<PlatformPage<PlatformAuditEvent>>(
    queryKeys.platformAuditEvents,
    '/v1/platform/audit-events',
    { query: { limit: 30 } },
  )
}

export function useAuditChainVerificationQuery(
  input: {
    tenantId: string
    fromSeq?: number
    toSeq?: number
  } | null,
): UseQueryResult<AuditChainVerification, XidError> {
  return useApiQuery<AuditChainVerification>(
    queryKeys.platformAuditVerification(input?.tenantId, input?.fromSeq, input?.toSeq),
    '/v1/platform/audit/verify',
    {
      enabled: input !== null && input.tenantId.length > 0,
      staleTime: 0,
      gcTime: 0,
      query: {
        tenant_id: input?.tenantId,
        from_seq: input?.fromSeq,
        to_seq: input?.toSeq,
      },
    },
  )
}

export function useDeadLettersList(): PlatformList<QueueDeadLetter> {
  return useApiInfiniteQuery<PlatformPage<QueueDeadLetter>>(
    queryKeys.platformDeadLetters,
    '/v1/platform/dead-letters',
    { query: { limit: 30 } },
  )
}

export function useReplayDeadLetter(): UseMutationResult<
  QueueDeadLetterReplay,
  XidError,
  { id: string }
> {
  return useApiMutation<QueueDeadLetterReplay, { id: string }>(
    (api, { id }) => api.post<QueueDeadLetterReplay>(`/v1/platform/dead-letters/${id}/replay`, {}),
    { invalidate: [queryKeyPrefixes.platformDeadLetters] },
  )
}

export function usePlatformSettingsQuery(): UseQueryResult<PlatformSettings, XidError> {
  return useApiQuery<PlatformSettings>(queryKeys.platformSettings, '/v1/platform/settings')
}

export function useUsageOverviewList(): PlatformList<UsageOverview> {
  return useApiInfiniteQuery<PlatformPage<UsageOverview>>(
    queryKeys.platformUsage,
    '/v1/platform/usage',
    { query: { limit: 20 } },
  )
}

export function useOrganizationQuotaQuery(
  tenantId: string,
): UseQueryResult<OrganizationQuotaDetail, XidError> {
  return useApiQuery<OrganizationQuotaDetail>(
    queryKeys.platformQuota(tenantId),
    `/v1/platform/quotas/${encodeURIComponent(tenantId)}`,
    { enabled: tenantId.length > 0 },
  )
}

// 不带 tenantId 时只回答实例是否开启计费;带 tenantId 时额外回答该租户能否打开 Customer Portal。
export function useBillingConfigQuery(tenantId?: string): UseQueryResult<BillingConfig, XidError> {
  return useApiQuery<BillingConfig>(
    queryKeys.platformBillingConfig(tenantId),
    '/v1/platform/billing/config',
    tenantId ? { query: { tenantId } } : undefined,
  )
}

export function useCreateStripePortal(): UseMutationResult<
  StripeHostedSession,
  XidError,
  { tenantId: string }
> {
  return useApiMutation((api, body) =>
    api.post<StripeHostedSession>('/v1/platform/billing/portal', body),
  )
}

export function useUpdateOrganizationQuotas(): UseMutationResult<
  OrganizationQuotaDetail,
  XidError,
  { tenantId: string; body: OrganizationQuotaPatch }
> {
  return useApiMutation<
    OrganizationQuotaDetail,
    { tenantId: string; body: OrganizationQuotaPatch }
  >(
    (api, { tenantId, body }) =>
      api.patch<OrganizationQuotaDetail>(
        `/v1/platform/quotas/${encodeURIComponent(tenantId)}`,
        body,
      ),
    { invalidate: [queryKeyPrefixes.platformQuotas, queryKeyPrefixes.platformUsage] },
  )
}

export function useUpdatePlatformSettings(): UseMutationResult<
  PlatformSettings,
  XidError,
  PlatformSettingsPatch
> {
  return useApiMutation<PlatformSettings, PlatformSettingsPatch>(
    (api, body) => api.patch<PlatformSettings>('/v1/platform/settings', body),
    { invalidate: [queryKeys.platformSettings] },
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

export function usePlatformAnnouncementsList(): PlatformList<PlatformAnnouncement> {
  return useApiInfiniteQuery<PlatformPage<PlatformAnnouncement>>(
    queryKeys.platformAnnouncements,
    '/v1/platform/announcements',
    { query: { limit: 30 } },
  )
}

export function useCreatePlatformAnnouncement(): UseMutationResult<
  PlatformAnnouncement,
  XidError,
  Omit<PlatformAnnouncement, 'id' | 'createdBy' | 'updatedBy' | 'createdAt' | 'updatedAt'>
> {
  return useApiMutation(
    (api, body) => api.post<PlatformAnnouncement>('/v1/platform/announcements', body),
    { invalidate: [queryKeyPrefixes.platformAnnouncements] },
  )
}

export function useUpdatePlatformAnnouncement(): UseMutationResult<
  PlatformAnnouncement,
  XidError,
  {
    id: string
    body: Partial<
      Pick<
        PlatformAnnouncement,
        | 'scopeType'
        | 'scopeValue'
        | 'title'
        | 'body'
        | 'severity'
        | 'status'
        | 'startsAt'
        | 'endsAt'
      >
    >
  }
> {
  return useApiMutation(
    (api, { id, body }) =>
      api.patch<PlatformAnnouncement>(`/v1/platform/announcements/${id}`, body),
    { invalidate: [queryKeyPrefixes.platformAnnouncements] },
  )
}

export function useDeletePlatformAnnouncement(): UseMutationResult<
  { deleted: true },
  XidError,
  { id: string }
> {
  return useApiMutation(
    (api, { id }) => api.del<{ deleted: true }>(`/v1/platform/announcements/${id}`),
    { invalidate: [queryKeyPrefixes.platformAnnouncements] },
  )
}

export function usePlatformStatusIncidentsList(): PlatformList<StatusIncident> {
  return useApiInfiniteQuery<PlatformPage<StatusIncident>>(
    queryKeys.platformStatusIncidents,
    '/v1/platform/status-incidents',
    { query: { limit: 30 } },
  )
}

export function useCreateStatusIncident(): UseMutationResult<
  StatusIncident,
  XidError,
  Pick<StatusIncident, 'title' | 'status' | 'impact' | 'summary' | 'startedAt'>
> {
  return useApiMutation(
    (api, body) => api.post<StatusIncident>('/v1/platform/status-incidents', body),
    { invalidate: [queryKeyPrefixes.platformStatusIncidents] },
  )
}

export function useAppendStatusIncidentUpdate(): UseMutationResult<
  StatusIncident,
  XidError,
  { id: string; status: StatusIncident['status']; message: string }
> {
  return useApiMutation(
    (api, { id, ...body }) =>
      api.post<StatusIncident>(`/v1/platform/status-incidents/${id}/updates`, body),
    { invalidate: [queryKeyPrefixes.platformStatusIncidents] },
  )
}

export function useDeleteStatusIncident(): UseMutationResult<
  { deleted: true },
  XidError,
  { id: string }
> {
  return useApiMutation(
    (api, { id }) => api.del<{ deleted: true }>(`/v1/platform/status-incidents/${id}`),
    { invalidate: [queryKeyPrefixes.platformStatusIncidents] },
  )
}

export function usePlatformComplianceDocumentsList(): PlatformList<ComplianceDocument> {
  return useApiInfiniteQuery<PlatformPage<ComplianceDocument>>(
    queryKeys.platformComplianceDocuments,
    '/v1/platform/compliance-documents',
    { query: { limit: 30 } },
  )
}

export function useCreateComplianceDocument(): UseMutationResult<
  ComplianceDocument,
  XidError,
  Pick<
    ComplianceDocument,
    'tenantId' | 'documentType' | 'title' | 'status' | 'storageKey' | 'checksum' | 'version'
  >
> {
  return useApiMutation(
    (api, body) => api.post<ComplianceDocument>('/v1/platform/compliance-documents', body),
    { invalidate: [queryKeyPrefixes.platformComplianceDocuments] },
  )
}

export function useUpdateComplianceDocument(): UseMutationResult<
  ComplianceDocument,
  XidError,
  {
    id: string
    body: Partial<
      Pick<
        ComplianceDocument,
        'tenantId' | 'documentType' | 'title' | 'status' | 'storageKey' | 'checksum' | 'version'
      >
    >
  }
> {
  return useApiMutation(
    (api, { id, body }) =>
      api.patch<ComplianceDocument>(`/v1/platform/compliance-documents/${id}`, body),
    { invalidate: [queryKeyPrefixes.platformComplianceDocuments] },
  )
}

export function useDeleteComplianceDocument(): UseMutationResult<
  { deleted: true },
  XidError,
  { id: string }
> {
  return useApiMutation(
    (api, { id }) => api.del<{ deleted: true }>(`/v1/platform/compliance-documents/${id}`),
    { invalidate: [queryKeyPrefixes.platformComplianceDocuments] },
  )
}
