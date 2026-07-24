// SAML JIT Provisioning(04 章第 3 节):首次 SSO 登录建 User,每次登录覆写属性,group->role 映射。
// 冲突处理:idp_id(SAML NameID)精确匹配 > email 关联 > 新建(见第 3 节)。JIT 可按 connection 开关。
// idp_id 存 user_identities(identityType=saml,provider=connection_id,providerUserId=NameID,租户唯一)。
// 铁律:所有 D1 查询走 @xid-kit/db 租户查询层(自动注入 tenant_id);membership 走 org 级隔离视图。

import { createTenantDb, schema } from '@xid-kit/db'
import type { SamlAttributes, SamlSubject } from '@xid-kit/types'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { SamlConnection } from './saml-connection'
import type { XidHonoEnv } from '../lib/types'
import { enforceEnterpriseSsoPolicy } from './enterprise-policy'

type Db = ReturnType<typeof createTenantDb>

export type JitInput = {
  c: Context<XidHonoEnv>
  connection: SamlConnection
  subject: SamlSubject
  attributes: SamlAttributes
  skipDefaultMembership?: boolean
}

// group displayName -> org role 映射(connection.roleMapping 是 { "<group>": "<role>" })。命中首个 group。
function mapRole(roleMapping: Record<string, unknown>, groups: readonly string[]): string | null {
  for (const g of groups) {
    const role = roleMapping[g]
    if (typeof role === 'string') return role
  }
  return null
}

// idp_id 精确匹配:user_identities(saml,provider=connection_id,providerUserId=NameID)。
async function matchByIdpId(db: Db, connectionId: string, nameId: string): Promise<string | null> {
  const row = await db.userIdentities.findOne(
    and(
      eq(schema.userIdentities.provider, connectionId),
      eq(schema.userIdentities.providerUserId, nameId),
      isNull(schema.userIdentities.revokedAt),
    ),
  )
  return row?.userId ?? null
}

// email 关联(已验证 email 命中现有 user;主键仍以 idp_id 绑定,见第 3 节冲突处理)。
// 安全约束(防跨 org 账户接管):email 必须已验证(verified=true),且命中 user 必须已是
// connection.orgId 的成员;无验证或不在本 org 的命中一律视为未匹配,走新建分支。
async function matchByEmail(
  db: Db,
  orgId: string,
  email: string | undefined,
): Promise<string | null> {
  if (!email) return null
  const row = await db.userEmails.findOne(
    and(eq(schema.userEmails.email, email), eq(schema.userEmails.verified, true)),
  )
  const userId = row?.userId
  if (!userId) return null
  const membership = await db
    .forOrg(orgId)
    .memberships.findOne(eq(schema.memberships.userId, userId))
  return membership ? userId : null
}

// 新建 user + 主邮箱 + idp_id 绑定(provisioned_by=jit_sso,见第 3 节)。
async function createUser(input: JitInput, db: Db): Promise<string> {
  const { c, attributes } = input
  const tenantId = c.get('tenant').tenantId
  const userId = crypto.randomUUID()
  await db.users.insert({
    id: userId,
    tenantId,
    firstName: attributes.firstName ?? null,
    lastName: attributes.lastName ?? null,
    status: 'active',
    provisionedBy: 'jit_sso',
  })
  if (attributes.email) {
    const emailId = crypto.randomUUID()
    await db.userEmails.insert({
      id: emailId,
      tenantId,
      userId,
      email: attributes.email,
      verified: true,
      verificationStatus: 'verified',
      isPrimary: true,
      verifiedAt: new Date(),
    })
    await db.users.update({ primaryEmailId: emailId }, eq(schema.users.id, userId))
  }
  return userId
}

// idp_id 绑定 upsert(首次创建,后续覆写 lastUsedAt + profileRaw)。
async function upsertIdentity(input: JitInput, db: Db, userId: string): Promise<void> {
  const { c, connection, subject, attributes } = input
  const tenantId = c.get('tenant').tenantId
  const existing = await db.userIdentities.findOne(
    and(
      eq(schema.userIdentities.provider, connection.id),
      eq(schema.userIdentities.providerUserId, subject.nameId),
      isNull(schema.userIdentities.revokedAt),
    ),
  )
  const profileRaw = { nameId: subject.nameId, ...attributes.custom }
  if (existing) {
    await db.userIdentities.update(
      { lastUsedAt: new Date(), profileRaw },
      eq(schema.userIdentities.id, existing.id),
    )
    return
  }
  await db.userIdentities.insert({
    id: crypto.randomUUID(),
    tenantId,
    userId,
    identityType: 'saml',
    provider: connection.id,
    providerUserId: subject.nameId,
    profileRaw,
    lastUsedAt: new Date(),
  })
}

// 每次登录覆写 first_name/last_name(属性同步,见第 3 节)。
async function syncProfile(input: JitInput, db: Db, userId: string): Promise<void> {
  const { attributes } = input
  await db.users.update(
    { firstName: attributes.firstName ?? null, lastName: attributes.lastName ?? null },
    eq(schema.users.id, userId),
  )
}

// 确保 org membership 存在并按 group->role 映射写入 role(connection.roleMapping)。
async function ensureMembership(input: JitInput, db: Db, userId: string): Promise<void> {
  const { c, connection, attributes } = input
  const tenantId = c.get('tenant').tenantId
  const role = mapRole(connection.roleMapping, attributes.groups ?? []) ?? 'member'
  const orgDb = db.forOrg(connection.orgId)
  const existing = await orgDb.memberships.findOne(eq(schema.memberships.userId, userId))
  if (existing) {
    await orgDb.memberships.update({ role }, eq(schema.memberships.userId, userId))
    return
  }
  await orgDb.memberships.insert({
    id: crypto.randomUUID(),
    tenantId,
    orgId: connection.orgId,
    userId,
    role,
    status: 'active',
    isManaged: true,
    joinedAt: new Date(),
  })
}

// JIT 主流程:匹配/新建 user -> 覆写属性 -> 绑定 idp_id -> 确保 membership。返回登录 userId。
// connection.jitEnabled=false 且无现有 user -> provisioning_disabled 403(见第 3 节、8.8)。
export async function provisionUser(input: JitInput): Promise<string> {
  const { c, connection, subject, attributes } = input
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)

  let userId = await matchByIdpId(db, connection.id, subject.nameId)
  if (!userId) userId = await matchByEmail(db, connection.orgId, attributes.email)

  let isNewUser = false
  if (!userId) {
    if (!connection.jitEnabled) {
      throw new AppError('provisioning_disabled', { httpStatus: 403 })
    }
    await enforceEnterpriseSsoPolicy({
      c,
      action: 'user_creation',
      email: attributes.email ?? null,
    })
    userId = await createUser(input, db)
    isNewUser = true
  } else {
    await enforceEnterpriseSsoPolicy({ c, action: 'login', email: attributes.email ?? null })
    await syncProfile(input, db, userId)
  }

  await upsertIdentity(input, db, userId)
  if (!(input.skipDefaultMembership && isNewUser)) {
    await ensureMembership(input, db, userId)
  }
  return userId
}
