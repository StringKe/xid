// platform console 模块共享类型。cookie session + instance_manager 才能访问。

export type PlatformOrganization = {
  id: string
  slug: string
  name: string
  plan: 'free' | 'pro' | 'enterprise'
  status: 'active' | 'suspended' | 'deleted'
  userCount: number
  orgCount: number
  createdAt: string
}

export type GlobalUser = {
  id: string
  email: string
  name: string | null
  organizationId: string
  organizationName: string
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
  actorIp: string | null
  targetType: string | null
  targetId: string | null
  occurredAt: string
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

// cursor 分页通用容器。
export type Page<T> = {
  data: T[]
  nextCursor: string | null
  total: number
}
