// Management API v1: /v1/organizations 组织资源。
// 本文件只放组织本身的 CRUD;认证策略、投递渠道、社交登录、企业 SSO、出站 SAML、目录等子资源按模块注册。
// 认证:sk_live_ Bearer。租户隔离:createTenantDb。
// Instance Manager 跨 org 走独立管理路径(此模块为 Org Admin 视角,见 tenant-isolation rule)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import { paginationQuerySchema, readJsonBody, validateBody, validateQuery } from '../lib/validate'
import {
  buildOrganizationQuotaUpsertStatement,
  buildSeatLimitMirrorStatement,
} from '../platform/quotas'
import { registerOrganizationDirectoryRoutes } from './organization-directories'
import { registerOrganizationScimTargetRoutes } from './organization-scim-targets'
import { registerOrgAuditRoutes } from './org-audit'
import { registerOrgAuthInsightRoutes } from './org-auth-insights'
import { registerOrgAuthPolicyRoutes } from './org-auth-policy'
import { registerOrgBrandingRoutes } from './org-branding'
import { registerOrgDeliveryChannelRoutes } from './org-delivery-channels'
import { registerOrgDomainsRoutes } from './org-domains'
import { registerOrgMembersRoutes } from './org-members'
import { registerOrgOutboundSamlAppRoutes } from './org-outbound-saml-apps'
import { registerOrgOutboundSamlCertificateRoutes } from './org-outbound-saml-certificates'
import { toOrganizationResponse } from './org-shared'
import { registerOrgSocialProviderRoutes } from './org-social-providers'
import { registerOrgSsoConnectionRoutes } from './org-sso-connections'
import {
  requireApiKey,
  MAX_PAGE_SIZE,
  paginate,
  idAfterCursor,
  requireOrg,
  emitWebhookAsync,
} from './shared'

const app = new Hono<XidHonoEnv>()

const metadataRecordSchema = v.record(v.string(), v.unknown())
const enrollmentModeSchema = v.picklist(['automatic', 'invite_required'])
const seatLimitSchema = v.pipe(v.number(), v.integer(), v.minValue(0))

const createOrgBodySchema = v.object({
  parent_org_id: v.pipe(v.string(), v.minLength(1)),
  slug: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
  public_metadata: v.optional(metadataRecordSchema),
  private_metadata: v.optional(metadataRecordSchema),
  enrollment_mode: v.optional(enrollmentModeSchema),
  seat_limit: v.optional(seatLimitSchema),
})

const patchOrgBodySchema = v.object({
  name: v.optional(v.string()),
  slug: v.optional(v.string()),
  public_metadata: v.optional(metadataRecordSchema),
  private_metadata: v.optional(metadataRecordSchema),
  enrollment_mode: v.optional(enrollmentModeSchema),
  seat_limit: v.optional(v.nullable(seatLimitSchema)),
  allow_org_self_service: v.optional(v.boolean()),
})

const toResponse = toOrganizationResponse

async function requireTopLevelParentOrganization(
  c: Context<XidHonoEnv>,
  parentOrgId: string,
): Promise<typeof schema.organizations.$inferSelect> {
  const tenant = c.get('tenant')
  const parent = await requireOrg(c, parentOrgId)
  if (
    parent.id !== tenant.tenantId ||
    parent.tenantId !== tenant.tenantId ||
    parent.parentOrgId !== null
  ) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'parent_org_id' },
    })
  }
  return parent
}

async function requireRestorableChildParent(
  c: Context<XidHonoEnv>,
  organization: typeof schema.organizations.$inferSelect,
): Promise<void> {
  if (organization.parentOrgId === null) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'id' },
    })
  }
  await requireTopLevelParentOrganization(c, organization.parentOrgId)
}

// 保留字:instance 根域解析(default)与平台功能子域不允许业务 org slug 占用(防子域抢占)。
const RESERVED_ORG_SLUGS = new Set(['default', 'www', 'api', 'admin', 'app', 'auth', 'console'])

