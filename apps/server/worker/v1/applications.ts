// Management API v1: applications/oauthApplications(= OAuthClient)
// CRUD + client_secret rotate。见 06 章 7 Management API 表、oidc-oauth rule。
// 租户隔离:tenant_id 从 TenantContext 取,禁信任 body(见 tenant-isolation rule)。
// 路由前缀:/v1/applications

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { TOKEN_POLICY_BOUNDS } from '@xid-kit/types'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, ttlSecSchema, validateBody, validateRedirectUris } from '../lib/validate'
import {
  idAfterCursor,
  requireApiKeyOrTopLevelOrgManager,
  paginate,
  parsePagination,
} from './shared'

const app = new Hono<XidHonoEnv>()

// access_token_ttl_sec 边界与 normalize 同源(TOKEN_POLICY_BOUNDS),出界即拒,不靠 clamp 静默改写。
// 额外 v.integer():手写守卫时代即拒非整数,语义保持。null = 清除 client 覆盖回继承(写 NULL)。
const accessTokenTtlSecBounds = TOKEN_POLICY_BOUNDS.accessTokenTtlSec
const accessTokenTtlSecSchema = v.nullable(
  v.pipe(ttlSecSchema(accessTokenTtlSecBounds.min, accessTokenTtlSecBounds.max), v.integer()),
)

// 形状校验只管字段类型/必填性;唯一性等业务校验留在 handler(见 error-handling rule)。
// application_type 仅校验期使用(表无此列):native 放行 loopback http 与自定义 scheme redirect_uri(RFC8252)。
const createApplicationBodySchema = v.object({
  client_type: v.optional(v.string()),
  token_endpoint_auth_method: v.optional(v.string()),
  application_type: v.optional(v.picklist(['web', 'native'])),
  redirect_uris: v.optional(v.array(v.string())),
  post_logout_redirect_uris: v.optional(v.array(v.string())),
  allowed_grant_types: v.optional(v.array(v.string())),
  allowed_scopes: v.optional(v.array(v.string())),
  require_pkce: v.optional(v.boolean()),
})

const patchApplicationBodySchema = v.object({
  application_type: v.optional(v.picklist(['web', 'native'])),
  redirect_uris: v.optional(v.array(v.string())),
  post_logout_redirect_uris: v.optional(v.array(v.string())),
  allowed_grant_types: v.optional(v.array(v.string())),
  allowed_scopes: v.optional(v.array(v.string())),
  require_pkce: v.optional(v.boolean()),
  status: v.optional(v.string()),
  access_token_ttl_sec: v.optional(accessTokenTtlSecSchema),
})

// redirect_uris 注册校验(DCR 共用 validateRedirectUris):http 明文/fragment/空串 -> 422,
// authorization_code grant 必须非空(否则 authorize 永远无法精确匹配,见 03 章)。
function assertRedirectUris(
  uris: readonly string[],
  options: { applicationType: 'web' | 'native'; grantTypes: readonly string[] },
): void {
  const check = validateRedirectUris(uris, options)
  if (!check.ok) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'redirect_uris' },
    })
  }
}

// 生成 client_id(随机 26 字符字母数字)和 client_secret(随机 40 字符)。
function genClientId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(36))
    .join('')
    .slice(0, 26)
}

function genClientSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(30))
  return Array.from(bytes)
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 40)
}

