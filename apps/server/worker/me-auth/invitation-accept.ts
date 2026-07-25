// 组织邀请接受:预览 + 已登录用户接受(Hosted UI /accept-invitation 页)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { SessionData, XidHonoEnv } from '../lib/types'
import {
  acceptInvitationByToken,
  invitationAcceptContinuePath,
  loadInvitationPreview,
  loadPrimaryEmailForUserId,
} from '../auth/invitations'
import { readJsonBody, validateBody, validateQuery } from '../lib/validate'
import { requireSession } from './shared'

const acceptBodySchema = v.object({ token: v.string() })
const previewQuerySchema = v.object({ token: v.optional(v.string()) })

export async function handleInvitationPreview(c: Context<XidHonoEnv>): Promise<Response> {
  const query = validateQuery(previewQuerySchema, { token: c.req.query('token') })
  const rawToken = query.token ?? ''
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const preview = await loadInvitationPreview(db, rawToken)
  return c.json(preview)
}

export async function handleInvitationAccept(c: Context<XidHonoEnv>): Promise<Response> {
  const session = await requireSession(c)
  const json = await readJsonBody(c)
  // 坏 JSON 与缺 token 同响应 422 + paramName=token(前端映射回表单字段)。
  if (!json.ok) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'token' } })
  }
  const body = validateBody(acceptBodySchema, json.value)
  const rawToken = body.token.trim()
  if (!rawToken) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'token' },
    })
  }

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const user = await db.users.findOne(eq(schema.users.id, session.userId))
  if (!user) throw new AppError('unauthorized', { httpStatus: 401 })

  const userEmail = await loadPrimaryEmailForUserId(db, user.id, user.primaryEmailId)
  const accepted = await acceptInvitationByToken({
    db,
    env: c.env,
    tenantId: tenant.tenantId,
    rawToken,
    userId: session.userId,
    userEmail,
  })

  const org = await db.organizations.findOne(eq(schema.organizations.id, accepted.orgId))
  const orgName = org?.name ?? org?.slug ?? accepted.orgId

  await db.sessions.update(
    { activeOrgId: accepted.orgId },
    and(
      eq(schema.sessions.id, session.sessionId),
      eq(schema.sessions.userId, session.userId),
      eq(schema.sessions.status, 'active'),
    ),
  )

  return c.json({
    orgId: accepted.orgId,
    role: accepted.role,
    redirectUrl: invitationAcceptContinuePath(accepted.orgId, orgName),
  })
}

export async function applyInvitationAfterSession(
  c: Context<XidHonoEnv>,
  session: SessionData,
  rawToken: string,
): Promise<string | null> {
  const token = rawToken.trim()
  if (!token) return null

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const user = await db.users.findOne(eq(schema.users.id, session.userId))
  if (!user) return null

  const userEmail = await loadPrimaryEmailForUserId(db, user.id, user.primaryEmailId)
  const accepted = await acceptInvitationByToken({
    db,
    env: c.env,
    tenantId: tenant.tenantId,
    rawToken: token,
    userId: session.userId,
    userEmail,
  })

  await db.sessions.update(
    { activeOrgId: accepted.orgId },
    and(
      eq(schema.sessions.id, session.sessionId),
      eq(schema.sessions.userId, session.userId),
      eq(schema.sessions.status, 'active'),
    ),
  )

  const org = await db.organizations.findOne(eq(schema.organizations.id, accepted.orgId))
  const orgName = org?.name ?? org?.slug ?? accepted.orgId
  return invitationAcceptContinuePath(accepted.orgId, orgName)
}
