// jit.ts:JIT Provisioning -- 首次 SSO 登录自动建 User,后续同步属性/角色。
// 冲突处理顺序:idp_id 精确匹配 > email 关联 > 新建(见 04 章 3)。
// JIT 可按 connection 开关(jit_enabled);关闭时若 idp_id 无对应 User -> 403 provisioning_disabled。
// 铁律:
//   - 所有 D1 查询走租户查询层(自动注入 tenant_id)。
//   - tenant_id 从 TenantContext 取,不信任 body。
//   - 主键用 idp_id 不靠 email 匹配(防 email 变更孤立账户)。
//   - 新建用户打 provisionedBy='jit_sso' 标记(见 04 章 3)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import type { Context } from 'hono'
import { enforceEnterpriseSsoPolicy } from './enterprise-policy'

// SSO 认证成功后的标准化断言(SAML NameID 或 OIDC sub + 属性映射结果)。
export type SsoAssertion = {
  // 主键:idp_id = SAML NameID / OIDC sub(见 04 章 1 设计决策)
  idpId: string
  connectionId: string
  orgId: string
  email: string | null
  emailVerified: boolean
  firstName: string | null
  lastName: string | null
  // IdP groups/attributes,用于角色映射
  groups: string[]
  customAttributes: Record<string, unknown>
}

// JIT 结果:返回 userId + 是否新建。
export type JitResult = {
  userId: string
  provisioned: boolean
}

// 从 connection.roleMapping 按 groups 解析 org_role。
// roleMapping 格式:{ "Engineering": "admin", "Developers": "member" }
// 取第一个命中的 group 对应的 role,未命中回退 'member'。
function resolveOrgRole(groups: string[], roleMapping: Record<string, unknown>): string {
  for (const group of groups) {
    const role = roleMapping[group]
    if (typeof role === 'string' && role.length > 0) return role
  }
  return 'member'
}

// 属性同步:每次 SSO 登录用最新 assertion 覆写 first_name/last_name/custom_attributes。
async function syncAttributes(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
  assertion: SsoAssertion,
): Promise<void> {
  const updates: Partial<typeof schema.users.$inferInsert> = {
    lastLoginAt: new Date(),
  }
  if (assertion.firstName !== null) updates.firstName = assertion.firstName
  if (assertion.lastName !== null) updates.lastName = assertion.lastName
  if (Object.keys(assertion.customAttributes).length > 0) {
    updates.customAttributes = assertion.customAttributes
  }
  await db.users.update(updates, eq(schema.users.id, userId))
}

// 确保 user_identities 中有对应 identity 行(idp_id + connectionId)。
async function upsertSsoIdentity(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
  tenantId: string,
  assertion: SsoAssertion,
): Promise<void> {
  const existing = await db.userIdentities.findOne(
    and(
      eq(schema.userIdentities.provider, assertion.connectionId),
      eq(schema.userIdentities.providerUserId, assertion.idpId),
      isNull(schema.userIdentities.revokedAt),
    ),
  )
  if (existing) {
    await db.userIdentities.update(
      { lastUsedAt: new Date() },
      eq(schema.userIdentities.id, existing.id),
    )
    return
  }
  await db.userIdentities.insert({
    id: crypto.randomUUID(),
    tenantId,
    userId,
    identityType: 'sso',
    provider: assertion.connectionId,
    providerUserId: assertion.idpId,
    lastUsedAt: new Date(),
  })
}

// 若有 email 则插入并更新 primaryEmailId(抽出减少 provisionNewUser 行数)。
async function insertEmailIfPresent(
  db: ReturnType<typeof createTenantDb>,
  tenantId: string,
  userId: string,
  assertion: SsoAssertion,
): Promise<void> {
  if (!assertion.email) return
  const emailId = crypto.randomUUID()
  await db.userEmails.insert({
    id: emailId,
    tenantId,
    userId,
    email: assertion.email,
    verified: assertion.emailVerified,
    verificationStatus: assertion.emailVerified ? 'verified' : 'unverified',
    isPrimary: true,
    ...(assertion.emailVerified ? { verifiedAt: new Date() } : {}),
  })
  await db.users.update({ primaryEmailId: emailId }, eq(schema.users.id, userId))
}

// upsertMembership 参数包(绕过 max-params=4 限制,将 5 个参数聚合为对象)。
type MembershipParams = {
  db: ReturnType<typeof createTenantDb>
  tenantId: string
  userId: string
  orgId: string
  role: string
}

// 确保 membership 存在并同步 role。
async function upsertMembership(p: MembershipParams): Promise<void> {
  const { db, tenantId, userId, orgId, role } = p
  const orgDb = db.forOrg(orgId)
  const existing = await orgDb.memberships.findOne(eq(schema.memberships.userId, userId))
  if (existing) {
    if (existing.role !== role) {
      await orgDb.memberships.update({ role }, eq(schema.memberships.id, existing.id))
    }
    return
  }
  await orgDb.memberships.insert({
    id: crypto.randomUUID(),
    tenantId,
    orgId,
    userId,
    role,
    membershipType: 'member',
    status: 'active',
    isManaged: true,
    joinedAt: new Date(),
  })
}

