// Overview 与组织审计日志的接口契约和查询 hook;句子在组件里用 lingui 组装,这里只放事实字段。

import type { UseQueryResult } from '@tanstack/react-query'
import { useApiQuery } from '@xid-kit/web-ui/queries'
import type { XidError } from '@xid-kit/types'
import type { AuditEvent } from './types'

export type AttentionKind =
  | 'sso_certificate_expiring'
  | 'webhook_failing'
  | 'domain_unverified'
  | 'invitation_expired'

type AttentionBase<K extends AttentionKind, F> = {
  kind: K
  severity: 'critical' | 'warning' | 'notice'
  targetId: string
  facts: F
}

export type AttentionItem =
  | AttentionBase<
      'sso_certificate_expiring',
      { connectionName: string | null; notAfter: string; affectedUserCount: number }
    >
  | AttentionBase<
      'webhook_failing',
      {
        url: string
        failedCount: number
        deadCount: number
        since: string | null
        lastResponseStatus: number | null
      }
    >
  | AttentionBase<
      'domain_unverified',
      {
        domain: string
        addedAt: string | null
        lastCheckedAt: string | null
        ssoConnectionName: string | null
      }
    >
  | AttentionBase<'invitation_expired', { count: number; email: string; expiredAt: string | null }>

export type OrgAttention = {
  items: AttentionItem[]
  checkedAt: string
  nextCertificateExpiry: { connectionName: string | null; notAfter: string } | null
}

export type ActivityMetricKey = 'mau' | 'sign_in_succeeded' | 'sign_in_failed'

export type ActivityMetric = {
  key: ActivityMetricKey
  value: number
  previousValue: number
  series: number[]
}

export type DayRange = { from: string; to: string }

export type SignInActivity = {
  period: DayRange
  previous: DayRange
  metrics: ActivityMetric[]
}

export type SetupProgress = {
  domainVerified: boolean
  signInDecided: boolean
  membersInvited: boolean
  pendingDomain: string | null
}

export type AuditSource = 'console' | 'management_api' | 'scim' | 'account' | 'system'

export type AuditActorKind =
  | 'user'
  | 'api_key'
  | 'directory'
  | 'system'
  | 'deleted_user'
  | 'unknown'

export type AuditEntry = AuditEvent & {
  prevHash: string
  source: AuditSource
  actor: { kind: AuditActorKind; displayName: string | null }
  targetDisplay: string | null
  payload: Record<string, unknown>
}

export type AuditEntryPage = {
  data: AuditEntry[]
  next_cursor: string | null
  has_more: boolean
  total: number
}

export type AuditLogQuery = {
  q?: string
  event_type?: string
  actor_id?: string
  occurred_from?: string
  occurred_to?: string
  cursor?: string
  limit?: string
}

type Options = { enabled: boolean }

export function useOrgAttention(
  orgId: string,
  options: Options,
): UseQueryResult<OrgAttention, XidError> {
  return useApiQuery<OrgAttention>(
    ['organizations', orgId, 'attention'] as const,
    `/v1/organizations/${orgId}/attention`,
    options,
  )
}

export function useSignInActivity(
  orgId: string,
  options: Options,
): UseQueryResult<SignInActivity, XidError> {
  return useApiQuery<SignInActivity>(
    ['organizations', orgId, 'sign-in-activity', 7] as const,
    `/v1/organizations/${orgId}/sign-in-activity`,
    { ...options, query: { days: '7' } },
  )
}

export function useSetupProgress(
  orgId: string,
  options: Options,
): UseQueryResult<SetupProgress, XidError> {
  return useApiQuery<SetupProgress>(
    ['organizations', orgId, 'setup-progress'] as const,
    `/v1/organizations/${orgId}/setup-progress`,
    options,
  )
}

export function useOrgAuditLog(
  orgId: string,
  query: AuditLogQuery,
): UseQueryResult<AuditEntryPage, XidError> {
  const params = Object.fromEntries(
    Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1])),
  )
  return useApiQuery<AuditEntryPage>(
    ['organizations', orgId, 'audit-log', params] as const,
    `/v1/organizations/${orgId}/audit-events`,
    { enabled: orgId !== '', query: params, placeholderData: (previous) => previous },
  )
}
