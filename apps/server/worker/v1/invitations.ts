// Management API v1: /v1/organizations/:orgId/invitations 邀请资源。
// CRUD + list(cursor 分页) + bulk create(50/hour 限速)+ revoke。
// 认证:sk_live_ Bearer。租户隔离:createTenantDb + forOrg。
// token 只存 SHA-256 哈希(防 DB 泄露重放,见 password-auth rule 密码重置 token 策略)。

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { emailSchema, readJsonBody, validateBody } from '../lib/validate'
import { hostedAuthOriginForTenant } from '../lib/hosted-origin'
import {
  requireApiKey,
  parsePagination,
  paginate,
  idAfterCursor,
  requireOrg,
  requireApiKeyOrOrgManager,
  encodeCursor,
  checkInvitationRateLimit,
  emitWebhookAsync,
} from './shared'
import { INVITATION_TTL_DAYS } from '../lib/ttl'

const app = new Hono<XidHonoEnv>()

// 形状校验只管字段类型/必填/边界;50/hour 限速语义不变(见 api-sdk-conventions rule)。
const invitationRoleSchema = v.picklist(['owner', 'admin', 'member'])

const createInvitationBodySchema = v.object({
  email: emailSchema,
  role: v.optional(invitationRoleSchema),
  expires_in_days: v.optional(v.pipe(v.number(), v.minValue(1))),
})

const bulkInvitationsBodySchema = v.object({
  invitations: v.pipe(
    v.array(v.object({ email: emailSchema, role: v.optional(invitationRoleSchema) })),
    v.minLength(1),
    v.maxLength(50),
  ),
})

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

function toConsoleInvitation(row: Omit<typeof schema.invitations.$inferSelect, 'tokenHash'>) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: toIso(row.expiresAt) ?? '',
    createdAt: toIso(row.createdAt) ?? '',
  }
}

function consolePage<T>(rows: T[], getId: (row: T) => string, limit: number, total: number) {
  const hasMore = rows.length > limit
  const data = hasMore ? rows.slice(0, limit) : rows
  const last = data[data.length - 1]
  return {
    data,
    nextCursor: hasMore && last !== undefined ? encodeCursor(getId(last)) : null,
    total,
  }
}

// ---- 列表 ----

// GET /v1/organizations/:orgId/invitations?limit=&cursor=&status=
app.get('/:orgId/invitations', async (c) => {
  const orgId = c.req.param('orgId')
  const auth = await requireApiKeyOrOrgManager(c, orgId, 'invitations:read')

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(orgId)
  const { limit, cursor } = parsePagination(c)
  const status = c.req.query('status') ?? 'pending'

  const afterCond = idAfterCursor(schema.invitations.id, cursor)
  const statusCond = eq(schema.invitations.status, status)
  const where = afterCond ? and(statusCond, afterCond) : statusCond
  const rows = await orgDb.invitations.findMany(where, {
    orderBy: asc(schema.invitations.id),
    limit: limit + 1,
  })
  // 不暴露 tokenHash(安全)
  const limited = rows.map(safeInvitation)
  if (auth.kind === 'org_console') {
    const total = await orgDb.invitations.count(statusCond)
    const data = limited.map(toConsoleInvitation)
    return c.json(consolePage(data, (r) => r.id, limit, total))
  }
  return c.json(paginate(limited, (r) => r.id, limit))
})

// ---- 单个 ----

// GET /v1/organizations/:orgId/invitations/:invitationId
app.get('/:orgId/invitations/:invitationId', async (c) => {
  await requireApiKey(c, 'invitations:read')
  const orgId = c.req.param('orgId')
  await requireOrg(c, orgId)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(orgId)
  const invitationId = c.req.param('invitationId')

  const row = await orgDb.invitations.findOne(
    and(eq(schema.invitations.id, invitationId), eq(schema.invitations.status, 'pending')),
  )
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(safeInvitation(row))
})

// ---- 创建(单条) ----

