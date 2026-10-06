// 入站 SCIM 停用序列(04 章 10.1.2):同步写 User.status、撤销 session、refresh family 与已签发
// access token,审计异步投递。返回即代表账号已被锁定,任一同步步骤失败都向上抛出。

import { createTenantDb, schema } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { scheduleUserScimTargetSyncs } from './outbound'
import { emitAuditAsync, revokeAllUserSessions } from './shared'
import { ensureDirectoryMembership, suspendDirectoryMembership } from './user-provisioning'

export type DirectoryAccountTarget = {
  tenant: TenantContext
  userId: string
  orgId: string
  directoryId: string
}

async function revokeUserOAuthTokens(env: Env, tenantId: string, userId: string): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO access_token_revocations (
         id, tenant_id, jti, client_id, subject, expires_at, revoked_at, created_at
       ) SELECT lower(hex(randomblob(16))), tenant_id, jti, client_id, subject, expires_at, ?, ?
         FROM access_token_issuances
         WHERE tenant_id = ? AND expires_at > ? AND (
           subject = ? OR refresh_family_id IN (
             SELECT family_id FROM refresh_tokens WHERE tenant_id = ? AND user_id = ?
           )
         )`,
    ).bind(now, now, tenantId, now, userId, tenantId, userId),
    env.DB.prepare(
      `UPDATE refresh_tokens
         SET revoked_at = COALESCE(revoked_at, ?), family_revoked_at = ?
         WHERE tenant_id = ? AND user_id = ? AND family_revoked_at IS NULL`,
    ).bind(now, now, tenantId, userId),
  ])
}

export type DeactivateDirectoryAccountInput = DirectoryAccountTarget & {
  reason: 'deactivated' | 'deleted'
}

export async function deactivateDirectoryAccount(
  c: Context<XidHonoEnv>,
  input: DeactivateDirectoryAccountInput,
): Promise<void> {
  const db = createTenantDb(c.env.DB, input.tenant)
  await db.users.update(
    { status: 'deactivated' },
    and(eq(schema.users.id, input.userId), eq(schema.users.status, 'active')),
  )
  await revokeAllUserSessions(c.env, input.tenant, input.userId)
  await revokeUserOAuthTokens(c.env, input.tenant.tenantId, input.userId)
  if (input.reason === 'deleted') {
    await suspendDirectoryMembership(
      { db, tenantId: input.tenant.tenantId, orgId: input.orgId },
      input.userId,
    )
  }
  scheduleUserScimTargetSyncs(c, input.userId)
  emitAuditAsync(c, {
    tenantId: input.tenant.tenantId,
    orgId: input.orgId,
    action: input.reason === 'deleted' ? 'scim.user.deleted' : 'scim.user.deactivated',
    ts: Date.now(),
    payload: { userId: input.userId, directoryId: input.directoryId },
  })
}

// 只恢复本流程停用的账号:banned、locked 等管理员状态不被 IdP 自动解除。
export async function reactivateDirectoryAccount(
  c: Context<XidHonoEnv>,
  target: DirectoryAccountTarget,
): Promise<void> {
  const db = createTenantDb(c.env.DB, target.tenant)
  await db.users.update(
    { status: 'active' },
    and(eq(schema.users.id, target.userId), eq(schema.users.status, 'deactivated')),
  )
  await ensureDirectoryMembership(
    { db, tenantId: target.tenant.tenantId, orgId: target.orgId },
    target.userId,
  )
  scheduleUserScimTargetSyncs(c, target.userId)
  emitAuditAsync(c, {
    tenantId: target.tenant.tenantId,
    orgId: target.orgId,
    action: 'scim.user.reactivated',
    ts: Date.now(),
    payload: { userId: target.userId, directoryId: target.directoryId },
  })
}
