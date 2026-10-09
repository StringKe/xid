// 平台运维页的数据契约与 hook:在共享 DTO 上扩展本组接口新增的字段,页面统一从这里取数据。

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type {
  AuditChainVerification,
  ComplianceDocument,
  PlatformAuditEvent,
  PlatformPage,
  PlatformStats,
  QueueDeadLetter,
  QueueDeadLetterReplay,
  StatusIncident,
  StatusIncidentUpdate,
  XidError,
} from '@xid-kit/types'
import {
  queryKeyPrefixes,
  queryKeys,
  useApiInfiniteQuery,
  useApiMutation,
  useApiQuery,
} from '@xid-kit/web-ui/queries'
import type { PlatformList } from './queries'

export type PlatformAttentionItem =
  | {
      kind: 'dead_letters'
      facts: {
        count: number
        byQueue: Array<{ queue: string; count: number }>
        oldestFailedAt: string
      }
    }
  | {
      kind: 'incident_open'
      facts: {
        incidentId: string
        title: string
        status: StatusIncident['status']
        startedAt: string
        lastUpdateAt: string | null
      }
    }
  | { kind: 'signing_key_next_ready'; facts: { kid: string; publishedAt: string } }
  | {
      kind: 'mau_quota_high'
      facts: {
        organizations: Array<{ organizationId: string; name: string; mau: number; limit: number }>
      }
    }
  | {
      kind: 'organization_suspended'
      facts: { organizationId: string; name: string; suspendedAt: string }
    }

export type PlatformActivityKey = 'dau' | 'mau' | 'login_success_rate' | 'organizations' | 'users'

export type PlatformActivityMetric = {
  key: PlatformActivityKey
  now: number | null
  previous: number | null
}

export type PlatformRecentActivity = {
  id: string
  eventType: string
  actorId: string | null
  actorName: string | null
  targetType: string | null
  targetId: string | null
  occurredAt: string
}

export type PlatformOverviewStats = PlatformStats & {
  attention: PlatformAttentionItem[]
  activity: PlatformActivityMetric[]
  recentPlatformActivity: PlatformRecentActivity[]
}

export type PlatformAuditEventDetail = PlatformAuditEvent & {
  actorName: string | null
  details: Record<string, unknown>
}

export type PlatformAuditFilters = {
  eventType: string
  actorId: string
  organizationId: string
}

export type AuditChainVerificationReport = AuditChainVerification & {
  mismatch: { field: 'prev_hash' | 'hash'; expected: string; stored: string } | null
  batch_count: number
  duration_ms: number
}

export type PlatformDeadLetter = QueueDeadLetter & { organizationName: string | null }

export type DeadLetterQueueCount = { queue: string; count: number }

export type PlatformDeadLetterPage = PlatformPage<PlatformDeadLetter> & {
  countsByQueue: DeadLetterQueueCount[]
}

export type DeadLetterBatchReplayItem =
  | (QueueDeadLetterReplay & { outcome: 'replayed' | 'already_replayed' | 'lease_held' })
  | {
      id: string
      outcome: 'failed'
      status: null
      reason: 'returned_to_quarantine' | 'needs_operator'
    }

export type DeadLetterBatchReplay = {
  sourceQueue: string | null
  results: DeadLetterBatchReplayItem[]
}

export const STATUS_INCIDENT_COMPONENTS = [
  'hosted_sign_in',
  'token_endpoint',
  'management_api',
  'console',
  'email_delivery',
  'sms_delivery',
  'whatsapp_delivery',
  'webhooks',
] as const

export type StatusIncidentComponent = (typeof STATUS_INCIDENT_COMPONENTS)[number]

export type PlatformStatusIncidentUpdate = StatusIncidentUpdate & { createdByName: string | null }

export type PlatformStatusIncident = Omit<StatusIncident, 'updates'> & {
  components: StatusIncidentComponent[]
  lastUpdateAt: string | null
  updates: PlatformStatusIncidentUpdate[]
}

export type PlatformComplianceDocument = ComplianceDocument & {
  sizeBytes: number | null
  lastCheckedAt: string | null
  lastCheckResult: 'matched' | 'mismatch' | null
  registeredBy: string | null
}

export function usePlatformOverviewStats(): UseQueryResult<PlatformOverviewStats, XidError> {
  return useApiQuery<PlatformOverviewStats>(['platform', 'stats'] as const, '/v1/platform/stats')
}