// POST /v1/organizations/:orgId/invitations
app.post('/:orgId/invitations', async (c) => {
  const orgId = c.req.param('orgId')
  const auth = await requireApiKeyOrOrgManager(c, orgId, 'invitations:write')
  if (auth.kind === 'api_key') await checkInvitationRateLimit(c, 1)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createInvitationBodySchema, json.value)

  // cookie 路径防自提:admin 不得发 owner 邀请(owner/org_manager 不受限;sk 路径是 Management API 信任域,维持现状)。
  if (auth.kind === 'org_console' && auth.role === 'admin' && body.role === 'owner') {
    throw new AppError('forbidden', { httpStatus: 403 })
  }

  const token = crypto.randomUUID()
  const tokenHash = await sha256Hex(token)
  const expiresAt = new Date(Date.now() + (body.expires_in_days ?? INVITATION_TTL_DAYS) * 86400_000)

  const org = await requireOrg(c, orgId)
  const invitedByUserId = auth.kind === 'org_console' ? auth.session.userId : null
  const orgDb = db.forOrg(orgId)
  const invitation = await orgDb.invitations.insert({
    id: crypto.randomUUID(),
    tenantId: tenant.tenantId,
    orgId,
    email: body.email.trim().toLowerCase(),
    role: body.role ?? 'member',
    tokenHash,
    expiresAt,
    status: 'pending',
    invitedByUserId,
  })
  const acceptLink = `${hostedAuthOriginForTenant(c.get('tenant'))}/accept-invitation?token=${encodeURIComponent(token)}`
  const expiresInDays = body.expires_in_days ?? INVITATION_TTL_DAYS
  await c.env.EMAIL_QUEUE.send({
    type: 'organization_invitation',
    recipient: body.email.trim().toLowerCase(),
    payload: {
      tenantId: tenant.tenantId,
      orgName: org.name,
      role: body.role ?? 'member',
      link: acceptLink,
      expiresInDays,
    },
  })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organizationInvitation.created',
    payload: { orgId, invitationId: invitation.id, email: body.email },
  })
  if (auth.kind === 'org_console')
    return c.json(toConsoleInvitation(safeInvitation(invitation)), 201)
  return c.json({ ...safeInvitation(invitation), token }, 201)
})

// ---- 批量创建(50/hour 限速) ----

// POST /v1/organizations/:orgId/invitations/bulk
app.post('/:orgId/invitations/bulk', async (c) => {
  await requireApiKey(c, 'invitations:write')
  const orgId = c.req.param('orgId')
  await requireOrg(c, orgId)

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(bulkInvitationsBodySchema, json.value)
  // 限速检查:本批 + 当前小时已用量不超 50
  await checkInvitationRateLimit(c, body.invitations.length)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const org = await requireOrg(c, orgId)
  const orgDb = db.forOrg(orgId)
  const authOrigin = hostedAuthOriginForTenant(c.get('tenant'))

  const results = await Promise.all(
    body.invitations.map(async (item) => {
      const email = item.email.trim().toLowerCase()
      const token = crypto.randomUUID()
      const tokenHash = await sha256Hex(token)
      const expiresAt = new Date(Date.now() + 7 * 86400_000)
      const inv = await orgDb.invitations.insert({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        orgId,
        email,
        role: item.role ?? 'member',
        tokenHash,
        expiresAt,
        status: 'pending',
      })
      const acceptLink = `${authOrigin}/accept-invitation?token=${encodeURIComponent(token)}`
      await c.env.EMAIL_QUEUE.send({
        type: 'organization_invitation',
        recipient: email,
        payload: {
          tenantId: tenant.tenantId,
          orgName: org.name,
          role: item.role ?? 'member',
          link: acceptLink,
          expiresInDays: 7,
        },
      })
      emitWebhookAsync(c, {
        tenantId: tenant.tenantId,
        event: 'organizationInvitation.created',
        payload: { orgId, invitationId: inv.id, email },
      })
      return { ...safeInvitation(inv), token }
    }),
  )
  return c.json({ data: results }, 201)
})

// ---- 撤销 ----

// POST /v1/organizations/:orgId/invitations/:invitationId/revoke
app.post('/:orgId/invitations/:invitationId/revoke', async (c) => {
  await requireApiKey(c, 'invitations:write')
  const orgId = c.req.param('orgId')
  await requireOrg(c, orgId)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(orgId)
  const invitationId = c.req.param('invitationId')

  const row = await orgDb.invitations.findOne(
    and(eq(schema.invitations.id, invitationId), eq(schema.invitations.status, 'pending')),
  )
  if (!row) throw new AppError('not_found', { httpStatus: 404 })

  const updated = await orgDb.invitations.update(
    { status: 'revoked' },
    and(eq(schema.invitations.id, invitationId), eq(schema.invitations.status, 'pending')),
  )
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organizationInvitation.revoked',
    payload: { orgId, invitationId },
  })
  return c.json(safeInvitation(updated[0]!))
})

// ---- 删除 ----

// DELETE /v1/organizations/:orgId/invitations/:invitationId
app.delete('/:orgId/invitations/:invitationId', async (c) => {
  const orgId = c.req.param('orgId')
  await requireApiKeyOrOrgManager(c, orgId, 'invitations:write')

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(orgId)
  const invitationId = c.req.param('invitationId')

  const row = await orgDb.invitations.findOne(
    and(eq(schema.invitations.id, invitationId), eq(schema.invitations.status, 'pending')),
  )
  if (!row) throw new AppError('not_found', { httpStatus: 404 })

  await orgDb.invitations.update(
    { status: 'revoked' },
    and(eq(schema.invitations.id, invitationId), eq(schema.invitations.status, 'pending')),
  )
  return new Response(null, { status: 204 })
})

// safeInvitation: 从 DB 行中剔除 tokenHash(不暴露给 API 响应)。
function safeInvitation(
  row: typeof schema.invitations.$inferSelect,
): Omit<typeof schema.invitations.$inferSelect, 'tokenHash'> {
  const { tokenHash: _omit, ...rest } = row
  return rest
}

export function registerInvitationsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/organizations', app)
}
