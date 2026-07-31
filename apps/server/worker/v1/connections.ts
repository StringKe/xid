// Management API v1: connections(SSO 连接配置,per-org)
// CRUD。见 06 章 7、04 章 SSO。
// 租户隔离:tenant_id 从 TenantContext 取;orgId 从 body 取但二次验证同 tenant。
// 路由前缀:/v1/connections

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { ORGANIZATION_MEMBERSHIP_ROLES } from '@xid-kit/types'
import { DEFAULT_SAML_CLOCK_SKEW_MS, MAX_SAML_CLOCK_SKEW_MS } from '@xid-kit/saml'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { publicHttpsUrlSchema, readJsonBody, validateBody } from '../lib/validate'
import {
  INBOUND_SSO_PROTOCOLS,
  prepareLegacyAttributeMapping,
  trustedProxySecretConfigured,
} from '../sso/legacy-shared'
import { idAfterCursor, requireApiKey, paginate, parsePagination, requireOrg } from './shared'

const app = new Hono<XidHonoEnv>()

const attributeMappingSchema = v.record(v.string(), v.unknown())

// 形状校验只管字段类型/必填性;protocol 枚举与 header 配置等业务校验见 handler。
// IdP URL 会进入浏览器跳转或 Worker 出网请求(SAML SSO / metadata / OIDC discovery),
// 必须 https + 公网,防 SSRF 打内网/云 metadata(见 validate.ts publicHttpsUrlSchema)。
const createConnectionBodySchema = v.object({
  org_id: v.pipe(v.string(), v.minLength(1)),
  protocol: v.picklist(INBOUND_SSO_PROTOCOLS),
  idp_entity_id: v.optional(v.string()),
  idp_sso_url: v.optional(publicHttpsUrlSchema),
  idp_slo_url: v.optional(v.nullable(publicHttpsUrlSchema)),
  idp_metadata_url: v.optional(publicHttpsUrlSchema),
  idp_certificates: v.optional(v.array(v.string())),
  oidc_client_id: v.optional(v.string()),
  oidc_discovery_url: v.optional(publicHttpsUrlSchema),
  attribute_mapping: v.optional(attributeMappingSchema),
  role_mapping: v.optional(v.record(v.string(), v.picklist(ORGANIZATION_MEMBERSHIP_ROLES))),
  jit_enabled: v.optional(v.boolean()),
  want_authn_response_signed: v.optional(v.boolean()),
  want_assertions_signed: v.optional(v.boolean()),
  saml_clock_skew_ms: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_SAML_CLOCK_SKEW_MS)),
  ),
})

const patchConnectionBodySchema = v.object({
  idp_entity_id: v.optional(v.string()),
  idp_sso_url: v.optional(publicHttpsUrlSchema),
  idp_slo_url: v.optional(v.nullable(publicHttpsUrlSchema)),
  idp_metadata_url: v.optional(publicHttpsUrlSchema),
  idp_certificates: v.optional(v.array(v.string())),
  oidc_client_id: v.optional(v.string()),
  oidc_discovery_url: v.optional(publicHttpsUrlSchema),
  attribute_mapping: v.optional(attributeMappingSchema),
  role_mapping: v.optional(v.record(v.string(), v.picklist(ORGANIZATION_MEMBERSHIP_ROLES))),
  jit_enabled: v.optional(v.boolean()),
  want_authn_response_signed: v.optional(v.boolean()),
  want_assertions_signed: v.optional(v.boolean()),
  saml_clock_skew_ms: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_SAML_CLOCK_SKEW_MS)),
  ),
  status: v.optional(v.string()),
})

// attributeMapping 里 `_` 前缀键(_swaVault / _swaVaultEnvelope / _legacy 等)是内部配置:
// SWA vault 存信封加密的凭证材料,下发管理响应即泄露密文结构,一律剔除(写路径不受影响)。
export function stripInternalAttributeMapping(
  mapping: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(mapping).filter(([key]) => !key.startsWith('_')))
}

