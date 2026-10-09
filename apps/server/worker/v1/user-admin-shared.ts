// /v1/users/:id 管理员子资源共用:按租户取用户(不属于当前租户一律 404)与管理动作的审计和 webhook。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { emitManagementAuditAsync, emitWebhookAsync } from './shared'
import { notDeletedUser } from './user-query'

type TenantDb = ReturnType<typeof createTenantDb>
type UserRow = typeof schema.users.$inferSelect

export async function findTenantUser(
  db: TenantDb,
  id: string,
  options: { includeDeleted: boolean },
): Promise<UserRow> {
  const user = await db.users.findOne(
    options.includeDeleted
      ? eq(schema.users.id, id)
      : and(eq(schema.users.id, id), notDeletedUser()),
  )
  if (!user) throw new AppError('not_found', { httpStatus: 404 })
  return user
}

export function auditAdminAction(
  c: Context<XidHonoEnv>,
  input: { action: string; actorId: string; userId: string },
): void {
  emitManagementAuditAsync(c, {
    action: input.action,
    actorId: input.actorId,
    orgId: c.get('tenant').tenantId,
    targetType: 'user',
    targetId: input.userId,
  })
  emitWebhookAsync(c, {
    tenantId: c.get('tenant').tenantId,
    event: 'user.updated',
    payload: { userId: input.userId },
  })
}
