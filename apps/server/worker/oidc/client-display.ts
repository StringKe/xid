// Hosted Auth 各页面展示 client 的统一来源:consent、设备激活、CIBA 审批与 /auth/config 上下文栏。
// applications 没有名称与 logo 列:展示名取所属 Project 名,logo 与归属组织取 Project 的组织,缺失回退。

import { createTenantDb, schema } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import type { ClientRow } from './shared'

export type ClientDisplay = {
  clientName: string
  clientLogoUrl: string | null
  ownerOrganizationName: string | null
}

export async function resolveClientDisplay(
  d1: D1Database,
  tenant: TenantContext,
  client: Pick<ClientRow, 'clientId' | 'projectId'>,
): Promise<ClientDisplay> {
  const fallback: ClientDisplay = {
    clientName: client.clientId,
    clientLogoUrl: null,
    ownerOrganizationName: null,
  }
  if (!client.projectId) return fallback
  const db = createTenantDb(d1, tenant)
  const project = await db.projects.findOne(
    and(eq(schema.projects.id, client.projectId), eq(schema.projects.status, 'active')),
  )
  if (!project) return fallback
  const org = await db.organizations.findOne(eq(schema.organizations.id, project.orgId))
  return {
    clientName: project.name,
    clientLogoUrl: org?.logoUrl ?? null,
    ownerOrganizationName: org?.name ?? null,
  }
}
