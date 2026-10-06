import { schema } from '@xid-kit/db'
import type { createTenantDb } from '@xid-kit/db'
import type { OrganizationMembershipRole } from '@xid-kit/types'
import { and, eq, isNull } from 'drizzle-orm'

type TenantDb = ReturnType<typeof createTenantDb>

export type OrganizationAccessGrant = {
  isMember: boolean
  membershipRole: OrganizationMembershipRole | null
  isOrgManager: boolean
}

export type OrganizationAccess = OrganizationAccessGrant & {
  organization: typeof schema.organizations.$inferSelect
}

// 「能否在该 org 内活动」的唯一判定:active Membership,或 scope 为该 org 的 org_manager 指派。
// owner/admin 已具备管理权,跳过指派查询。
export async function findOrganizationAccessGrant(
  db: TenantDb,
  input: { userId: string; orgId: string },
): Promise<OrganizationAccessGrant | null> {
  const membership = await db.memberships.findOne(
    and(
      eq(schema.memberships.userId, input.userId),
      eq(schema.memberships.orgId, input.orgId),
      eq(schema.memberships.status, 'active'),
    ),
  )
  const isMember = Boolean(membership)
  const membershipRole = membership?.role ?? null
  if (membershipRole === 'owner' || membershipRole === 'admin') {
    return { isMember, membershipRole, isOrgManager: false }
  }
  const assignment = await db.managerAssignments.findOne(
    and(
      eq(schema.managerAssignments.userId, input.userId),
      eq(schema.managerAssignments.managerRole, 'org_manager'),
      eq(schema.managerAssignments.scopeType, 'org'),
      eq(schema.managerAssignments.scopeId, input.orgId),
    ),
  )
  if (!isMember && !assignment) return null
  return { isMember, membershipRole, isOrgManager: Boolean(assignment) }
}

export async function resolveOrganizationAccess(
  db: TenantDb,
  input: { userId: string; orgId: string },
): Promise<OrganizationAccess | null> {
  const organization = await db.organizations.findOne(
    and(
      eq(schema.organizations.id, input.orgId),
      eq(schema.organizations.status, 'active'),
      isNull(schema.organizations.deletedAt),
    ),
  )
  if (!organization) return null
  const grant = await findOrganizationAccessGrant(db, input)
  return grant ? { ...grant, organization } : null
}
