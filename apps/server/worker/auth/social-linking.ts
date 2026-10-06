// Social account linking(01 章 3):已连直接登;已验证 email 合并;未验证且用户存在拒合并;否则建号。
// 不按 provider_user_id 分支响应。外部身份写入统一走 bindUserIdentity / provisionAccountAtomically。

import type { createTenantDb } from '@xid-kit/db'
import { schema } from '@xid-kit/db'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { bindUserIdentity } from '../lib/user-identity'
import type { ExternalIdentityFields } from '../lib/user-identity'
import { loadGuestConversionContext, markGuestConverted } from '../me-auth/guest-conversion'
import { provisionAccountAtomically } from './account-provisioning'
import { auditPolicyDeniedError } from './hosted-audit'
import { assertSocialProviderAllowed } from './hosted-policy'
import { encryptToken, hasProviderSecret } from './social-providers'
import type { Provider, ProviderProfile, TokenResponse } from './social-providers'

export type LinkContext = {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  db: ReturnType<typeof createTenantDb>
  provider: Provider
  scopes: string[]
  tokens: TokenResponse
  profile: ProviderProfile
  skipDefaultMembership?: boolean
}

type PolicyAction = 'login' | 'user_creation'

async function assertLinkAllowed(ctx: LinkContext, action: PolicyAction): Promise<void> {
  const { email, emailVerified } = ctx.profile
  try {
    assertSocialProviderAllowed({
      tenant: ctx.tenant,
      provider: ctx.provider,
      action,
      email,
      emailVerified,
      hasSecret: (policy, providerName) => hasProviderSecret(ctx.c.env, policy, providerName),
    })
  } catch (error) {
    throw await auditPolicyDeniedError(ctx.c, error, {
      tenant: ctx.tenant,
      method: 'social',
      action,
      provider: ctx.provider,
      identifier: { type: 'email', value: email },
    })
  }
}

// provider token 落 D1 前 AES-256-GCM 信封加密。
async function identityFields(ctx: LinkContext): Promise<ExternalIdentityFields> {
  const { env } = ctx.c
  return {
    accessTokenCiphertext: Buffer.from(await encryptToken(env, ctx.tokens.accessToken)),
    refreshTokenCiphertext: ctx.tokens.refreshToken
      ? Buffer.from(await encryptToken(env, ctx.tokens.refreshToken))
      : null,
    scopes: ctx.scopes,
    profileRaw: ctx.profile.profileRaw,
  }
}

async function auditConnectionLinked(ctx: LinkContext, userId: string): Promise<void> {
  await ctx.c.env.AUDIT_QUEUE.send({
    tenantId: ctx.tenant.tenantId,
    action: 'connection.linked',
    actorId: userId,
    ts: Date.now(),
    payload: { provider: ctx.provider, idpUserId: ctx.profile.idpUserId },
  })
}

async function bindToUser(ctx: LinkContext, userId: string): Promise<void> {
  const { linked } = await bindUserIdentity({
    db: ctx.db,
    tenantId: ctx.tenant.tenantId,
    userId,
    identity: {
      identityType: 'oauth',
      provider: ctx.provider,
      providerUserId: ctx.profile.idpUserId,
      fields: await identityFields(ctx),
    },
  })
  if (linked) await auditConnectionLinked(ctx, userId)
  await maybeUpdateExternalId(ctx, userId)
}

// 单条条件 UPDATE:只填空 external_id,且同租户无其他 user 占用;影响 0 行是预期结果。
async function maybeUpdateExternalId(ctx: LinkContext, userId: string): Promise<void> {
  const externalId = ctx.profile.externalId
  if (!externalId) return
  await ctx.db.users.update(
    { externalId },
    and(
      eq(schema.users.id, userId),
      isNull(schema.users.externalId),
      sql`NOT EXISTS (SELECT 1 FROM users AS owner WHERE owner.tenant_id = ${ctx.tenant.tenantId} AND owner.external_id = ${externalId})`,
    ),
  )
}

