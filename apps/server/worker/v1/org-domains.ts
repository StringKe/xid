// /v1/organizations/:id/domains 组织邮箱域名。Console 与 Management API 返回同一形状。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { verifyDomainDnsTxt } from '../crons/daily'
import { domainVerificationRecord } from '../lib/domain-verification'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { paginationQuerySchema, readJsonBody, validateBody, validateQuery } from '../lib/validate'
import { auditOrgMutation, isUniqueConstraintError, toIso } from './org-shared'
import {
  MAX_PAGE_SIZE,
  idAfterCursor,
  paginate,
  requireApiKey,
  requireApiKeyOrOrgManager,
  requireOrg,
} from './shared'
import { userDisplayName } from './user-query'

const app = new Hono<XidHonoEnv>()

type TenantDb = ReturnType<typeof createTenantDb>
type DomainRow = typeof schema.organizationDomains.$inferSelect

const createDomainBodySchema = v.object({
  domain: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.minLength(1), v.maxLength(253)),
  enrollment_mode: v.optional(v.picklist(['automatic', 'invite_required'])),
})

export type ActorDisplay = {
  kind: 'user' | 'api_key'
  id: string
  displayName: string | null
}

// 审计 actorId 可能是用户或 API key;都查不到(已删除)时不返回。
export async function loadActorDisplays(
  db: TenantDb,
  actorIds: readonly string[],
): Promise<Map<string, ActorDisplay>> {
  const ids = [...new Set(actorIds)]
  const displays = new Map<string, ActorDisplay>()
  if (ids.length === 0) return displays
  const [users, keys] = await Promise.all([
    db.users.findMany(and(inArray(schema.users.id, ids), isNull(schema.users.deletedAt))),
    db.apiKeys.findMany(inArray(schema.apiKeys.id, ids)),
  ])
  const emailIds = users.map((user) => user.primaryEmailId).filter((id): id is string => !!id)
  const emails =
    emailIds.length > 0 ? await db.userEmails.findMany(inArray(schema.userEmails.id, emailIds)) : []
  const emailById = new Map(emails.map((row) => [row.id, row.email]))
  for (const user of users) {
    const email = user.primaryEmailId ? (emailById.get(user.primaryEmailId) ?? null) : null
    displays.set(user.id, {
      kind: 'user',
      id: user.id,
      displayName: userDisplayName(user) ?? email,
    })
  }
  for (const key of keys)
    displays.set(key.id, { kind: 'api_key', id: key.id, displayName: key.name })
  return displays
}

type DomainExtras = {
  userCount: number
  routedConnection: { id: string; name: string | null } | null
  addedBy: ActorDisplay | null
}

// verification_token 与 verification_record 属设计保留(域名验证流程要向用户展示),
// 收窄 tenant_id / verification_method / deleted_at 等内部列。
function toDomainResponse(row: DomainRow, extras?: DomainExtras) {
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
    last_checked_at: toIso(row.lastCheckedAt),
    last_check_result: row.lastCheckResult,
    user_count: extras?.userCount ?? 0,
    routed_connection: extras?.routedConnection ?? null,
    added_by: extras?.addedBy
      ? {
          kind: extras.addedBy.kind,
          id: extras.addedBy.id,
          display_name: extras.addedBy.displayName,
        }
      : null,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function emailDomainUsers(domain: string) {
  const suffix = `@${domain}`
  return sql`lower(substr(${schema.userEmails.email}, ${-suffix.length})) = ${suffix}`
}

async function domainExtras(
  db: TenantDb,
  orgId: string,
  rows: readonly DomainRow[],
): Promise<Map<string, DomainExtras>> {
  const ids = rows.map((row) => row.id)
  const [connection, created, userCounts] = await Promise.all([
    db.forOrg(orgId).ssoConnections.findOne(eq(schema.ssoConnections.status, 'active')),
    ids.length > 0
      ? db.auditEvents.findMany(
          and(
            eq(schema.auditEvents.eventType, 'organization_domain.created'),
            inArray(schema.auditEvents.targetId, ids),
          ),
        )
      : Promise.resolve([]),
    Promise.all(
      rows.map((row) =>
        db.userEmails.countDistinct(schema.userEmails.userId, emailDomainUsers(row.domain)),
      ),
    ),
  ])
  const creatorByDomain = new Map<string, string>()
  for (const event of created) {
    if (event.targetId && event.actorId) creatorByDomain.set(event.targetId, event.actorId)
  }
  const actors = await loadActorDisplays(db, [...creatorByDomain.values()])
  return new Map(
    rows.map((row, index) => {
      const creator = creatorByDomain.get(row.id)
      return [
        row.id,
        {
          userCount: userCounts[index] ?? 0,
          routedConnection:
            connection && row.verificationStatus === 'verified'
              ? { id: connection.id, name: connection.displayName }
              : null,
          addedBy: creator ? (actors.get(creator) ?? null) : null,
        },
      ]
    }),
  )
}

// GET /v1/organizations/:id/domains
app.get('/:id/domains', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'organization_domains:read')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const query = validateQuery(paginationQuerySchema, c.req.query())
  const limit = query.limit ?? MAX_PAGE_SIZE
  const active = eq(schema.organizationDomains.status, 'active')
  const after = idAfterCursor(schema.organizationDomains.id, query.cursor ?? null)
  const rows = await db
    .forOrg(id)
    .organizationDomains.findMany(after ? and(active, after) : active, {
      orderBy: asc(schema.organizationDomains.id),
      limit: limit + 1,
    })
  const page = rows.slice(0, limit)
  const extras = await domainExtras(db, id, page)
  return c.json(
    paginate(
      rows.map((row) => toDomainResponse(row, extras.get(row.id))),
      (row) => row.id,
      limit,
    ),
  )
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
  let row: DomainRow
  if (existing?.status === 'deleted' && existing.orgId === id) {
    const updated = await db.organizationDomains.update(
      {
        enrollmentMode,
        verificationStatus: 'pending',
        verificationToken: crypto.randomUUID(),
        lastCheckedAt: null,
        lastCheckResult: null,
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

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

// POST /v1/organizations/:id/domains/:domainId/verify  立即查一次 DNS TXT,不必等每日检查。
app.post('/:id/domains/:domainId/verify', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'organization_domains:write')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const orgDomains = db.forOrg(id).organizationDomains
  const where = and(
    eq(schema.organizationDomains.id, c.req.param('domainId')),
    eq(schema.organizationDomains.status, 'active'),
  )
  const row = await orgDomains.findOne(where)
  if (!row) throw new AppError('not_found', { httpStatus: 404 })

  let found: boolean
  try {
    found = await verifyDomainDnsTxt(row.domain, row.verificationToken)
  } catch (error) {
    if (isTimeout(error))
      throw new AppError('service_unavailable', { httpStatus: 503, cause: error })
    throw error
  }
  const checkedAt = new Date()
  const updated = await orgDomains.update(
    {
      lastCheckedAt: checkedAt,
      lastCheckResult: found ? 'found' : 'not_found',
      ...(found && row.verificationStatus !== 'verified'
        ? { verificationStatus: 'verified', verifiedAt: checkedAt }
        : {}),
    },
    where,
  )
  const next = updated[0] ?? row
  auditOrgMutation(c, auth, {
    action: 'organization.domain.verification_checked',
    orgId: id,
    targetType: 'organization_domain',
    targetId: row.id,
    details: { domain: row.domain, result: next.lastCheckResult },
  })
  const extras = await domainExtras(db, id, [next])
  return c.json(toDomainResponse(next, extras.get(next.id)))
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
