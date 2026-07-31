// platform console 模块共享类型。cookie session + instance_manager 才能访问。

export type PlatformOrganization = {
  id: string
  slug: string
  name: string
  plan: 'free' | 'starter' | 'pro' | 'enterprise'
  status: 'active' | 'suspended' | 'deleted'
  userCount: number
  orgCount: number
  createdAt: string
}

export type GlobalUserOrganization = {
  id: string
  slug: string
  name: string
}

export type GlobalUser = {
  id: string
  email: string
  name: string | null
  organizations: GlobalUserOrganization[]
  status: 'active' | 'inactive' | 'banned'
  createdAt: string
}

export type AuditEvent = {
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

export type AuditChainVerification = {
  tenant_id: string
  verified_range: { from: number; to: number }
  chain_valid: boolean
  broken_at_seq: number | null
  failure_reason: 'audit_chain_broken' | 'audit_seq_gap' | 'audit_genesis_missing' | null
  record_count: number
  computed_at: string
}

export type QueueDeadLetter = {
  id: string
  sourceQueue: string
  deadLetterQueue: string
  messageId: string
  tenantId: string | null
  orgId: string | null
  eventType: string
  errorCode: string
  status: 'pending' | 'replaying' | 'replayed'
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
  status: QueueDeadLetter['status']
  replayed: boolean
  idempotent: boolean
}

export type FeatureFlag = {
  key: string
  label: string
  description: string | null
  globalDefault: boolean
  organizationOverrides: number
}

export type BillingOverview = {
  organizationId: string
  organizationName: string
  plan: string
  mau: number
  dau: number
  seatUsed: number
  seatLimit: number | null
  status: 'ok' | 'overdue' | 'exceeded'
}

export type OrganizationPlanName = PlatformOrganization['plan']
export type OrganizationPlanStatus = 'active' | 'trialing' | 'past_due' | 'canceled'
export type OrganizationQuotaKey =
  | 'seats'
  | 'organizations'
  | 'sso_connections'
  | 'api_calls'
  | 'emails'
  | 'mau'

export type OrganizationQuota = {
  key: OrganizationQuotaKey
  limit: number | null
  enforcement: 'observe' | 'block_creation'
}

export type OrganizationPlanDetail = {
  tenantId: string
  plan: OrganizationPlanName
  status: OrganizationPlanStatus
  source: string
  supportLabel: string
  trialEndsAt: string | null
  effectiveAt: string
  seatLimit: number | null
  quotas: OrganizationQuota[]
}

export type OrganizationPlanPatch = Partial<
  Pick<OrganizationPlanDetail, 'plan' | 'status' | 'trialEndsAt' | 'seatLimit' | 'quotas'>
>

export type StripeBillingConfig = {
  enabled: boolean
  checkout: Record<'starter' | 'pro' | 'enterprise', boolean>
  portal: boolean
  metering: boolean
}

export type StripeHostedSession = {
  id: string
  url: string
  expiresAt: number | null
}

export type PlatformSettings = {
  id: string
  name: string
  primaryDomain: string
  mode: string
  defaultLocale: string
  dataResidency: string
  mfaPolicy: 'required' | 'optional' | 'disabled'
  passwordPolicy: Record<string, unknown>
  sessionPolicy: Record<string, unknown>
  status: string
}

export type PlatformAnnouncement = {
  id: string
  scopeType: 'global' | 'tenant' | 'plan'
  scopeValue: string | null
  title: string
  body: string
  severity: 'info' | 'success' | 'warning' | 'critical'
  status: 'draft' | 'published' | 'archived'
  startsAt: string
  endsAt: string | null
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

export type StatusIncidentUpdate = {
  id: string
  incidentId: string
  status: StatusIncident['status']
  message: string
  createdBy: string
  createdAt: string
}

export type StatusIncident = {
  id: string
  title: string
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved'
  impact: 'none' | 'minor' | 'major' | 'critical'
  summary: string
  startedAt: string
  resolvedAt: string | null
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
  updates: StatusIncidentUpdate[]
}

export type ComplianceDocument = {
  id: string
  tenantId: string | null
  documentType: string
  title: string
  status: 'draft' | 'available' | 'retired'
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
  managerRole: 'instance_manager'
  scopeType: 'instance'
  scopeId: null
  createdAt: string
  updatedAt: string
}

// cursor 分页通用容器。
export type Page<T> = {
  data: T[]
  nextCursor: string | null
  total: number
}