// account linking 判断树(01 章 3 四分支),返回登录 userId。
export async function linkOrCreateUser(ctx: LinkContext): Promise<string> {
  const { db, provider, profile } = ctx
  const { idpUserId, email, emailVerified } = profile

  // 分支 A:active SocialConnection -> 直接登录,刷新 token。断开过的连接不在此命中。
  const existingIdentity = await db.userIdentities.findOne(
    and(
      eq(schema.userIdentities.provider, provider),
      eq(schema.userIdentities.providerUserId, idpUserId),
      isNull(schema.userIdentities.revokedAt),
    ),
  )
  if (existingIdentity) {
    await assertLinkAllowed(ctx, 'login')
    await bindToUser(ctx, existingIdentity.userId)
    return existingIdentity.userId
  }

  // 分支 B/C:按 email 命中现有 user。
  if (email) {
    const emailRow = await db.userEmails.findOne(eq(schema.userEmails.email, email))
    if (
      emailRow &&
      emailVerified &&
      emailRow.verified &&
      emailRow.verificationStatus === 'verified'
    ) {
      await assertLinkAllowed(ctx, 'login')
      await bindToUser(ctx, emailRow.userId)
      return emailRow.userId
    }
    // 分支 C:email 未验证且 user 存在 -> 拒绝自动合并(防社工)。
    if (emailRow) throw new AppError('invalid_credentials')
  }

  // 分支 D:全新 user;持有效 guest session 时挂到 guest user(social 建号不写 provisionedBy)。
  await assertLinkAllowed(ctx, 'user_creation')
  const guest = await loadGuestConversionContext(ctx.c, db)
  if (guest) {
    await bindToUser(ctx, guest.userId)
    await markGuestConverted({ c: ctx.c, tenant: ctx.tenant, db, guest, provisionedBy: null })
    return guest.userId
  }
  return createNewUser(ctx)
}

// 新建 user + 主邮箱 + SocialConnection(分支 D),记 user.created + connection.linked 审计。
async function createNewUser(ctx: LinkContext): Promise<string> {
  const { c, tenant, provider, profile } = ctx
  const userId = createPersistedId('user')
  const nameParts = (profile.name ?? '').split(' ')
  const emailId = profile.email ? crypto.randomUUID() : null
  const fields = await identityFields(ctx)
  const now = new Date()
  await provisionAccountAtomically({
    d1: c.env.DB,
    tenantId: tenant.tenantId,
    user: {
      id: userId,
      externalId: profile.externalId ?? null,
      primaryEmailId: emailId,
      firstName: nameParts[0] ?? null,
      lastName: nameParts.slice(1).join(' ') || null,
      displayName: profile.name ?? null,
      profileCompletionStatus: 'incomplete',
      provisionedBy: null,
      isNewUser: true,
    },
    primaryEmail:
      profile.email && emailId
        ? {
            id: emailId,
            email: profile.email,
            verified: profile.emailVerified,
            verificationStatus: profile.emailVerified ? 'verified' : 'unverified',
            verifiedAt: profile.emailVerified ? now : null,
          }
        : null,
    externalIdentity: {
      id: createPersistedId('userIdentity'),
      identityType: 'oauth',
      provider,
      providerUserId: profile.idpUserId,
      accessTokenCiphertext: fields.accessTokenCiphertext ?? null,
      refreshTokenCiphertext: fields.refreshTokenCiphertext ?? null,
      scopes: ctx.scopes,
      profileRaw: profile.profileRaw,
      lastUsedAt: now,
    },
    defaultMembership: ctx.skipDefaultMembership
      ? null
      : { id: createPersistedId('membership'), orgId: tenant.tenantId },
  })

  await auditConnectionLinked(ctx, userId)
  await c.env.AUDIT_QUEUE.send({
    tenantId: tenant.tenantId,
    action: 'user.created',
    actorId: userId,
    ts: Date.now(),
    payload: { provider, idpUserId: profile.idpUserId },
  })
  return userId
}
