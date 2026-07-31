// platform console 数据层(TanStack Query):/v1/platform/* 读写。
// 搜索类列表用 enabled 控制(query 为空不发请求)。
// cookie session + instance_manager 才能访问;错误为 XidError。

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { XidError } from '@xid-kit/types'
import { queryKeyPrefixes, queryKeys, useApiMutation, useApiQuery } from '@xid-kit/web-ui/queries'
import type {
  AuditChainVerification,
  AuditEvent,
  BillingOverview,
  ComplianceDocument,
  FeatureFlag,
  GlobalUser,
  InstanceManagerAssignment,
  OrganizationPlanDetail,
  OrganizationPlanPatch,
  Page,
  PlatformAnnouncement,
  PlatformOrganization,
  PlatformSettings,
  QueueDeadLetter,
  QueueDeadLetterReplay,
  StatusIncident,
  StripeBillingConfig,
  StripeHostedSession,
} from './types'

export function useInstanceManagerAssignmentsQuery(
  cursor?: string,
): UseQueryResult<Page<InstanceManagerAssignment>, XidError> {
  return useApiQuery<Page<InstanceManagerAssignment>>(
    queryKeys.platformManagerAssignments(cursor),
    '/v1/platform/manager-assignments',
    { query: { limit: 50, cursor } },
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

export function useGlobalUsersQuery(
  query: string,
  cursor?: string,
): UseQueryResult<Page<GlobalUser>, XidError> {
  return useApiQuery<Page<GlobalUser>>(
    queryKeys.platformUsers(query, cursor),
    '/v1/platform/users',
    {
      enabled: Boolean(query),
      query: { limit: 20, cursor, q: query },
    },
  )
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
      query: {
        tenant_id: input?.tenantId,
        from_seq: input?.fromSeq,
        to_seq: input?.toSeq,
      },
    },
  )
}

export function useDeadLettersQuery(
  cursor?: string,
): UseQueryResult<Page<QueueDeadLetter>, XidError> {
  return useApiQuery<Page<QueueDeadLetter>>(
    queryKeys.platformDeadLetters(cursor),
    '/v1/platform/dead-letters',
    { query: { limit: 30, cursor } },
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

export function useOrganizationPlanQuery(
  tenantId: string,
): UseQueryResult<OrganizationPlanDetail, XidError> {
  return useApiQuery<OrganizationPlanDetail>(
    queryKeys.platformPlan(tenantId),
    `/v1/platform/plans/${encodeURIComponent(tenantId)}`,
    { enabled: tenantId.length > 0 },
  )
}

export function useStripeBillingConfigQuery(
  tenantId: string,
): UseQueryResult<StripeBillingConfig, XidError> {
  return useApiQuery<StripeBillingConfig>(
    queryKeys.platformStripeBilling(tenantId),
    '/v1/platform/billing/stripe-config',
    { enabled: tenantId.length > 0, query: { tenantId } },
  )
}

export function useCreateStripeCheckout(): UseMutationResult<
  StripeHostedSession,
  XidError,
  {
    tenantId: string
    plan: Exclude<OrganizationPlanDetail['plan'], 'free'>
    idempotencyKey: string
  }
> {
  return useApiMutation((api, body) =>
    api.post<StripeHostedSession>('/v1/platform/billing/checkout', body),
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

export function useUpdateOrganizationPlan(): UseMutationResult<
  OrganizationPlanDetail,
  XidError,
  { tenantId: string; body: OrganizationPlanPatch }
> {
  return useApiMutation<OrganizationPlanDetail, { tenantId: string; body: OrganizationPlanPatch }>(
    (api, { tenantId, body }) =>
      api.patch<OrganizationPlanDetail>(`/v1/platform/plans/${encodeURIComponent(tenantId)}`, body),
    {
      invalidate: [
        queryKeyPrefixes.platformPlans,
        queryKeyPrefixes.platformOrganizations,
        queryKeyPrefixes.platformBilling,
      ],
    },
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

export function usePlatformAnnouncementsQuery(
  cursor?: string,
): UseQueryResult<Page<PlatformAnnouncement>, XidError> {
  return useApiQuery<Page<PlatformAnnouncement>>(
    queryKeys.platformAnnouncements(cursor),
    '/v1/platform/announcements',
    { query: { limit: 30, cursor } },
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

export function usePlatformStatusIncidentsQuery(
  cursor?: string,
): UseQueryResult<Page<StatusIncident>, XidError> {
  return useApiQuery<Page<StatusIncident>>(
    queryKeys.platformStatusIncidents(cursor),
    '/v1/platform/status-incidents',
    { query: { limit: 30, cursor } },
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

export function useUpdateStatusIncident(): UseMutationResult<
  StatusIncident,
  XidError,
  {
    id: string
    body: Partial<
      Pick<StatusIncident, 'title' | 'status' | 'impact' | 'summary' | 'startedAt' | 'resolvedAt'>
    >
  }
> {
  return useApiMutation(
    (api, { id, body }) => api.patch<StatusIncident>(`/v1/platform/status-incidents/${id}`, body),
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

export function usePlatformComplianceDocumentsQuery(
  cursor?: string,
): UseQueryResult<Page<ComplianceDocument>, XidError> {
  return useApiQuery<Page<ComplianceDocument>>(
    queryKeys.platformComplianceDocuments(cursor),
    '/v1/platform/compliance-documents',
    { query: { limit: 30, cursor } },
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
