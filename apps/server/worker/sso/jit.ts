// jit.ts:SAML / OIDC / legacy 企业 SSO 共用的唯一 JIT Provisioning 实现(04 章 4)。
// 顺序:idp_id 精确匹配 > email 关联 > 新建。主键用 idp_id,不靠 email 匹配(防 email 变更孤立账户)。
// email 关联规则见 account-link.ts;命中 email 但不满足条件一律 invalid_credentials,
// 绝不进入新建分支(防跨 org 接管)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import { isOrganizationMembershipRole } from '@xid-kit/types'
import type { OrganizationMembershipRole } from '@xid-kit/types'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { bindUserIdentity } from '../lib/user-identity'
import { provisionAccountAtomically } from '../auth/account-provisioning'
import { findLinkableUserByEmail, isVerifiedOrgEmailDomain } from './account-link'
import { enforceEnterpriseSsoPolicy } from './enterprise-policy'

type Db = ReturnType<typeof createTenantDb>

// SSO 认证成功后的标准化断言(SAML NameID 或 OIDC sub + 属性映射结果)。
export type SsoAssertion = {
  // 主键:idp_id = SAML NameID / OIDC sub(见 04 章 1 设计决策)
  idpId: string
  // 连接改用稳定属性作 idpId 前,同一用户按 NameID 绑定;命中旧绑定时沿用该用户并补绑新 idpId。
  legacyIdpId?: string
  connectionId: string
  orgId: string
  email: string | null
  // IdP 明确声明 email 已验证(OIDC email_verified === true)。
  emailVerified: boolean
  firstName: string | null
  lastName: string | null
  // IdP groups/attributes,用于角色映射
  groups: string[]
  customAttributes: Record<string, unknown>
  identityType?: 'sso' | 'saml'
  profileRaw?: Record<string, unknown>
}

export type JitResult = {
  userId: string
  provisioned: boolean
}

type SsoConnection = typeof schema.ssoConnections.$inferSelect

type JitContext = {
  c: Context<XidHonoEnv>
  db: Db
  tenantId: string
  orgId: string
  assertion: SsoAssertion
  // roleMapping 命中的角色;null 表示未命中,已有成员保留原角色,新成员用 DEFAULT_ORG_ROLE。
  mappedRole: OrganizationMembershipRole | null
}

const DEFAULT_ORG_ROLE: OrganizationMembershipRole = 'member'

const ROLE_RANK: Record<OrganizationMembershipRole, number> = { member: 0, admin: 1, owner: 2 }

// roleMapping 格式:{ "Engineering": "admin" };取第一个命中的 group。
export function resolveMappedOrgRole(
  groups: readonly string[],
  roleMapping: Record<string, unknown>,
): OrganizationMembershipRole | null {
  for (const group of groups) {
    const role = roleMapping[group]
    if (isOrganizationMembershipRole(role)) return role
  }
  return null
}

// IdP 的 group 变化只能提升已有成员角色:owner/admin 是 org 管理入口,被一次 SSO 降级会让 org 失去管理者。
export function nextMembershipRole(
  current: OrganizationMembershipRole,
  mapped: OrganizationMembershipRole | null,
): OrganizationMembershipRole {
  if (mapped === null) return current
  return ROLE_RANK[mapped] > ROLE_RANK[current] ? mapped : current
}

// IdP 断言的 email 可信:IdP 显式声明已验证,或 email 域是本 org 已验证且有效的域名
// (与 HRD 同一信号,04 章 5)。默认不信任。
async function isIdpEmailTrusted(ctx: JitContext, email: string): Promise<boolean> {
  if (ctx.assertion.emailVerified) return true
  return isVerifiedOrgEmailDomain(ctx.db, ctx.orgId, email)
}

// 每次登录用最新断言覆写非空属性;null 不清空已有值。
async function syncAttributes(ctx: JitContext, userId: string): Promise<void> {
  const { assertion } = ctx
  const updates: Partial<typeof schema.users.$inferInsert> = { lastLoginAt: new Date() }
  if (assertion.firstName !== null) updates.firstName = assertion.firstName
  if (assertion.lastName !== null) updates.lastName = assertion.lastName
  if (Object.keys(assertion.customAttributes).length > 0) {
    updates.customAttributes = assertion.customAttributes
  }
  await ctx.db.users.update(updates, eq(schema.users.id, userId))
}

async function upsertMembership(ctx: JitContext, userId: string): Promise<void> {
  const orgDb = ctx.db.forOrg(ctx.orgId)
  const existing = await orgDb.memberships.findOne(eq(schema.memberships.userId, userId))
  if (existing) {
    if (!isOrganizationMembershipRole(existing.role)) return
    const next = nextMembershipRole(existing.role, ctx.mappedRole)
    if (next !== existing.role) {
      await orgDb.memberships.update({ role: next }, eq(schema.memberships.id, existing.id))
    }
    return
  }
  await orgDb.memberships.insert({
    id: createPersistedId('membership'),
    tenantId: ctx.tenantId,
    orgId: ctx.orgId,
    userId,
    role: ctx.mappedRole ?? DEFAULT_ORG_ROLE,
    membershipType: 'member',
    status: 'active',
    isManaged: true,
    joinedAt: new Date(),
  })
}

