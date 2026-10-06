// 出站 SCIM target:/v1/organizations/:id/scim-targets。
// 下游 bearer token 是只写字段,经 KEK 信封加密存 D1,响应只回 hasToken(04 章 3);
// 写操作受 allow_org_self_service 门控(02 章 6)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, ne } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import * as v from 'valibot'
import { readAllById } from '../lib/db-pagination'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { enqueueScimTargetSync } from '../scim/outbound'
import {
  encryptScimTargetToken,
  normalizeScimTargetBaseUrl,
  scimTargetHasToken,
} from '../scim/target-credentials'
import {
  assignmentGateFromBody,
  parseAssignmentGate,
  serializeAssignmentGate,
  withAssignmentGate,
} from '../sso/assignment-gate'
import { assertOrgSelfServiceEditable } from './org-self-service'
import { auditOrgMutation } from './org-shared'
import { emitWebhookAsync, requireApiKeyOrOrgManager, requireOrg } from './shared'
import type { OrgScopedAuth } from './shared'

type ScimTargetRecord = typeof schema.scimTargets.$inferSelect

const MAX_TOKEN_LENGTH = 4096

// provider/base_url 缺失统一报 paramName 'base_url'(既有契约),必填守卫留在 handler。
const scimTargetBodySchema = v.object({
  provider: v.optional(v.string()),
  base_url: v.optional(v.string()),
  token: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_TOKEN_LENGTH))),
  assignment_gate: v.optional(v.unknown()),
  assignmentGate: v.optional(v.unknown()),
})

function toConsoleScimTarget(row: ScimTargetRecord) {
  return {
    id: row.id,
    provider: row.provider,
    baseUrl: row.baseUrl,
    hasToken: scimTargetHasToken(row),
    assignmentGate: serializeAssignmentGate(
      parseAssignmentGate(row.userFilter as Record<string, unknown>),
    ),
    status: row.status,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastRunStatus: row.lastRunStatus ?? null,
    lastRunError: row.lastRunError ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    syncPath: `/scim/outbound/${row.id}/sync`,
    createdAt: row.createdAt?.toISOString() ?? '',
  }
}

async function requireEditableTargetManager(
  c: Context<XidHonoEnv>,
  orgId: string,
): Promise<OrgScopedAuth> {
  const auth = await requireApiKeyOrOrgManager(c, orgId, 'connections:write')
  await assertOrgSelfServiceEditable(c, auth, await requireOrg(c, orgId))
  return auth
}

function targetWhere(c: Context<XidHonoEnv>, orgId: string) {
  return and(
    eq(schema.scimTargets.id, c.req.param('targetId') ?? ''),
    eq(schema.scimTargets.orgId, orgId),
    ne(schema.scimTargets.status, 'deleted'),
  )
}

// token 以 bearer 发往 base_url,换到别的 origin 必须重新提交,否则改 URL 即可把已存 token 送给新主机。
function movesTokenToNewOrigin(existing: ScimTargetRecord, nextBaseUrl: string): boolean {
  return (
    scimTargetHasToken(existing) && new URL(existing.baseUrl).origin !== new URL(nextBaseUrl).origin
  )
}

async function readTargetBody(c: Context<XidHonoEnv>) {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  return validateBody(scimTargetBodySchema, json.value)
}

