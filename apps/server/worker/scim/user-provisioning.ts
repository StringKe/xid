// 入站 SCIM User 与 XID User 的绑定(04 章 6):directory_users.user_id 指向 XID User,
// 并在 directory 所属 org 维护 is_managed membership。邮箱关联规则与 SSO JIT 共用 account-link.ts。

import { schema } from '@xid-kit/db'
import type { createTenantDb } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import { createPersistedId } from '../lib/persisted-id'
import { findLinkableUserByEmail, normalizeLinkEmail } from '../sso/account-link'

type TenantDb = ReturnType<typeof createTenantDb>

export type DirectoryLinkScope = {
  db: TenantDb
  tenantId: string
  orgId: string
}

export type ScimUserProfile = {
  email: string | null
  username: string
  firstName: string | null
  lastName: string | null
}

export type DirectoryUserLinkPlan =
  | { kind: 'existing'; userId: string }
  | { kind: 'create' }
  | { kind: 'conflict' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function primaryEmailValue(raw: Record<string, unknown>): string | null {
  const emails = raw['emails']
  if (!Array.isArray(emails)) return null
  const records = emails.filter(isRecord)
  const primary = records.find((email) => email['primary'] === true) ?? records[0]
  return stringOrNull(primary?.['value'])
}

export function scimUserProfile(raw: Record<string, unknown>, userName: string): ScimUserProfile {
  const name = isRecord(raw['name']) ? raw['name'] : {}
  return {
    email: normalizeLinkEmail(primaryEmailValue(raw) ?? userName),
    username: userName,
    firstName: stringOrNull(name['givenName']),
    lastName: stringOrNull(name['familyName']),
  }
}

// 只读判定,不产生写入:冲突时调用方在落库前返回 409 uniqueness。
export async function planDirectoryUserLink(
  scope: DirectoryLinkScope,
  profile: ScimUserProfile,
): Promise<DirectoryUserLinkPlan> {
  const link = await findLinkableUserByEmail(scope.db, {
    orgId: scope.orgId,
    email: profile.email,
    emailVerified: true,
  })
  if (link.kind === 'conflict') return { kind: 'conflict' }
  if (link.kind === 'linkable') return { kind: 'existing', userId: link.userId }
  if (profile.email) return { kind: 'create' }
  const usernameTaken = await scope.db.users.findOne(eq(schema.users.username, profile.username))
  return usernameTaken ? { kind: 'conflict' } : { kind: 'create' }
}

async function createScimUser(
  scope: DirectoryLinkScope,
  profile: ScimUserProfile,
): Promise<string> {
  const userId = createPersistedId('user')
  await scope.db.users.insert({
    id: userId,
    tenantId: scope.tenantId,
    username: profile.email ? null : profile.username,
    firstName: profile.firstName,
    lastName: profile.lastName,
    displayName: [profile.firstName, profile.lastName].filter(Boolean).join(' ') || null,
    status: 'active',
    provisionedBy: 'scim',
  })
  if (profile.email) {
    const emailId = crypto.randomUUID()
    await scope.db.userEmails.insert({
      id: emailId,
      tenantId: scope.tenantId,
      userId,
      email: profile.email,
      verified: true,
      verificationStatus: 'verified',
      isPrimary: true,
      verifiedAt: new Date(),
    })
    await scope.db.users.update({ primaryEmailId: emailId }, eq(schema.users.id, userId))
  }
  return userId
}

export async function syncScimUserProfile(
  scope: DirectoryLinkScope,
  userId: string,
  profile: ScimUserProfile,
): Promise<void> {
  const updates: Partial<typeof schema.users.$inferInsert> = {}
  if (profile.firstName !== null) updates.firstName = profile.firstName
  if (profile.lastName !== null) updates.lastName = profile.lastName
  if (Object.keys(updates).length === 0) return
  await scope.db.users.update(updates, eq(schema.users.id, userId))
}

// 只恢复本目录托管且被停用的 membership;管理员手工维护的 membership 不被目录改写。
export async function ensureDirectoryMembership(
  scope: DirectoryLinkScope,
  userId: string,
): Promise<void> {
  const orgDb = scope.db.forOrg(scope.orgId)
  const existing = await orgDb.memberships.findOne(eq(schema.memberships.userId, userId))
  if (!existing) {
    await orgDb.memberships.insert({
      id: createPersistedId('membership'),
      tenantId: scope.tenantId,
      orgId: scope.orgId,
      userId,
      role: 'member',
      membershipType: 'member',
      status: 'active',
      isManaged: true,
      joinedAt: new Date(),
    })
    return
  }
  if (existing.isManaged && existing.status === 'inactive') {
    await orgDb.memberships.update(
      { status: 'active' },
      and(eq(schema.memberships.id, existing.id), eq(schema.memberships.status, 'inactive')),
    )
  }
}

export async function suspendDirectoryMembership(
  scope: DirectoryLinkScope,
  userId: string,
): Promise<void> {
  await scope.db
    .forOrg(scope.orgId)
    .memberships.update(
      { status: 'inactive' },
      and(
        eq(schema.memberships.userId, userId),
        eq(schema.memberships.isManaged, true),
        eq(schema.memberships.status, 'active'),
      ),
    )
}

export type ApplyDirectoryUserLinkInput = {
  plan: Exclude<DirectoryUserLinkPlan, { kind: 'conflict' }>
  profile: ScimUserProfile
  directoryUserId: string
}

export async function applyDirectoryUserLink(
  scope: DirectoryLinkScope,
  input: ApplyDirectoryUserLinkInput,
): Promise<{ userId: string; created: boolean }> {
  const created = input.plan.kind === 'create'
  const userId =
    input.plan.kind === 'existing' ? input.plan.userId : await createScimUser(scope, input.profile)
  if (!created) await syncScimUserProfile(scope, userId, input.profile)
  await ensureDirectoryMembership(scope, userId)
  await scope.db.directoryUsers.update(
    { userId },
    eq(schema.directoryUsers.id, input.directoryUserId),
  )
  return { userId, created }
}
