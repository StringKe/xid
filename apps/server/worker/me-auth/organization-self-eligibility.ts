// 自助创建组织的唯一资格判定:POST /v1/organizations/self 前置检查与 /v1/me 的 canCreateOrganization 共用,
// 避免入口显示与提交结果不一致。最终原子性仍由迁移 batch 的条件 UPDATE 保证。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { TenantVar } from '../lib/types'

const DEFAULT_TENANT_SLUG = 'default'

type SourceTenantRow = {
  instanceMode: string
  slug: string
  parentOrgId: string | null
  orgTenantId: string
}

async function loadSourceTenant(
  env: Env,
  tenantId: string,
  instanceId: string,
): Promise<SourceTenantRow | null> {
  return env.DB.prepare(
    `SELECT i.mode AS instanceMode,
            o.slug AS slug,
            o.parent_org_id AS parentOrgId,
            o.tenant_id AS orgTenantId
       FROM organizations o
       JOIN instances i ON i.id = o.instance_id
      WHERE o.id = ?
        AND o.tenant_id = ?
        AND o.instance_id = ?
        AND o.status = 'active'
        AND o.deleted_at IS NULL
      LIMIT 1`,
  )
    .bind(tenantId, tenantId, instanceId)
    .first<SourceTenantRow>()
}

export type SelfOrganizationCreateUser = typeof schema.users.$inferSelect

// 多租户实例的默认 staging Tenant 中,尚未加入任何组织的新用户才可自助建组织。
export async function findSelfOrganizationCreateUser(
  env: Env,
  input: { tenant: TenantVar; userId: string },
): Promise<SelfOrganizationCreateUser | null> {
  const { tenant, userId } = input
  if (!tenant.instanceId) return null
  const source = await loadSourceTenant(env, tenant.tenantId, tenant.instanceId)
  if (
    !source ||
    source.instanceMode !== 'multi_tenant' ||
    source.slug !== DEFAULT_TENANT_SLUG ||
    source.parentOrgId !== null ||
    source.orgTenantId !== tenant.tenantId
  ) {
    return null
  }
  const db = createTenantDb(env.DB, tenant)
  const [user, membership] = await Promise.all([
    db.users.findOne(
      and(
        eq(schema.users.id, userId),
        eq(schema.users.status, 'active'),
        eq(schema.users.isNewUser, true),
        isNull(schema.users.deletedAt),
      ),
    ),
    db.memberships.findOne(eq(schema.memberships.userId, userId)),
  ])
  return user && !membership ? user : null
}
