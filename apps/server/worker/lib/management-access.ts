import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from './errors'
import { ACTIVE_SESSION_STATUS } from './session'
import type { SessionData, XidHonoEnv } from './types'

const SAFE_MANAGEMENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export async function requireVerifiedManagementMutation(
  c: Context<XidHonoEnv>,
  session: SessionData,
): Promise<void> {
  if (session.status !== ACTIVE_SESSION_STATUS) {
    throw new AppError('unauthorized', { httpStatus: 401 })
  }
  if (SAFE_MANAGEMENT_METHODS.has(c.req.method.toUpperCase())) return
  if (session.isImpersonation) {
    throw new AppError('forbidden', { httpStatus: 403 })
  }

  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const user = await db.users.findOne(eq(schema.users.id, session.userId))
  if (!user) {
    throw new AppError('email_verification_required', { httpStatus: 403 })
  }
  const primaryEmail = await db.userEmails.findOne(
    user.primaryEmailId
      ? and(
          eq(schema.userEmails.id, user.primaryEmailId),
          eq(schema.userEmails.userId, session.userId),
          eq(schema.userEmails.isPrimary, true),
        )
      : and(eq(schema.userEmails.userId, session.userId), eq(schema.userEmails.isPrimary, true)),
  )
  if (!primaryEmail?.verified) {
    throw new AppError('email_verification_required', { httpStatus: 403 })
  }
}