// 已存在用户同步参数包(绕过 max-params=4)。orgId 取自 connection(权威),非 assertion。
type SyncParams = {
  db: ReturnType<typeof createTenantDb>
  tenantId: string
  orgId: string
  userId: string
  assertion: SsoAssertion
  orgRole: string
}

// 已存在用户的属性同步 + identity + membership(分支 A/B 共用)。
async function syncExistingUser(p: SyncParams): Promise<JitResult> {
  const { db, tenantId, orgId, userId, assertion, orgRole } = p
  await syncAttributes(db, userId, assertion)
  await upsertSsoIdentity(db, userId, tenantId, assertion)
  await upsertMembership({ db, tenantId, userId, orgId, role: orgRole })
  return { userId, provisioned: false }
}

// 新建用户参数包(绕过 max-params=4)。orgId 取自 connection(权威),非 assertion。
type ProvisionParams = {
  c: Context<XidHonoEnv>
  db: ReturnType<typeof createTenantDb>
  tenantId: string
  orgId: string
  assertion: SsoAssertion
  orgRole: string
  skipDefaultMembership?: boolean
}

// 分支 D:新建用户 + 邮箱 + identity + membership。
async function provisionNewUser(p: ProvisionParams): Promise<JitResult> {
  const { c, db, tenantId, orgId, assertion, orgRole, skipDefaultMembership = false } = p
  const userId = crypto.randomUUID()
  await db.users.insert({
    id: userId,
    tenantId,
    firstName: assertion.firstName,
    lastName: assertion.lastName,
    displayName: [assertion.firstName, assertion.lastName].filter(Boolean).join(' ') || null,
    status: 'active',
    provisionedBy: 'jit_sso',
  })
  await insertEmailIfPresent(db, tenantId, userId, assertion)
  await upsertSsoIdentity(db, userId, tenantId, assertion)
  if (!skipDefaultMembership) {
    await upsertMembership({ db, tenantId, userId, orgId, role: orgRole })
  }
  await c.env.AUDIT_QUEUE.send({
    tenantId,
    orgId,
    action: 'user.created',
    actorId: userId,
    ts: Date.now(),
    payload: {
      provisionedBy: 'jit_sso',
      connectionId: assertion.connectionId,
      idpId: assertion.idpId,
    },
  })
  return { userId, provisioned: true }
}

// JIT Provisioning 主入口。
export async function jitProvision(
  c: Context<XidHonoEnv>,
  assertion: SsoAssertion,
  options?: { skipDefaultMembership?: boolean },
): Promise<JitResult> {
  const tenant = c.get('tenant')
  const { tenantId } = tenant
  const db = createTenantDb(c.env.DB, tenant)

  const connection = await db.ssoConnections.findOne(
    eq(schema.ssoConnections.id, assertion.connectionId),
  )
  if (!connection) throw new AppError('connection_not_found')

  // connection.orgId 是权威来源:assertion.orgId 由 RP 控制不可信,与 connection 不一致即拒绝
  // (防跨 org 越权写 membership/audit,见 02 章 6 数据隔离)。
  if (assertion.orgId !== connection.orgId) {
    throw new AppError('invalid_credentials', {
      longMessage: 'assertion orgId does not match connection orgId',
    })
  }
  const orgId = connection.orgId

  const orgRole = resolveOrgRole(
    assertion.groups,
    connection.roleMapping as Record<string, unknown>,
  )

  // 分支 A:idp_id 精确匹配。
  const existingIdentity = await db.userIdentities.findOne(
    and(
      eq(schema.userIdentities.provider, assertion.connectionId),
      eq(schema.userIdentities.providerUserId, assertion.idpId),
      isNull(schema.userIdentities.revokedAt),
    ),
  )
  if (existingIdentity) {
    await enforceEnterpriseSsoPolicy({ c, action: 'login', email: assertion.email })
    return syncExistingUser({
      db,
      tenantId,
      orgId,
      userId: existingIdentity.userId,
      assertion,
      orgRole,
    })
  }

  // 分支 B:email 关联(已验证)。
  if (assertion.email) {
    const emailRow = await db.userEmails.findOne(eq(schema.userEmails.email, assertion.email))
    if (emailRow && assertion.emailVerified) {
      await enforceEnterpriseSsoPolicy({ c, action: 'login', email: assertion.email })
      return syncExistingUser({ db, tenantId, orgId, userId: emailRow.userId, assertion, orgRole })
    }
    if (emailRow) {
      throw new AppError('invalid_credentials')
    }
  }

  // 分支 C:JIT 关闭。
  if (!connection.jitEnabled) throw new AppError('provisioning_disabled')

  // 分支 D:新建。
  await enforceEnterpriseSsoPolicy({ c, action: 'user_creation', email: assertion.email })
  return provisionNewUser({
    c,
    db,
    tenantId,
    orgId,
    assertion,
    orgRole,
    skipDefaultMembership: options?.skipDefaultMembership ?? false,
  })
}
