// Hosted Auth 上下文栏数据:当前登录进入哪个组织、继续到哪个应用。
// 实例根入口尚未确定组织,不返回任何组织名;client 只在已解析租户内按 active 解析,否则为 null。

import { createTenantDb, schema } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import { isInstanceEntryContext } from '../me-auth/instance-login'
import { resolveClientDisplay } from '../oidc/client-display'
import { findTenantClient } from '../oidc/shared'

export type HostedAuthContext = {
  organizationName: string | null
  applicationName: string | null
  applicationLogoUrl: string | null
}

async function organizationNameOf(d1: D1Database, tenant: TenantContext): Promise<string | null> {
  if (isInstanceEntryContext(tenant)) return null
  const db = createTenantDb(d1, tenant)
  const org = await db.organizations.findOne(eq(schema.organizations.id, tenant.tenantId))
  return org?.name ?? null
}

async function applicationOf(
  d1: D1Database,
  tenant: TenantContext,
  clientId: string | null,
): Promise<Pick<HostedAuthContext, 'applicationName' | 'applicationLogoUrl'>> {
  const client = clientId ? await findTenantClient(d1, tenant, clientId) : null
  if (!client) return { applicationName: null, applicationLogoUrl: null }
  const display = await resolveClientDisplay(d1, tenant, client)
  return { applicationName: display.clientName, applicationLogoUrl: display.clientLogoUrl }
}

export async function resolveHostedAuthContext(
  d1: D1Database,
  tenant: TenantContext,
  clientId: string | null,
): Promise<HostedAuthContext> {
  const [organizationName, application] = await Promise.all([
    organizationNameOf(d1, tenant),
    applicationOf(d1, tenant, clientId),
  ])
  return { organizationName, ...application }
}
