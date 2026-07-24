import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { readJsonBody, validateBody } from '../lib/validate'
import { requireSession } from './shared'

// null 表示清除 active org;字符串拒绝空白(trim 后为空),非空原样使用(不做隐式 trim)。
const activeOrganizationBodySchema = v.object({
  organizationId: v.nullable(
    v.pipe(
      v.string(),
      v.check((value) => value.trim() !== ''),
    ),
  ),
})

function validationError(): AppError {
  return new AppError('validation_failed', {
    httpStatus: 422,
    meta: { paramName: 'organizationId' },
  })
}

async function assertActiveOrganizationMembership(
  c: Context<XidHonoEnv>,
  userId: string,
  organizationId: string,
): Promise<void> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const membership = await db.memberships.findOne(
    and(
      eq(schema.memberships.userId, userId),
      eq(schema.memberships.orgId, organizationId),
      eq(schema.memberships.status, 'active'),
    ),
  )
  if (!membership) throw new AppError('not_found', { httpStatus: 404 })

  const organization = await db.organizations.findOne(
    and(
      eq(schema.organizations.id, organizationId),
      eq(schema.organizations.status, 'active'),
      isNull(schema.organizations.deletedAt),
    ),
  )
  if (!organization) throw new AppError('not_found', { httpStatus: 404 })
}

export async function handleActiveOrganization(c: Context<XidHonoEnv>): Promise<Response> {
  const session = await requireSession(c)
  const json = await readJsonBody(c)
  // 非对象 body 一律 paramName=organizationId(与原 Object.hasOwn 守卫同契约)。
  if (!json.ok || typeof json.value !== 'object' || json.value === null) throw validationError()
  const body = validateBody(activeOrganizationBodySchema, json.value)
  const organizationId = body.organizationId

  if (organizationId) {
    await assertActiveOrganizationMembership(c, session.userId, organizationId)
  }

  const db = createTenantDb(c.env.DB, c.get('tenant'))
  await db.sessions.update(
    { activeOrgId: organizationId },
    and(
      eq(schema.sessions.id, session.sessionId),
      eq(schema.sessions.userId, session.userId),
      eq(schema.sessions.status, 'active'),
    ),
  )

  const nextSession = { ...session, activeOrgId: organizationId }
  c.set('session', nextSession)
  return c.json({
    session: {
      id: nextSession.sessionId,
      expiresAt: nextSession.expiresAt.toISOString(),
      isImpersonation: nextSession.isImpersonation,
    },
    activeOrganizationId: organizationId,
  })
}