function assertSlugNotReserved(slug: string): void {
  if (RESERVED_ORG_SLUGS.has(slug.toLowerCase())) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'slug' } })
  }
}

// slug 冲突检查必须按 (instance_id, slug) 实例级全局查:子域解析(resolveMultiTenant)按实例级
// limit(1) 匹配,走 createTenantDb 会注入 tenant_id 漏查他租户占用,导致跨租户子域抢占。
async function findOrgByInstanceSlug(
  c: Context<XidHonoEnv>,
  slug: string,
): Promise<typeof schema.organizations.$inferSelect | undefined> {
  const tenant = c.get('tenant')
  const db = drizzle(c.env.DB, { schema })
  const rows = await db
    .select()
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.instanceId, tenant.instanceId ?? tenant.tenantId),
        eq(schema.organizations.slug, slug),
      ),
    )
    .limit(1)
  return rows[0]
}

// ---- 列表 ----

// GET /v1/organizations?limit=&cursor=
app.get('/', async (c) => {
  await requireApiKey(c, 'organizations:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const query = validateQuery(paginationQuerySchema, c.req.query())
  const limit = query.limit ?? MAX_PAGE_SIZE
  const cursor = query.cursor ?? null

  const afterCond = idAfterCursor(schema.organizations.id, cursor)
  const active = eq(schema.organizations.status, 'active')
  const where = afterCond ? and(active, afterCond) : active
  const rows = await db.organizations.findMany(where, {
    orderBy: asc(schema.organizations.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toResponse), (r) => r.id, limit))
})

// ---- 单个 ----

// GET /v1/organizations/:id
app.get('/:id', async (c) => {
  await requireApiKey(c, 'organizations:read')
  const org = await requireOrg(c, c.req.param('id'))
  return c.json(toResponse(org))
})

registerOrgSsoConnectionRoutes(app)
registerOrganizationDirectoryRoutes(app)
registerOrgAuthInsightRoutes(app)
registerOrgAuthPolicyRoutes(app)
registerOrgDeliveryChannelRoutes(app)
registerOrgSocialProviderRoutes(app)
registerOrgOutboundSamlAppRoutes(app)
registerOrganizationScimTargetRoutes(app)

// ---- 创建 ----

// POST /v1/organizations
app.post('/', async (c) => {
  await requireApiKey(c, 'organizations:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createOrgBodySchema, json.value)
  if (body.seat_limit !== undefined) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'seat_limit' },
    })
  }
  assertSlugNotReserved(body.slug)
  const parent = await requireTopLevelParentOrganization(c, body.parent_org_id)

  // slug 实例级唯一:子域解析按 (instance_id, slug) 全局 limit(1)(见 tenant-context.ts resolveMultiTenant),
  // 冲突检查必须同域;仅同租户 deleted 行允许复活,他租户占用一律 409(不指明持有者,枚举防护)。
  const existing = await findOrgByInstanceSlug(c, body.slug)
  if (existing?.status === 'deleted' && existing.tenantId === tenant.tenantId) {
    if (existing.parentOrgId !== parent.id) {
      throw new AppError('already_exists', {
        httpStatus: 409,
        meta: { paramName: 'slug' },
      })
    }
    const updated = await db.organizations.update(
      {
        name: body.name,
        publicMetadata: body.public_metadata ?? {},
        privateMetadata: body.private_metadata ?? {},
        enrollmentMode: body.enrollment_mode ?? 'invite_required',
        status: 'active',
        deletedAt: null,
      },
      eq(schema.organizations.id, existing.id),
    )
    emitWebhookAsync(c, {
      tenantId: tenant.tenantId,
      event: 'organization.created',
      payload: { orgId: existing.id },
    })
    return c.json(toResponse(updated[0]!), 201)
  }
  if (existing)
    throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'slug' } })

  const id = createPersistedId('organization')
  const org = await db.organizations.insert({
    id,
    tenantId: tenant.tenantId,
    // instance_id 取 TenantContext.instanceId(buildContext 产出);缺省回退 tenantId 兼容旧上下文。
    instanceId: tenant.instanceId ?? tenant.tenantId,
    parentOrgId: parent.id,
    slug: body.slug,
    name: body.name,
    publicMetadata: body.public_metadata ?? {},
    privateMetadata: body.private_metadata ?? {},
    enrollmentMode: body.enrollment_mode ?? 'invite_required',
    status: 'active',
  })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.created',
    payload: { orgId: id },
  })
  return c.json(toResponse(org), 201)
})