function toResponse(row: typeof schema.ssoConnections.$inferSelect) {
  return {
    id: row.id,
    org_id: row.orgId,
    protocol: row.protocol,
    idp_entity_id: row.idpEntityId,
    idp_sso_url: row.idpSsoUrl,
    idp_slo_url: row.idpSloUrl,
    idp_metadata_url: row.idpMetadataUrl,
    idp_certificates: row.idpCertificates,
    oidc_client_id: row.oidcClientId,
    oidc_discovery_url: row.oidcDiscoveryUrl,
    want_authn_response_signed: row.wantAuthnResponseSigned,
    want_assertions_signed: row.wantAssertionsSigned,
    saml_clock_skew_ms: row.samlClockSkewMs,
    attribute_mapping: stripInternalAttributeMapping(row.attributeMapping),
    trusted_proxy_secret_configured: trustedProxySecretConfigured(row.attributeMapping),
    role_mapping: row.roleMapping,
    jit_enabled: row.jitEnabled,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

// GET /v1/connections
app.get('/', async (c) => {
  await requireApiKey(c, 'connections:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const { limit, cursor } = parsePagination(c)
  const orgId = c.req.query('org_id')
  const active = eq(schema.ssoConnections.status, 'active')
  const after = idAfterCursor(schema.ssoConnections.id, cursor)
  const filters = orgId ? [eq(schema.ssoConnections.orgId, orgId), active] : [active]
  if (after) filters.push(after)
  const rows = await db.ssoConnections.findMany(and(...filters), {
    orderBy: asc(schema.ssoConnections.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toResponse), (r) => r.id, limit))
})

// POST /v1/connections
app.post('/', async (c) => {
  await requireApiKey(c, 'connections:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createConnectionBodySchema, json.value)

  const orgId = body.org_id
  const protocol = body.protocol
  const attributeMapping = await prepareLegacyAttributeMapping(
    protocol,
    body.attribute_mapping ?? {},
  )

  // org_id 必须属于当前 TenantContext 的 tenant(requireOrg 走查询层注入 tenant_id;跨租户/不存在 -> 404)。
  await requireOrg(c, orgId)

  // 每 org 只允许一条 SSO 连接(唯一约束 sso_connections_org_unq)。
  const existing = await db.ssoConnections.findOne(eq(schema.ssoConnections.orgId, orgId))
  if (existing && existing.status === 'deleted') {
    const updated = await db.ssoConnections.update(
      {
        protocol,
        idpEntityId: body.idp_entity_id,
        idpSsoUrl: body.idp_sso_url,
        idpSloUrl: body.idp_slo_url,
        idpMetadataUrl: body.idp_metadata_url,
        idpCertificates: body.idp_certificates ?? [],
        oidcClientId: body.oidc_client_id,
        oidcDiscoveryUrl: body.oidc_discovery_url,
        attributeMapping,
        roleMapping: body.role_mapping ?? {},
        jitEnabled: body.jit_enabled !== false,
        wantAuthnResponseSigned: body.want_authn_response_signed ?? true,
        wantAssertionsSigned: body.want_assertions_signed ?? true,
        samlClockSkewMs: body.saml_clock_skew_ms ?? DEFAULT_SAML_CLOCK_SKEW_MS,
        status: 'active',
      },
      eq(schema.ssoConnections.id, existing.id),
    )
    return c.json(toResponse(updated[0]!), 201)
  }
  if (existing)
    throw new AppError('already_exists', { longMessage: 'org already has a SSO connection' })

  const row = await db.ssoConnections.insert({
    id: createPersistedId('ssoConnection'),
    tenantId: tenant.tenantId,
    orgId,
    protocol,
    idpEntityId: body.idp_entity_id,
    idpSsoUrl: body.idp_sso_url,
    idpSloUrl: body.idp_slo_url,
    idpMetadataUrl: body.idp_metadata_url,
    idpCertificates: body.idp_certificates ?? [],
    oidcClientId: body.oidc_client_id,
    oidcDiscoveryUrl: body.oidc_discovery_url,
    attributeMapping,
    roleMapping: body.role_mapping ?? {},
    jitEnabled: body.jit_enabled !== false,
    wantAuthnResponseSigned: body.want_authn_response_signed ?? true,
    wantAssertionsSigned: body.want_assertions_signed ?? true,
    samlClockSkewMs: body.saml_clock_skew_ms ?? DEFAULT_SAML_CLOCK_SKEW_MS,
    status: 'active',
  })

  return c.json(toResponse(row), 201)
})

// GET /v1/connections/:id
app.get('/:id', async (c) => {
  await requireApiKey(c, 'connections:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const row = await db.ssoConnections.findOne(
    and(
      eq(schema.ssoConnections.id, c.req.param('id')),
      eq(schema.ssoConnections.status, 'active'),
    ),
  )
  if (!row) throw new AppError('not_found')
  return c.json(toResponse(row))
})

// PATCH /v1/connections/:id
app.patch('/:id', async (c) => {
  await requireApiKey(c, 'connections:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchConnectionBodySchema, json.value)
  const where = and(
    eq(schema.ssoConnections.id, c.req.param('id')),
    eq(schema.ssoConnections.status, 'active'),
  )
  const existing = await db.ssoConnections.findOne(where)
  if (!existing) throw new AppError('not_found')

  const patch: Partial<typeof schema.ssoConnections.$inferInsert> = {}
  if (body.idp_entity_id !== undefined) patch.idpEntityId = body.idp_entity_id
  if (body.idp_sso_url !== undefined) patch.idpSsoUrl = body.idp_sso_url
  if (body.idp_slo_url !== undefined) patch.idpSloUrl = body.idp_slo_url
  if (body.idp_metadata_url !== undefined) patch.idpMetadataUrl = body.idp_metadata_url
  if (body.idp_certificates !== undefined) patch.idpCertificates = body.idp_certificates
  if (body.oidc_client_id !== undefined) patch.oidcClientId = body.oidc_client_id
  if (body.oidc_discovery_url !== undefined) patch.oidcDiscoveryUrl = body.oidc_discovery_url
  if (body.attribute_mapping !== undefined) {
    patch.attributeMapping = await prepareLegacyAttributeMapping(
      existing.protocol,
      body.attribute_mapping,
      existing.attributeMapping,
    )
  }
  if (body.role_mapping !== undefined) patch.roleMapping = body.role_mapping
  if (body.jit_enabled !== undefined) patch.jitEnabled = body.jit_enabled
  if (body.want_authn_response_signed !== undefined)
    patch.wantAuthnResponseSigned = body.want_authn_response_signed
  if (body.want_assertions_signed !== undefined)
    patch.wantAssertionsSigned = body.want_assertions_signed
  if (body.saml_clock_skew_ms !== undefined) patch.samlClockSkewMs = body.saml_clock_skew_ms
  if (body.status !== undefined) patch.status = body.status

  const updated = await db.ssoConnections.update(patch, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  return c.json(toResponse(row))
})

// DELETE /v1/connections/:id
app.delete('/:id', async (c) => {
  await requireApiKey(c, 'connections:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(
    eq(schema.ssoConnections.id, c.req.param('id')),
    eq(schema.ssoConnections.status, 'active'),
  )
  const existing = await db.ssoConnections.findOne(where)
  if (!existing) throw new AppError('not_found')
  await db.ssoConnections.update({ status: 'deleted' }, where)
  return new Response(null, { status: 204 })
})

// POST /v1/connections/:id/restore
app.post('/:id/restore', async (c) => {
  await requireApiKey(c, 'connections:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(
    eq(schema.ssoConnections.id, c.req.param('id')),
    eq(schema.ssoConnections.status, 'deleted'),
  )
  const existing = await db.ssoConnections.findOne(where)
  if (!existing) throw new AppError('not_found')
  const updated = await db.ssoConnections.update({ status: 'active' }, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  return c.json(toResponse(row))
})

export function registerConnections(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/connections', app)
}
