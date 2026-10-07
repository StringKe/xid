// /v1/organizations/:orgId/invitations 的批量邀请与重发。
// 双认证 requireApiKeyOrOrgManager;两者都计入租户邀请限速(50/hour,RateLimitStore 原子计数)。
// 批量邀请逐条返回结果:created / already_member / already_invited / failed;每条独立落库,一条失败不回滚其他条。
// 重发换新 token(token_hash 变化即作废旧链接)、延长有效期、重新入邮件队列;token_version 是格式版本,不变。

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { hostedAuthOriginForTenant } from '../lib/hosted-origin'
import { createTenantBoundInvitationToken } from '../lib/invitation-token'
import { logWorkerError } from '../lib/safe-log'
import { INVITATION_TTL_DAYS } from '../lib/ttl'
import type { XidHonoEnv } from '../lib/types'
import { emailSchema, readJsonBody, validateBody } from '../lib/validate'
import {
  enqueuePersistedEmailNotification,
  prepareNotificationOutboxInsert,
} from '../queues/notification-delivery-state'
import {
  buildInvitationDelivery,
  invitationRecipientLocale,
  invitationRoleSchema,
  invitationTargetState,
  prepareInvitation,
  safeInvitation,
  type SafeInvitation,
} from './invitations'
import {
  auditActorId,
  canManageOwners,
  checkInvitationRateLimit,
  emitManagementAuditAsync,
  emitWebhookAsync,
  requireApiKeyOrOrgManager,
  requireOrg,
} from './shared'

const app = new Hono<XidHonoEnv>()

const bulkInvitationsBodySchema = v.object({
  invitations: v.pipe(
    v.array(v.object({ email: emailSchema, role: v.optional(invitationRoleSchema) })),
    v.minLength(1),
    v.maxLength(50),
  ),
})

type BulkResult = {
  email: string
  result: 'created' | 'already_member' | 'already_invited' | 'failed'
  invitation?: SafeInvitation
  token?: string
}

// POST /v1/organizations/:orgId/invitations/bulk
app.post('/:orgId/invitations/bulk', async (c) => {
  const orgId = c.req.param('orgId')
  const auth = await requireApiKeyOrOrgManager(c, orgId, 'invitations:write')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(bulkInvitationsBodySchema, json.value)
  if (body.invitations.some((item) => item.role === 'owner') && !canManageOwners(auth)) {
    throw new AppError('forbidden', { httpStatus: 403 })
  }
  await checkInvitationRateLimit(c, body.invitations.length)

  const tenant = c.get('tenant')
  const org = await requireOrg(c, orgId)
  const db = createTenantDb(c.env.DB, tenant)
  const authOrigin = hostedAuthOriginForTenant(tenant)
  const invitedByUserId = auth.kind === 'org_console' ? auth.session.userId : null
  const seen = new Set<string>()
  const results: BulkResult[] = []

  for (const item of body.invitations) {
    const email = item.email.trim().toLowerCase()
    if (seen.has(email)) {
      results.push({ email, result: 'already_invited' })
      continue
    }
    seen.add(email)
    const state = await invitationTargetState(db, orgId, email)
    if (state !== 'available') {
      results.push({ email, result: state })
      continue
    }
    try {
      const prepared = await prepareInvitation(c.env, {
        tenantId: tenant.tenantId,
        orgId,
        orgName: org.name,
        email,
        role: item.role ?? 'member',
        invitedByUserId,
        expiresInDays: INVITATION_TTL_DAYS,
        authOrigin,
        locale: await invitationRecipientLocale(db, email),
      })
      await c.env.DB.batch(prepared.statements)
      await enqueuePersistedEmailNotification(c.env, prepared.delivery)
      emitWebhookAsync(c, {
        tenantId: tenant.tenantId,
        event: 'organizationInvitation.created',
        payload: { orgId, invitationId: prepared.invitation.id, email },
      })
      emitManagementAuditAsync(c, {
        action: 'invitation.created',
        actorId: auditActorId(auth),
        orgId,
        targetType: 'invitation',
        targetId: prepared.invitation.id,
        details: { role: prepared.invitation.role },
      })
      results.push({
        email,
        result: 'created',
        invitation: safeInvitation(prepared.invitation),
        ...(auth.kind === 'api_key' ? { token: prepared.token } : {}),
      })
    } catch (error) {
      logWorkerError('management.invitation.bulk_row_failed', error, {
        component: 'management-api',
      })
      results.push({ email, result: 'failed' })
    }
  }
  return c.json({ data: results })
})

// POST /v1/organizations/:orgId/invitations/:invitationId/resend
app.post('/:orgId/invitations/:invitationId/resend', async (c) => {
  const orgId = c.req.param('orgId')
  const auth = await requireApiKeyOrOrgManager(c, orgId, 'invitations:write')
  const tenant = c.get('tenant')
  const org = await requireOrg(c, orgId)
  const orgDb = createTenantDb(c.env.DB, tenant).forOrg(orgId)
  const invitationId = c.req.param('invitationId')
  const existing = await orgDb.invitations.findOne(eq(schema.invitations.id, invitationId))
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  if (existing.status !== 'pending') throw new AppError('conflict', { httpStatus: 409 })
  await checkInvitationRateLimit(c, 1)

  const now = Date.now()
  const token = createTenantBoundInvitationToken(tenant.tenantId)
  const expiresAt = new Date(now + INVITATION_TTL_DAYS * 86400_000)
  const delivery = buildInvitationDelivery({
    messageId: `${invitationId}:${now}`,
    tenantId: tenant.tenantId,
    orgName: org.name,
    email: existing.email,
    role: existing.role,
    token,
    authOrigin: hostedAuthOriginForTenant(tenant),
    expiresInDays: INVITATION_TTL_DAYS,
    locale: await invitationRecipientLocale(createTenantDb(c.env.DB, tenant), existing.email),
  })
  const [rotated] = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE invitations
          SET token_hash = ?, expires_at = ?, updated_at = ?
        WHERE tenant_id = ? AND org_id = ? AND id = ? AND status = 'pending'`,
    ).bind(await sha256Hex(token), expiresAt.getTime(), now, tenant.tenantId, orgId, invitationId),
    await prepareNotificationOutboxInsert(c.env, delivery, { ignoreExisting: false, now }),
  ])
  if ((rotated?.meta as { changes?: number } | undefined)?.changes !== 1) {
    throw new AppError('conflict', { httpStatus: 409 })
  }
  await enqueuePersistedEmailNotification(c.env, delivery)
  emitManagementAuditAsync(c, {
    action: 'organizationInvitation.resent',
    actorId: auditActorId(auth),
    orgId,
    targetType: 'invitation',
    targetId: invitationId,
  })
  const updated = await orgDb.invitations.findOne(
    and(eq(schema.invitations.id, invitationId), eq(schema.invitations.status, 'pending')),
  )
  if (!updated) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(safeInvitation(updated))
})

export function registerInvitationActionRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/organizations', app)
}