// ---- 更新 ----

// PATCH /v1/organizations/:id
app.patch('/:id', async (c) => {
  const apiKey = await requireApiKey(c, 'organizations:write')
  const id = c.req.param('id')
  await requireOrg(c, id)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchOrgBodySchema, json.value)
  if (body.seat_limit !== undefined && id !== tenant.tenantId) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'seat_limit' },
    })
  }

  const patch: Partial<typeof schema.organizations.$inferInsert> = {}
  if (body.name !== undefined) patch.name = body.name
  if (body.slug !== undefined) {
    assertSlugNotReserved(body.slug)
    // 与 POST 同一实例级冲突检查(排除自身):不改这里,改 slug 即可抢占他租户子域。
    const conflict = await findOrgByInstanceSlug(c, body.slug)
    if (conflict && conflict.id !== id) {
      throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'slug' } })
    }
    patch.slug = body.slug
  }
  if (body.public_metadata !== undefined) patch.publicMetadata = body.public_metadata
  if (body.private_metadata !== undefined) patch.privateMetadata = body.private_metadata
  if (body.enrollment_mode !== undefined) patch.enrollmentMode = body.enrollment_mode
  if (body.allow_org_self_service !== undefined)
    patch.allowOrgSelfService = body.allow_org_self_service

  if (body.seat_limit !== undefined) {
    const now = Date.now()
    await c.env.DB.batch([
      buildSeatLimitMirrorStatement(c.env, {
        tenantId: tenant.tenantId,
        seatLimit: body.seat_limit,
        now,
      }),
      buildOrganizationQuotaUpsertStatement(c.env, {
        tenantId: tenant.tenantId,
        quota: {
          key: 'seats',
          limit: body.seat_limit,
          enforcement: 'observe',
        },
        updatedBy: apiKey.id,
        now,
      }),
    ])
  }
  const updated =
    Object.keys(patch).length === 0
      ? [await db.organizations.findOne(eq(schema.organizations.id, id))]
      : await db.organizations.update(patch, eq(schema.organizations.id, id))
  if (!updated[0]) throw new AppError('not_found', { httpStatus: 404 })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.updated',
    payload: { orgId: id },
  })
  return c.json(toResponse(updated[0]!))
})

// ---- 删除 ----

// DELETE /v1/organizations/:id
app.delete('/:id', async (c) => {
  await requireApiKey(c, 'organizations:write')
  const id = c.req.param('id')
  const organization = await requireOrg(c, id)
  await requireRestorableChildParent(c, organization)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  // 软删除
  await db.organizations.update(
    { deletedAt: new Date(), status: 'deleted' },
    eq(schema.organizations.id, id),
  )
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.deleted',
    payload: { orgId: id },
  })
  return new Response(null, { status: 204 })
})

// POST /v1/organizations/:id/restore
app.post('/:id/restore', async (c) => {
  await requireApiKey(c, 'organizations:write')
  const id = c.req.param('id')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(eq(schema.organizations.id, id), eq(schema.organizations.status, 'deleted'))
  const existing = await db.organizations.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await requireRestorableChildParent(c, existing)

  const updated = await db.organizations.update({ status: 'active', deletedAt: null }, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.restored',
    payload: { orgId: id },
  })
  return c.json(toResponse(row))
})

// /v1/organizations 家族统一在此注册,子模块按资源拆分。
export function registerOrganizationsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/organizations', app)
  registerOrgMembersRoutes(honoApp)
  registerOrgDomainsRoutes(honoApp)
  registerOrgBrandingRoutes(honoApp)
  registerOrgAuditRoutes(honoApp)
  registerOrgOutboundSamlCertificateRoutes(honoApp)
}
