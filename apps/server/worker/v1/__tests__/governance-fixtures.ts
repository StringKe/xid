// Overview 与组织审计测试共用的种子数据:审计事件、SSO 连接、Webhook 投递、域名、邀请。

import type { TenantContext } from '@xid-kit/types'
import type { SqliteD1 } from '../../../../../packages/db/src/__tests__/sqlite-d1'
import { TENANT_A, tenantDb } from './console-fixtures'

export async function seedAudit(
  d1: SqliteD1,
  input: {
    seq: number
    eventType: string
    occurredAt: string
    orgId?: string | null
    actorId?: string
    actorIp?: string
    targetType?: string
    targetId?: string
    meta?: Record<string, unknown>
    tenant?: TenantContext
  },
): Promise<void> {
  const tenant = input.tenant ?? TENANT_A
  await tenantDb(d1, tenant).auditEvents.insert({
    seq: input.seq,
    id: `evt_${tenant.tenantId}_${input.seq}`,
    tenantId: tenant.tenantId,
    orgId: input.orgId === undefined ? tenant.tenantId : input.orgId,
    eventType: input.eventType,
    actorId: input.actorId ?? null,
    actorIp: input.actorIp ?? null,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    meta: input.meta ?? {},
    occurredAt: input.occurredAt,
    prevHash: `prev_${input.seq}`,
    hash: `hash_${input.seq}`,
  })
}

export async function seedSsoConnection(
  d1: SqliteD1,
  input: {
    id: string
    orgId: string
    certificates: string[]
    name?: string
    tenant?: TenantContext
  },
): Promise<void> {
  const tenant = input.tenant ?? TENANT_A
  await tenantDb(d1, tenant).ssoConnections.insert({
    id: input.id,
    tenantId: tenant.tenantId,
    orgId: input.orgId,
    protocol: 'saml',
    displayName: input.name ?? 'Okta',
    idpCertificates: input.certificates,
  })
}

export async function seedWebhookDelivery(
  d1: SqliteD1,
  input: {
    id: string
    webhookId: string
    status: 'pending' | 'delivered' | 'dead'
    attemptCount: number
    createdAt: Date
    tenant?: TenantContext
  },
): Promise<void> {
  const tenant = input.tenant ?? TENANT_A
  await tenantDb(d1, tenant).webhookDeliveries.insert({
    id: input.id,
    tenantId: tenant.tenantId,
    webhookId: input.webhookId,
    eventType: 'user.created',
    payload: {},
    status: input.status,
    attemptCount: input.attemptCount,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  })
}

export async function seedWebhook(
  d1: SqliteD1,
  input: { id: string; url: string; tenant?: TenantContext },
): Promise<void> {
  const tenant = input.tenant ?? TENANT_A
  await tenantDb(d1, tenant).webhooks.insert({
    id: input.id,
    tenantId: tenant.tenantId,
    url: input.url,
    signingSecretHash: 'hash',
  })
}

export async function seedDomain(
  d1: SqliteD1,
  input: {
    id: string
    orgId: string
    domain: string
    verified?: boolean
    tenant?: TenantContext
  },
): Promise<void> {
  const tenant = input.tenant ?? TENANT_A
  await tenantDb(d1, tenant).organizationDomains.insert({
    id: input.id,
    tenantId: tenant.tenantId,
    orgId: input.orgId,
    domain: input.domain,
    verificationToken: `token_${input.id}`,
    verificationStatus: input.verified ? 'verified' : 'pending',
    verifiedAt: input.verified ? new Date(1000) : null,
  })
}

export async function seedInvitation(
  d1: SqliteD1,
  input: {
    id: string
    orgId: string
    email: string
    status: 'pending' | 'expired' | 'accepted'
    expiresAt: Date
    tenant?: TenantContext
  },
): Promise<void> {
  const tenant = input.tenant ?? TENANT_A
  await tenantDb(d1, tenant).invitations.insert({
    id: input.id,
    tenantId: tenant.tenantId,
    orgId: input.orgId,
    email: input.email,
    tokenHash: `hash_${input.id}`,
    tokenVersion: 'locator_v1',
    status: input.status,
    expiresAt: input.expiresAt,
  })
}