export function registerOrganizationScimTargetRoutes(app: Hono<XidHonoEnv>): void {
  app.get('/:id/scim-targets', async (c) => {
    const id = c.req.param('id')
    await requireApiKeyOrOrgManager(c, id, 'connections:read')
    const orgDb = createTenantDb(c.env.DB, c.get('tenant')).forOrg(id)
    const notDeleted = ne(schema.scimTargets.status, 'deleted')
    const rows = await readAllById((cursor, limit) =>
      orgDb.scimTargets.findMany(
        cursor ? and(notDeleted, gt(schema.scimTargets.id, cursor)) : notDeleted,
        { orderBy: asc(schema.scimTargets.id), limit },
      ),
    )
    return c.json(rows.map(toConsoleScimTarget))
  })

  app.post('/:id/scim-targets', async (c) => {
    const id = c.req.param('id')
    const auth = await requireEditableTargetManager(c, id)
    const tenant = c.get('tenant')
    const body = await readTargetBody(c)
    const provider = body.provider?.trim() ?? ''
    const rawBaseUrl = body.base_url?.trim() ?? ''
    if (!provider || !rawBaseUrl) {
      throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'base_url' } })
    }
    const gate = assignmentGateFromBody(body) ?? parseAssignmentGate({})
    const row = await createTenantDb(c.env.DB, tenant).scimTargets.insert({
      id: createPersistedId('scimTarget'),
      tenantId: tenant.tenantId,
      orgId: id,
      provider,
      baseUrl: normalizeScimTargetBaseUrl(rawBaseUrl),
      ...(body.token ? await encryptScimTargetToken(c.env, body.token) : {}),
      userFilter: withAssignmentGate({}, gate),
      status: 'active',
    })
    emitWebhookAsync(c, {
      tenantId: tenant.tenantId,
      event: 'organization.scim_target.created',
      payload: { orgId: id, targetId: row.id, provider },
    })
    auditOrgMutation(c, auth, {
      action: 'scim_target.created',
      orgId: id,
      targetType: 'scim_target',
      targetId: row.id,
      details: { provider },
    })
    return c.json(toConsoleScimTarget(row), 201)
  })

  app.patch('/:id/scim-targets/:targetId', async (c) => {
    const id = c.req.param('id')
    const auth = await requireEditableTargetManager(c, id)
    const db = createTenantDb(c.env.DB, c.get('tenant'))
    const body = await readTargetBody(c)
    const where = targetWhere(c, id)
    const existing = await db.scimTargets.findOne(where)
    if (!existing) throw new AppError('not_found', { httpStatus: 404 })
    const patch: Partial<typeof schema.scimTargets.$inferInsert> = {}
    if (body.provider?.trim()) patch.provider = body.provider.trim()
    if (body.base_url?.trim()) patch.baseUrl = normalizeScimTargetBaseUrl(body.base_url.trim())
    if (patch.baseUrl && !body.token && movesTokenToNewOrigin(existing, patch.baseUrl)) {
      throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'token' } })
    }
    if (body.token) Object.assign(patch, await encryptScimTargetToken(c.env, body.token))
    const gate = assignmentGateFromBody(body)
    if (gate) {
      patch.userFilter = withAssignmentGate(existing.userFilter as Record<string, unknown>, gate)
    }
    const updated = await db.scimTargets.update(patch, where)
    const row = updated[0]
    if (!row) throw new AppError('not_found', { httpStatus: 404 })
    auditOrgMutation(c, auth, {
      action: 'scim_target.updated',
      orgId: id,
      targetType: 'scim_target',
      targetId: existing.id,
      details: { fields: Object.keys(patch) },
    })
    return c.json(toConsoleScimTarget(row))
  })

  app.delete('/:id/scim-targets/:targetId', async (c) => {
    const id = c.req.param('id')
    const auth = await requireEditableTargetManager(c, id)
    const tenant = c.get('tenant')
    const targetId = c.req.param('targetId')
    const updated = await createTenantDb(c.env.DB, tenant).scimTargets.update(
      { status: 'deleted', tokenIv: null, tokenCiphertext: null, tokenTag: null },
      targetWhere(c, id),
    )
    if (updated.length === 0) throw new AppError('not_found', { httpStatus: 404 })
    emitWebhookAsync(c, {
      tenantId: tenant.tenantId,
      event: 'organization.scim_target.deleted',
      payload: { orgId: id, targetId },
    })
    auditOrgMutation(c, auth, {
      action: 'scim_target.deleted',
      orgId: id,
      targetType: 'scim_target',
      targetId,
    })
    return new Response(null, { status: 204 })
  })

  app.post('/:id/scim-targets/:targetId/sync', async (c) => {
    const id = c.req.param('id')
    const auth = await requireEditableTargetManager(c, id)
    const target = await createTenantDb(c.env.DB, c.get('tenant')).scimTargets.findOne(
      and(targetWhere(c, id), eq(schema.scimTargets.status, 'active')),
    )
    if (!target) throw new AppError('not_found', { httpStatus: 404 })
    const actorId = auth.kind === 'org_console' ? auth.session.userId : auth.apiKeyId
    return c.json(await enqueueScimTargetSync(c, target, actorId), 202)
  })
}