export function usePlatformAuditEvents(
  filters: PlatformAuditFilters,
): PlatformList<PlatformAuditEventDetail> {
  return useApiInfiniteQuery<PlatformPage<PlatformAuditEventDetail>>(
    [...queryKeys.platformAuditEvents, filters],
    '/v1/platform/audit-events',
    {
      query: {
        limit: 30,
        event_type: filters.eventType || undefined,
        actor_id: filters.actorId || undefined,
        organization_id: filters.organizationId || undefined,
      },
    },
  )
}

export function useAuditChainReport(
  input: { tenantId: string; fromSeq?: number; toSeq?: number } | null,
): UseQueryResult<AuditChainVerificationReport, XidError> {
  return useApiQuery<AuditChainVerificationReport>(
    queryKeys.platformAuditVerification(input?.tenantId, input?.fromSeq, input?.toSeq),
    '/v1/platform/audit/verify',
    {
      enabled: input !== null && input.tenantId.length > 0,
      staleTime: 0,
      gcTime: 0,
      query: { tenant_id: input?.tenantId, from_seq: input?.fromSeq, to_seq: input?.toSeq },
    },
  )
}

// Previous / Next 翻页:游标由页面保存,每页单独缓存,不把多页拼成一张长表。
export function useDeadLetterPage(input: {
  queue: string | null
  cursor: string | null
}): UseQueryResult<PlatformDeadLetterPage, XidError> {
  return useApiQuery<PlatformDeadLetterPage>(
    [...queryKeys.platformDeadLetters, input],
    '/v1/platform/dead-letters',
    {
      query: {
        limit: 25,
        status: 'open',
        queue: input.queue ?? undefined,
        cursor: input.cursor ?? undefined,
      },
    },
  )
}

export function useReplayDeadLetters(): UseMutationResult<
  DeadLetterBatchReplay,
  XidError,
  { ids: string[] }
> {
  return useApiMutation<DeadLetterBatchReplay, { ids: string[] }>(
    (api, body) => api.post<DeadLetterBatchReplay>('/v1/platform/dead-letters/replay', body),
    { invalidate: [queryKeyPrefixes.platformDeadLetters, ['platform', 'stats']] },
  )
}

export function useStatusIncidents(): PlatformList<PlatformStatusIncident> {
  return useApiInfiniteQuery<PlatformPage<PlatformStatusIncident>>(
    queryKeys.platformStatusIncidents,
    '/v1/platform/status-incidents',
    { query: { limit: 30 } },
  )
}

export function useStatusIncident(id: string): UseQueryResult<PlatformStatusIncident, XidError> {
  return useApiQuery<PlatformStatusIncident>(
    [...queryKeyPrefixes.platformStatusIncidents, 'detail', id],
    `/v1/platform/status-incidents/${encodeURIComponent(id)}`,
    { enabled: id.length > 0 },
  )
}

export type StatusIncidentInput = Pick<
  PlatformStatusIncident,
  'title' | 'status' | 'impact' | 'summary' | 'startedAt' | 'components'
>

export function useOpenStatusIncident(): UseMutationResult<
  PlatformStatusIncident,
  XidError,
  StatusIncidentInput
> {
  return useApiMutation(
    (api, body) => api.post<PlatformStatusIncident>('/v1/platform/status-incidents', body),
    { invalidate: [queryKeyPrefixes.platformStatusIncidents, ['platform', 'stats']] },
  )
}

export function usePostStatusIncidentUpdate(): UseMutationResult<
  PlatformStatusIncident,
  XidError,
  {
    id: string
    status: StatusIncident['status']
    message: string
    components: StatusIncidentComponent[]
  }
> {
  return useApiMutation(
    (api, { id, ...body }) =>
      api.post<PlatformStatusIncident>(
        `/v1/platform/status-incidents/${encodeURIComponent(id)}/updates`,
        body,
      ),
    { invalidate: [queryKeyPrefixes.platformStatusIncidents, ['platform', 'stats']] },
  )
}

export function useComplianceDocuments(): PlatformList<PlatformComplianceDocument> {
  return useApiInfiniteQuery<PlatformPage<PlatformComplianceDocument>>(
    queryKeys.platformComplianceDocuments,
    '/v1/platform/compliance-documents',
    { query: { limit: 30 } },
  )
}