async function syncExistingUser(ctx: JitContext, userId: string): Promise<JitResult> {
  const { assertion } = ctx
  await syncAttributes(ctx, userId)
  await bindUserIdentity({
    db: ctx.db,
    tenantId: ctx.tenantId,
    userId,
    identity: {
      identityType: assertion.identityType ?? 'sso',
      provider: assertion.connectionId,
      providerUserId: assertion.idpId,
      ...(assertion.profileRaw ? { fields: { profileRaw: assertion.profileRaw } } : {}),
    },
  })
  await upsertMembership(ctx, userId)
  return { userId, provisioned: false }
}

// 分支 B:email 命中现有 user。返回 null 表示 email 未被占用,可进入新建分支。
async function linkByEmail(ctx: JitContext, email: string): Promise<JitResult | null> {
  const link = await findLinkableUserByEmail(ctx.db, {
    orgId: ctx.orgId,
    email,
    emailVerified: ctx.assertion.emailVerified,
  })
  if (link.kind === 'none') return null
  if (link.kind === 'conflict') throw new AppError('invalid_credentials')
  await enforceEnterpriseSsoPolicy({ c: ctx.c, action: 'login', email })
  return syncExistingUser(ctx, link.userId)
}

// 分支 D:users / user_emails / user_identities / membership 一次 D1 batch 写入,失败不留孤儿行。
async function provisionNewUser(
  ctx: JitContext,
  options: { skipDefaultMembership: boolean },
): Promise<JitResult> {
  const { c, tenantId, orgId, assertion } = ctx
  const userId = createPersistedId('user')
  const email = assertion.email
  const emailVerified = email ? await isIdpEmailTrusted(ctx, email) : false
  const emailId = email ? crypto.randomUUID() : null
  const now = new Date()
  await provisionAccountAtomically({
    d1: c.env.DB,
    tenantId,
    user: {
      id: userId,
      primaryEmailId: emailId,
      firstName: assertion.firstName,
      lastName: assertion.lastName,
      displayName: [assertion.firstName, assertion.lastName].filter(Boolean).join(' ') || null,
      provisionedBy: 'jit_sso',
    },
    primaryEmail:
      email && emailId
        ? {
            id: emailId,
            email,
            verified: emailVerified,
            verificationStatus: emailVerified ? 'verified' : 'unverified',
            verifiedAt: emailVerified ? now : null,
          }
        : null,
    externalIdentity: {
      id: createPersistedId('userIdentity'),
      identityType: assertion.identityType ?? 'sso',
      provider: assertion.connectionId,
      providerUserId: assertion.idpId,
      profileRaw: assertion.profileRaw ?? null,
      lastUsedAt: now,
    },
    managedMembership: options.skipDefaultMembership
      ? null
      : { id: createPersistedId('membership'), orgId, role: ctx.mappedRole ?? DEFAULT_ORG_ROLE },
  })
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

async function loadConnection(db: Db, assertion: SsoAssertion): Promise<SsoConnection> {
  const connection = await db.ssoConnections.findOne(
    eq(schema.ssoConnections.id, assertion.connectionId),
  )
  if (!connection) throw new AppError('connection_not_found')
  // connection.orgId 是权威来源:assertion.orgId 由调用方构造不可信,不一致即拒绝(02 章 6)。
  if (assertion.orgId !== connection.orgId) {
    throw new AppError('invalid_credentials', {
      longMessage: 'assertion orgId does not match connection orgId',
    })
  }
  return connection
}

async function findActiveIdentity(
  db: Db,
  connectionId: string,
  providerUserId: string,
): Promise<typeof schema.userIdentities.$inferSelect | undefined> {
  return db.userIdentities.findOne(
    and(
      eq(schema.userIdentities.provider, connectionId),
      eq(schema.userIdentities.providerUserId, providerUserId),
      isNull(schema.userIdentities.revokedAt),
    ),
  )
}

// JIT Provisioning 主入口。
export async function jitProvision(
  c: Context<XidHonoEnv>,
  assertion: SsoAssertion,
  options?: { skipDefaultMembership?: boolean },
): Promise<JitResult> {
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const connection = await loadConnection(db, assertion)
  const ctx: JitContext = {
    c,
    db,
    tenantId: tenant.tenantId,
    orgId: connection.orgId,
    assertion,
    mappedRole: resolveMappedOrgRole(
      assertion.groups,
      connection.roleMapping as Record<string, unknown>,
    ),
  }

  // 分支 A:idp_id 精确匹配(已撤销的绑定不在此命中),其次是迁移前的 NameID 绑定。
  const existingIdentity =
    (await findActiveIdentity(db, assertion.connectionId, assertion.idpId)) ??
    (assertion.legacyIdpId
      ? await findActiveIdentity(db, assertion.connectionId, assertion.legacyIdpId)
      : undefined)
  if (existingIdentity) {
    await enforceEnterpriseSsoPolicy({ c, action: 'login', email: assertion.email })
    return syncExistingUser(ctx, existingIdentity.userId)
  }

  if (assertion.email) {
    const linked = await linkByEmail(ctx, assertion.email)
    if (linked) return linked
  }

  // 分支 C:JIT 关闭。
  if (!connection.jitEnabled) throw new AppError('provisioning_disabled')

  // 分支 D:新建。
  await enforceEnterpriseSsoPolicy({ c, action: 'user_creation', email: assertion.email })
  return provisionNewUser(ctx, { skipDefaultMembership: options?.skipDefaultMembership ?? false })
}
