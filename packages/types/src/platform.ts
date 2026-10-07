// Instance Manager Console 与 /v1/platform/* 的共享 DTO 契约(worker 返回值与 Console 读取同一份类型)。

import type { SessionPolicy, TokenPolicy } from './tenant'

export type PlatformPage<T> = {
  data: T[]
  nextCursor: string | null
  total: number
}

export const BILLING_ACCOUNT_STATUSES = ['active', 'trialing', 'past_due', 'canceled'] as const
export type BillingAccountStatus = (typeof BILLING_ACCOUNT_STATUSES)[number]

export const ORGANIZATION_QUOTA_KEYS = ['seats', 'organizations', 'sso_connections', 'mau'] as const
export type OrganizationQuotaKey = (typeof ORGANIZATION_QUOTA_KEYS)[number]

export const ORGANIZATION_QUOTA_ENFORCEMENTS = ['observe', 'block_creation'] as const
export type OrganizationQuotaEnforcement = (typeof ORGANIZATION_QUOTA_ENFORCEMENTS)[number]

export type PlatformOrganizationStatus = 'active' | 'suspended' | 'deleted'

export type PlatformOrganization = {
  id: string
  slug: string
  name: string
  status: PlatformOrganizationStatus
  userCount: number
  orgCount: number
  createdAt: string
  canChangeStatus: boolean
}

export type GlobalUserOrganization = {
  id: string
  slug: string
  name: string
}

export type GlobalUserStatus = 'active' | 'inactive' | 'banned'

export type GlobalUser = {
  id: string
  email: string
  name: string | null
  organizations: GlobalUserOrganization[]
  status: GlobalUserStatus
  createdAt: string
}

export type PlatformAuditEvent = {
  id: string
  seq: number
  organizationId: string
  organizationName: string | null
  orgId: string | null
  eventType: string
  actorId: string | null
  actorDisplay: string | null
  actorIp: string | null
  targetType: string | null
  targetId: string | null
  occurredAt: string
}

export type AuditChainFailureReason =
  | 'audit_chain_broken'
  | 'audit_seq_gap'
  | 'audit_genesis_missing'

export type AuditChainVerification = {
  tenant_id: string
  verified_range: { from: number; to: number }
  truncated: boolean
  latest_seq: number
  chain_valid: boolean
  broken_at_seq: number | null
  failure_reason: AuditChainFailureReason | null
  record_count: number
  computed_at: string
}

export type QueueDeadLetterStatus = 'pending' | 'replaying' | 'replayed'

export type QueueDeadLetter = {
  id: string
  sourceQueue: string
  deadLetterQueue: string
  messageId: string
  tenantId: string | null
  orgId: string | null
  eventType: string
  errorCode: string
  status: QueueDeadLetterStatus
  replayable: boolean
  attempts: number
  sourceEnqueuedAt: string
  failedAt: string
  replayRequestedAt: string | null
  replayedAt: string | null
  replayedBy: string | null
  replayCount: number
  lastReplayErrorCode: string | null
}

export type QueueDeadLetterReplay = {
  id: string
  status: QueueDeadLetterStatus
  replayed: boolean
  idempotent: boolean
}

export type UsageBillingStatus = 'ok' | 'overdue'

export type UsageOverview = {
  organizationId: string
  organizationName: string
  mau: number
  dau: number
  seatUsed: number
  billingStatus?: UsageBillingStatus
}

export type OrganizationQuota = {
  key: OrganizationQuotaKey
  limit: number | null
  enforcement: OrganizationQuotaEnforcement
}

export type OrganizationQuotaDetail = {
  tenantId: string
  name: string
  quotas: OrganizationQuota[]
}

export type OrganizationQuotaPatch = {
  quotas: OrganizationQuota[]
}

export type BillingConfig = {
  enabled: boolean
  portal: boolean
  metering: boolean
}

export type StripeHostedSession = {
  id: string
  url: string
  expiresAt: number | null
}

export type PlatformMfaPolicy = 'required' | 'optional' | 'disabled'

export type PlatformSettings = {
  id: string
  name: string
  primaryDomain: string
  mode: string
  defaultLocale: string
  dataResidency: string
  mfaPolicy: PlatformMfaPolicy
  passwordPolicy: Record<string, unknown>
  sessionPolicy: SessionPolicy
  tokenPolicy: TokenPolicy
  status: string
}

export type PlatformSettingsPatch = {
  defaultLocale?: string
  mfaPolicy?: PlatformMfaPolicy
  passwordPolicy?: Record<string, unknown>
  sessionPolicy?: Partial<SessionPolicy>
  tokenPolicy?: Partial<TokenPolicy>
}

export type PlatformStats = {
  organizationCount: number
  totalUsers: number
  dau: number
  mau: number
  loginSuccessRate: number | null
  activeOrgCount: number
}

export type PlatformAnnouncementScope = 'global' | 'tenant'
export type PlatformAnnouncementSeverity = 'info' | 'success' | 'warning' | 'critical'
export type PlatformAnnouncementStatus = 'draft' | 'published' | 'archived'

export type PlatformAnnouncement = {
  id: string
  scopeType: PlatformAnnouncementScope
  scopeValue: string | null
  title: string
  body: string
  severity: PlatformAnnouncementSeverity
  status: PlatformAnnouncementStatus
  startsAt: string
  endsAt: string | null
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

export type StatusIncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'
export type StatusIncidentImpact = 'none' | 'minor' | 'major' | 'critical'

export type StatusIncidentUpdate = {
  id: string
  incidentId: string
  status: StatusIncidentStatus
  message: string
  createdBy: string
  createdAt: string
}

export type StatusIncident = {
  id: string
  title: string
  status: StatusIncidentStatus
  impact: StatusIncidentImpact
  summary: string
  startedAt: string
  resolvedAt: string | null
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
  updates: StatusIncidentUpdate[]
}

export type ComplianceDocumentStatus = 'draft' | 'available' | 'retired'

export type ComplianceDocument = {
  id: string
  tenantId: string | null
  organizationName: string | null
  documentType: string
  title: string
  status: ComplianceDocumentStatus
  storageKey: string | null
  checksum: string | null
  version: string
  acceptedBy: string | null
  acceptedAt: string | null
  generatedBy: string | null
  createdAt: string
  updatedAt: string
  artifactUrl: string | null
}

export type InstanceManagerAssignment = {
  id: string
  tenantId: string
  userId: string
  email: string | null
  displayName: string | null
  userStatus: GlobalUserStatus | null
  organizationName: string | null
  managerRole: 'instance_manager'
  scopeType: 'instance'
  scopeId: null
  createdAt: string
  updatedAt: string
}
