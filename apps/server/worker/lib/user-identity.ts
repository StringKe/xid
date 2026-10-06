// 外部身份(social / SSO / SAML)绑定的唯一写入点。
// (tenant_id, provider, provider_user_id) 唯一索引不排除已撤销行:断开连接或 guest GC 撤销后,
// 同一外部账号再次登录必须复活原行而不是再 INSERT,否则唯一约束冲突。

import { schema } from '@xid-kit/db'
import type { createTenantDb } from '@xid-kit/db'
import { and, eq, isNotNull } from 'drizzle-orm'
import { AppError } from './errors'
import { createPersistedId } from './persisted-id'

type TenantDb = ReturnType<typeof createTenantDb>

type IdentityInsert = typeof schema.userIdentities.$inferInsert

export type ExternalIdentityType = 'oauth' | 'sso' | 'saml'

export type ExternalIdentityFields = Pick<
  IdentityInsert,
  'accessTokenCiphertext' | 'refreshTokenCiphertext' | 'scopes' | 'profileRaw'
>

export type ExternalIdentity = {
  identityType: ExternalIdentityType
  provider: string
  providerUserId: string
  fields?: ExternalIdentityFields
}

export type BindUserIdentityInput = {
  db: TenantDb
  tenantId: string
  userId: string
  identity: ExternalIdentity
}

// 调用方先按 account linking 规则确定 userId;active 行属于另一个 user 时拒绝(不透明码)。
// 返回 linked=true 表示新建或复活了绑定,调用方据此记 connection.linked 审计。
export async function bindUserIdentity(input: BindUserIdentityInput): Promise<{ linked: boolean }> {
  const { db, tenantId, userId, identity } = input
  const now = new Date()
  const match = and(
    eq(schema.userIdentities.provider, identity.provider),
    eq(schema.userIdentities.providerUserId, identity.providerUserId),
  )
  const existing = await db.userIdentities.findOne(match)
  if (!existing) {
    await db.userIdentities.insert({
      id: createPersistedId('userIdentity'),
      tenantId,
      userId,
      identityType: identity.identityType,
      provider: identity.provider,
      providerUserId: identity.providerUserId,
      ...identity.fields,
      lastUsedAt: now,
    })
    return { linked: true }
  }
  if (!existing.revokedAt) {
    if (existing.userId !== userId) throw new AppError('invalid_credentials')
    await db.userIdentities.update(
      { ...identity.fields, lastUsedAt: now },
      eq(schema.userIdentities.id, existing.id),
    )
    return { linked: false }
  }
  const revived = await db.userIdentities.update(
    {
      userId,
      identityType: identity.identityType,
      revokedAt: null,
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      tokenExpiresAt: null,
      scopes: null,
      profileRaw: null,
      ...identity.fields,
      lastUsedAt: now,
      createdAt: now,
    },
    and(eq(schema.userIdentities.id, existing.id), isNotNull(schema.userIdentities.revokedAt)),
  )
  if (revived.length !== 1) throw new AppError('server_error')
  return { linked: true }
}
