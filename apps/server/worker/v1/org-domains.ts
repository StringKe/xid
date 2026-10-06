// /v1/organizations/:id/domains 组织邮箱域名。Console 与 Management API 返回同一形状。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { domainVerificationRecord } from '../lib/domain-verification'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { paginationQuerySchema, readJsonBody, validateBody, validateQuery } from '../lib/validate'
import { auditOrgMutation, isUniqueConstraintError } from './org-shared'
import {
  MAX_PAGE_SIZE,
  idAfterCursor,
  paginate,
  requireApiKey,
  requireApiKeyOrOrgManager,
  requireOrg,
} from './shared'

const app = new Hono<XidHonoEnv>()

const createDomainBodySchema = v.object({
  domain: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.minLength(1), v.maxLength(253)),
  enrollment_mode: v.optional(v.picklist(['automatic', 'invite_required'])),
})

// verification_token 与 verification_record 属设计保留(域名验证流程要向用户展示),
// 收窄 tenant_id / verification_method / deleted_at 等内部列。
function toDomainResponse(row: typeof schema.organizationDomains.$inferSelect) {
  return {
    id: row.id,
    org_id: row.orgId,
    domain: row.domain,
    verification_token: row.verificationToken,
    verification_record: domainVerificationRecord(row.domain, row.verificationToken),
    verification_status: row.verificationStatus,
    is_wildcard: row.isWildcard,
    enrollment_mode: row.enrollmentMode,
    verified_at: row.verifiedAt,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

// GET /v1/organizations/:id/domains
app.get('/:id/domains', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'organization_domains:read')
  const orgDb = createTenantDb(c.env.DB, c.get('tenant')).forOrg(id)
  const query = validateQuery(paginationQuerySchema, c.req.query())
  const limit = query.limit ?? MAX_PAGE_SIZE
  const active = eq(schema.organizationDomains.status, 'active')
  const after = idAfterCursor(schema.organizationDomains.id, query.cursor ?? null)
  const rows = await orgDb.organizationDomains.findMany(after ? and(active, after) : active, {
    orderBy: asc(schema.organizationDomains.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toDomainResponse), (row) => row.id, limit))
})

// POST /v1/organizations/:id/domains
app.post('/:id/domains', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'organization_domains:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createDomainBodySchema, json.value)
  const enrollmentMode = body.enrollment_mode ?? 'invite_required'

  // 全局唯一(UNIQUE(domain),见 schema/rbac.ts organizationDomains)
  const existing = await db.organizationDomains.findOne(
    eq(schema.organizationDomains.domain, body.domain),
  )
  let row: typeof schema.organizationDomains.$inferSelect
  if (existing?.status === 'deleted' && existing.orgId === id) {
    const updated = await db.organizationDomains.update(
      {
        enrollmentMode,
        verificationStatus: 'pending',
        verificationToken: crypto.randomUUID(),
        status: 'active',
        deletedAt: null,
      },
      eq(schema.organizationDomains.id, existing.id),
    )
    row = updated[0]!
  } else if (existing) {
    throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'domain' } })
  } else {
    try {
      row = await db.organizationDomains.insert({
        id: createPersistedId('organizationDomain'),
        tenantId: tenant.tenantId,
        orgId: id,
        domain: body.domain,
        verificationToken: crypto.randomUUID(),
        enrollmentMode,
        verificationStatus: 'pending',
      })
    } catch (error) {
      // 全局 UNIQUE(domain) 但预检只查本租户:他租户已注册时撞约束,映射 409 模糊文案
      // (不指明持有者,枚举防护),不外溢 500。
      if (isUniqueConstraintError(error)) {
        throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'domain' } })
      }
      throw error
    }
  }
  auditOrgMutation(c, auth, {
    action: 'organization_domain.created',
    orgId: id,
    targetType: 'organization_domain',
    targetId: row.id,
    details: { domain: row.domain, enrollmentMode },
  })
  return c.json(toDomainResponse(row), 201)
})

// DELETE /v1/organizations/:id/domains/:domainId
app.delete('/:id/domains/:domainId', async (c) => {
  const key = await requireApiKey(c, 'organization_domains:write')
  const id = c.req.param('id')
  await requireOrg(c, id)

  const domainId = c.req.param('domainId')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const where = and(
    eq(schema.organizationDomains.id, domainId),
    eq(schema.organizationDomains.status, 'active'),
  )
  const row = await db.organizationDomains.findOne(where)
  if (!row || row.orgId !== id) throw new AppError('not_found', { httpStatus: 404 })

  await db.organizationDomains.update({ status: 'deleted', deletedAt: new Date() }, where)
  auditOrgMutation(
    c,
    { kind: 'api_key', apiKeyId: key.id, scopes: key.scopes },
    {
      action: 'organization_domain.deleted',
      orgId: id,
      targetType: 'organization_domain',
      targetId: row.id,
      details: { domain: row.domain },
    },
  )
  return new Response(null, { status: 204 })
})

export function registerOrgDomainsRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/organizations', app)
}