// 应用行转对外响应(不返回 clientSecretHash)。
function toResponse(row: typeof schema.applications.$inferSelect) {
  return {
    id: row.id,
    client_id: row.clientId,
    client_type: row.clientType,
    token_endpoint_auth_method: row.tokenEndpointAuthMethod,
    redirect_uris: row.redirectUris,
    post_logout_redirect_uris: row.postLogoutRedirectUris,
    allowed_grant_types: row.allowedGrantTypes,
    allowed_scopes: row.allowedScopes,
    require_pkce: row.requirePkce,
    dpop_bound_access_tokens: row.dpopBoundAccessTokens,
    access_token_format: row.accessTokenFormat,
    access_token_ttl_sec: row.accessTokenTtlSec,
    id_token_signed_alg: row.idTokenSignedAlg,
    first_party: row.firstParty,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

// GET /v1/applications
app.get('/', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'applications:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const { limit, cursor } = parsePagination(c)
  const active = eq(schema.applications.status, 'active')
  const after = idAfterCursor(schema.applications.id, cursor)
  const rows = await db.applications.findMany(after ? and(active, after) : active, {
    orderBy: asc(schema.applications.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toResponse), (r) => r.id, limit))
})

// POST /v1/applications
app.post('/', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'applications:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createApplicationBodySchema, json.value)
  const grantTypes = body.allowed_grant_types ?? ['authorization_code', 'refresh_token']
  assertRedirectUris(body.redirect_uris ?? [], {
    applicationType: body.application_type ?? 'web',
    grantTypes,
  })

  const clientSecret = genClientSecret()
  const clientSecretHash = await sha256Hex(clientSecret)
  const clientId = genClientId()
  const id = crypto.randomUUID()

  const row = await db.applications.insert({
    id,
    tenantId: tenant.tenantId,
    clientId,
    clientSecretHash,
    clientType: body.client_type ?? 'confidential',
    tokenEndpointAuthMethod: body.token_endpoint_auth_method ?? 'client_secret_basic',
    redirectUris: body.redirect_uris ?? [],
    postLogoutRedirectUris: body.post_logout_redirect_uris ?? [],
    allowedGrantTypes: body.allowed_grant_types ?? ['authorization_code', 'refresh_token'],
    allowedScopes: body.allowed_scopes ?? ['openid', 'profile', 'email', 'offline_access'],
    requirePkce: body.require_pkce !== false,
    status: 'active',
  })

  return c.json({ ...toResponse(row), client_secret: clientSecret }, 201)
})

// GET /v1/applications/:id
app.get('/:id', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'applications:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const row = await db.applications.findOne(
    and(eq(schema.applications.id, c.req.param('id')), eq(schema.applications.status, 'active')),
  )
  if (!row) throw new AppError('not_found')
  return c.json(toResponse(row))
})

// PATCH /v1/applications/:id
app.patch('/:id', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'applications:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchApplicationBodySchema, json.value)
  const where = and(
    eq(schema.applications.id, c.req.param('id')),
    eq(schema.applications.status, 'active'),
  )
  const existing = await db.applications.findOne(where)
  if (!existing) throw new AppError('not_found')

  const patch: Partial<typeof schema.applications.$inferInsert> = {}
  if (body.redirect_uris !== undefined) {
    assertRedirectUris(body.redirect_uris, {
      applicationType: body.application_type ?? 'web',
      grantTypes: body.allowed_grant_types ?? existing.allowedGrantTypes,
    })
    patch.redirectUris = body.redirect_uris
  }
  if (body.post_logout_redirect_uris !== undefined)
    patch.postLogoutRedirectUris = body.post_logout_redirect_uris
  if (body.allowed_grant_types !== undefined) patch.allowedGrantTypes = body.allowed_grant_types
  if (body.allowed_scopes !== undefined) patch.allowedScopes = body.allowed_scopes
  if (body.require_pkce !== undefined) patch.requirePkce = body.require_pkce
  if (body.status !== undefined) patch.status = body.status
  if (body.access_token_ttl_sec !== undefined) patch.accessTokenTtlSec = body.access_token_ttl_sec

  const updated = await db.applications.update(patch, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  return c.json(toResponse(row))
})

// DELETE /v1/applications/:id
app.delete('/:id', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'applications:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(
    eq(schema.applications.id, c.req.param('id')),
    eq(schema.applications.status, 'active'),
  )
  const existing = await db.applications.findOne(where)
  if (!existing) throw new AppError('not_found')
  await db.applications.update({ status: 'deleted', updatedAt: new Date() }, where)
  return new Response(null, { status: 204 })
})

// POST /v1/applications/:id/restore
app.post('/:id/restore', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'applications:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(
    eq(schema.applications.id, c.req.param('id')),
    eq(schema.applications.status, 'deleted'),
  )
  const existing = await db.applications.findOne(where)
  if (!existing) throw new AppError('not_found')
  const updated = await db.applications.update({ status: 'active', updatedAt: new Date() }, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  return c.json(toResponse(row))
})

// POST /v1/applications/:id/rotate-secret
app.post('/:id/rotate-secret', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'applications:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(
    eq(schema.applications.id, c.req.param('id')),
    eq(schema.applications.status, 'active'),
  )
  const existing = await db.applications.findOne(where)
  if (!existing) throw new AppError('not_found')

  const newSecret = genClientSecret()
  const newHash = await sha256Hex(newSecret)
  await db.applications.update({ clientSecretHash: newHash }, where)
  return c.json({ client_secret: newSecret })
})

export function registerApplications(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/applications', app)
}
