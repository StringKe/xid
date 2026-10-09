// /v1/organizations/:id/sso-connections:组织的入站企业 SSO 连接(一个组织一条)。

import { createTenantDb, schema } from '@xid-kit/db'
import { DEFAULT_SAML_CLOCK_SKEW_MS, MAX_SAML_CLOCK_SKEW_MS } from '@xid-kit/saml'
import type { TenantContext } from '@xid-kit/types'
import { ORGANIZATION_MEMBERSHIP_ROLES } from '@xid-kit/types'
import { and, asc, eq, gt } from 'drizzle-orm'
import type { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { publicHttpsUrlSchema, readJsonBody, validateBody } from '../lib/validate'
import {
  assertHeaderConnectionConfig,
  assertInboundSsoProtocol,
  isInboundSsoProtocol,
  isLegacySsoProtocol,
  prepareLegacyAttributeMapping,
} from '../sso/legacy-shared'
import {
  oidcClientSecretConfigured,
  oidcClientSecretInputSchema,
  oidcClientSecretPatch,
} from '../sso/oidc-client-secret'
import {
  INBOUND_IDP_PRESETS,
  LEGACY_INBOUND_PRESETS,
  inboundPresetDisplayName,
  presetKeyFromAttributeMapping,
  withPresetAttributeMapping,
  type InboundIdpPresetKey,
  type LegacyInboundPresetKey,
} from '../sso/provider-presets'
import { acsUrl, sloUrl, spEntityId } from '../sso/saml-connection'
import { parseCertificates, ssoConnectionInsights } from './org-auth-insights'
import { assertOptionalPublicHttpsUrl } from './org-policy-fields'
import { assertOrgSelfServiceEditable } from './org-self-service'
import { ORG_LIST_BATCH_SIZE, auditOrgMutation, readAllById, toIso } from './org-shared'
import { requireApiKeyOrOrgManager, requireOrg } from './shared'

const metadataRecordSchema = v.record(v.string(), v.unknown())
const organizationRoleMappingSchema = v.record(
  v.string(),
  v.picklist(ORGANIZATION_MEMBERSHIP_ROLES),
)

const ssoConnectionDisplayNameSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(100),
)

const createSsoConnectionBodySchema = v.object({
  preset: v.optional(v.string()),
  protocol: v.optional(v.string()),
  display_name: v.optional(ssoConnectionDisplayNameSchema),
  idp_entity_id: v.optional(v.string()),
  idp_sso_url: v.optional(publicHttpsUrlSchema),
  idp_slo_url: v.optional(v.nullable(publicHttpsUrlSchema)),
  idp_metadata_url: v.optional(publicHttpsUrlSchema),
  idp_certificates: v.optional(v.array(v.string())),
  oidc_client_id: v.optional(v.string()),
  oidc_client_secret: oidcClientSecretInputSchema,
  oidc_discovery_url: v.optional(publicHttpsUrlSchema),
  jit_enabled: v.optional(v.boolean()),
  attribute_mapping: v.optional(metadataRecordSchema),
  role_mapping: v.optional(organizationRoleMappingSchema),
  want_authn_response_signed: v.optional(v.boolean()),
  want_assertions_signed: v.optional(v.boolean()),
  saml_clock_skew_ms: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_SAML_CLOCK_SKEW_MS)),
  ),
})

const patchSsoConnectionBodySchema = v.object({
  display_name: v.optional(v.nullable(ssoConnectionDisplayNameSchema)),
  idp_entity_id: v.optional(v.string()),
  idp_sso_url: v.optional(publicHttpsUrlSchema),
  idp_slo_url: v.optional(v.nullable(publicHttpsUrlSchema)),
  idp_metadata_url: v.optional(publicHttpsUrlSchema),
  idp_certificates: v.optional(v.array(v.string())),
  oidc_client_id: v.optional(v.string()),
  oidc_client_secret: oidcClientSecretInputSchema,
  oidc_discovery_url: v.optional(publicHttpsUrlSchema),
  jit_enabled: v.optional(v.boolean()),
  attribute_mapping: v.optional(metadataRecordSchema),
  role_mapping: v.optional(organizationRoleMappingSchema),
  want_authn_response_signed: v.optional(v.boolean()),
  want_assertions_signed: v.optional(v.boolean()),
  saml_clock_skew_ms: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_SAML_CLOCK_SKEW_MS)),
  ),
})

// IdP 侧要填写的本端地址。OIDC callback 跟随用户发起登录的 origin(oidc-rp.ts),
// 因此列出实例 issuer、租户主机和 Hosted Auth origin,管理员需要全部登记到 IdP。
function ssoServiceProviderEndpoints(
  tenant: TenantContext,
  row: typeof schema.ssoConnections.$inferSelect,
) {
  if (row.protocol === 'saml') {
    return {
      sp_entity_id: spEntityId(tenant, row.id),
      acs_url: acsUrl(tenant, row.id),
      sp_metadata_url: `${tenant.issuer}/sso/saml/${row.id}/metadata`,
      slo_url: sloUrl(tenant, row.id),
    }
  }
  if (row.protocol !== 'oidc') return {}
  const origins = new Set([
    new URL(tenant.issuer).origin,
    `https://${tenant.rpId}`,
    ...(tenant.hostedAuthOrigin ? [new URL(tenant.hostedAuthOrigin).origin] : []),
  ])
  return {
    oidc_callback_urls: [...origins].map((origin) => `${origin}/sso/oidc/${row.id}/callback`),
  }
}

function toConsoleSsoConnection(
  tenant: TenantContext,
  row: typeof schema.ssoConnections.$inferSelect,
) {
  // attributeMapping 里 `_` 前缀键(_swaVault / _swaVaultEnvelope)存 SWA vault 信封加密的凭证材料,
  // 与 v1/connections.ts stripInternalAttributeMapping 同一约定:响应一律剔除,写路径不受影响。
  const attributeMapping = Object.fromEntries(
    Object.entries(row.attributeMapping).filter(([key]) => !key.startsWith('_')),
  )
  const presetName = inboundPresetDisplayName(presetKeyFromAttributeMapping(row.attributeMapping))
  return {
    id: row.id,
    name:
      row.displayName ??
      presetName ??
      row.idpEntityId ??
      row.oidcDiscoveryUrl ??
      row.protocol.toUpperCase(),
    display_name: row.displayName,
    type: isInboundSsoProtocol(row.protocol) ? row.protocol : 'saml',
    domain: row.idpSsoUrl ?? row.oidcDiscoveryUrl ?? '',
    idp_entity_id: row.idpEntityId,
    idp_sso_url: row.idpSsoUrl,
    idp_slo_url: row.idpSloUrl,
    idp_metadata_url: row.idpMetadataUrl,
    idp_certificates: row.idpCertificates,
    oidc_client_id: row.oidcClientId,
    oidc_discovery_url: row.oidcDiscoveryUrl,
    oidc_client_secret_configured: oidcClientSecretConfigured(row),
    want_authn_response_signed: row.wantAuthnResponseSigned,
    want_assertions_signed: row.wantAssertionsSigned,
    saml_clock_skew_ms: row.samlClockSkewMs,
    attribute_mapping: attributeMapping,
    role_mapping: row.roleMapping,
    jit_enabled: row.jitEnabled,
    status: row.status === 'active' ? 'active' : 'inactive',
    ...ssoServiceProviderEndpoints(tenant, row),
    createdAt: toIso(row.createdAt) ?? '',
  }
}

export function registerOrgSsoConnectionRoutes(app: Hono<XidHonoEnv>): void {
  // GET /v1/organizations/:id/sso-connections
  app.get('/:id/sso-connections', async (c) => {
    const id = c.req.param('id')
    await requireApiKeyOrOrgManager(c, id, 'connections:read')
    const db = createTenantDb(c.env.DB, c.get('tenant'))
    const rows = await readAllById((cursor) =>
      db
        .forOrg(id)
        .ssoConnections.findMany(
          cursor
            ? and(eq(schema.ssoConnections.status, 'active'), gt(schema.ssoConnections.id, cursor))
            : eq(schema.ssoConnections.status, 'active'),
          { orderBy: asc(schema.ssoConnections.id), limit: ORG_LIST_BATCH_SIZE },
        ),
    )
    const insights = await ssoConnectionInsights(
      c,
      id,
      rows.map((row) => row.id),
    )
    const data = await Promise.all(
      rows.map(async (row) => ({
        ...toConsoleSsoConnection(c.get('tenant'), row),
        idpCertificates: await parseCertificates(row.idpCertificates),
        lastSignInAt: insights.lastSignInAt.get(row.id) ?? null,
        routedDomains: insights.routedDomains,
      })),
    )
    return c.json(data)
  })

  // POST /v1/organizations/:id/sso-connections
  app.post('/:id/sso-connections', async (c) => {
    const id = c.req.param('id')
    const auth = await requireApiKeyOrOrgManager(c, id, 'connections:write')
    await assertOrgSelfServiceEditable(c, auth, await requireOrg(c, id))
    const tenant = c.get('tenant')
    const db = createTenantDb(c.env.DB, tenant)
    const json = await readJsonBody(c)
    if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
    const body = validateBody(createSsoConnectionBodySchema, json.value)
    const presetKey = body.preset
    const preset = presetKey ? INBOUND_IDP_PRESETS[presetKey as InboundIdpPresetKey] : undefined
    const legacyPreset = presetKey
      ? LEGACY_INBOUND_PRESETS[presetKey as LegacyInboundPresetKey]
      : undefined
    const protocolRaw =
      body.protocol ??
      legacyPreset?.protocol ??
      (preset?.protocol === 'oidc' ? 'oidc' : preset ? 'saml' : undefined)
    if (!protocolRaw) {
      throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'protocol' } })
    }
    const protocol = assertInboundSsoProtocol(protocolRaw)
    const existing = await db.forOrg(id).ssoConnections.findOne()
    if (existing && existing.status !== 'deleted') {
      throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'protocol' } })
    }
    const requestedMapping =
      body.attribute_mapping ??
      (legacyPreset
        ? { ...legacyPreset.attributeMapping, _xidPreset: legacyPreset.key }
        : preset
          ? withPresetAttributeMapping(preset.key, preset.attributeMapping)
          : {})
    const attributeMapping = isLegacySsoProtocol(protocol)
      ? await prepareLegacyAttributeMapping(protocol, requestedMapping, null, c.env)
      : requestedMapping
    assertHeaderConnectionConfig(protocol, attributeMapping)
    const roleMapping =
      body.role_mapping ??
      (legacyPreset ? legacyPreset.roleMapping : preset ? preset.roleMapping : {})
    const idpSsoUrl = body.idp_sso_url ?? legacyPreset?.idpSsoUrl ?? preset?.idpSsoUrl
    const idpSloUrl = body.idp_slo_url
    const idpMetadataUrl = body.idp_metadata_url ?? preset?.idpMetadataUrl
    const oidcDiscoveryUrl = body.oidc_discovery_url ?? preset?.oidcDiscoveryUrl
    assertOptionalPublicHttpsUrl(idpSsoUrl, 'idp_sso_url')
    assertOptionalPublicHttpsUrl(idpSloUrl, 'idp_slo_url')
    assertOptionalPublicHttpsUrl(idpMetadataUrl, 'idp_metadata_url')
    assertOptionalPublicHttpsUrl(oidcDiscoveryUrl, 'oidc_discovery_url')
    const patch = {
      protocol,
      displayName: body.display_name ?? preset?.displayName ?? legacyPreset?.displayName ?? null,
      idpEntityId: body.idp_entity_id ?? preset?.idpEntityId,
      idpSsoUrl,
      idpSloUrl,
      idpMetadataUrl,
      idpCertificates: body.idp_certificates ?? [],
      oidcClientId: body.oidc_client_id,
      oidcDiscoveryUrl,
      oidcClientSecretCiphertext: null,
      ...(await oidcClientSecretPatch(c.env, body.oidc_client_secret)),
      attributeMapping,
      roleMapping,
      jitEnabled: body.jit_enabled ?? legacyPreset?.jitEnabled ?? preset?.jitEnabled ?? true,
      wantAuthnResponseSigned: body.want_authn_response_signed ?? preset?.wantAuthnResponseSigned,
      wantAssertionsSigned: body.want_assertions_signed ?? preset?.wantAssertionsSigned,
      samlClockSkewMs: body.saml_clock_skew_ms ?? DEFAULT_SAML_CLOCK_SKEW_MS,
      status: 'active',
    } satisfies Partial<typeof schema.ssoConnections.$inferInsert>
    const row =
      existing?.status === 'deleted'
        ? (
            await db.ssoConnections.update(
              { ...patch, status: 'active' },
              eq(schema.ssoConnections.id, existing.id),
            )
          )[0]
        : await db.ssoConnections.insert({
            id: createPersistedId('ssoConnection'),
            tenantId: tenant.tenantId,
            orgId: id,
            ...patch,
          })
    auditOrgMutation(c, auth, {
      action: 'sso_connection.created',
      orgId: id,
      targetType: 'sso_connection',
      targetId: row!.id,
      details: { protocol: row!.protocol },
    })
    return c.json(toConsoleSsoConnection(c.get('tenant'), row!), 201)
  })

  // PATCH /v1/organizations/:id/sso-connections/:connectionId
  app.patch('/:id/sso-connections/:connectionId', async (c) => {
    const id = c.req.param('id')
    const auth = await requireApiKeyOrOrgManager(c, id, 'connections:write')
    await assertOrgSelfServiceEditable(c, auth, await requireOrg(c, id))
    const connectionId = c.req.param('connectionId')
    const tenant = c.get('tenant')
    const db = createTenantDb(c.env.DB, tenant)
    const json = await readJsonBody(c)
    if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
    const body = validateBody(patchSsoConnectionBodySchema, json.value)
    const orgDb = db.forOrg(id)
    const where = and(
      eq(schema.ssoConnections.id, connectionId),
      eq(schema.ssoConnections.status, 'active'),
    )
    const existing = await orgDb.ssoConnections.findOne(where)
    if (!existing) throw new AppError('not_found', { httpStatus: 404 })

    const patch: Partial<typeof schema.ssoConnections.$inferInsert> = {}
    if (body.display_name !== undefined) patch.displayName = body.display_name
    if (body.idp_entity_id !== undefined) patch.idpEntityId = body.idp_entity_id
    if (body.idp_sso_url !== undefined) patch.idpSsoUrl = body.idp_sso_url
    if (body.idp_slo_url !== undefined) patch.idpSloUrl = body.idp_slo_url
    if (body.idp_metadata_url !== undefined) patch.idpMetadataUrl = body.idp_metadata_url
    if (body.idp_certificates !== undefined) patch.idpCertificates = body.idp_certificates
    if (body.oidc_client_id !== undefined) patch.oidcClientId = body.oidc_client_id
    if (body.oidc_discovery_url !== undefined) patch.oidcDiscoveryUrl = body.oidc_discovery_url
    Object.assign(patch, await oidcClientSecretPatch(c.env, body.oidc_client_secret))
    if (body.attribute_mapping !== undefined) {
      // 响应剔除了 `_` 前缀的内部键(预设标记、SWA vault 信封),回写时保留请求未带的内部键。
      const internal = Object.fromEntries(
        Object.entries(existing.attributeMapping).filter(([key]) => key.startsWith('_')),
      )
      const merged = { ...internal, ...body.attribute_mapping }
      const attributeMapping = isLegacySsoProtocol(existing.protocol)
        ? await prepareLegacyAttributeMapping(
            existing.protocol,
            merged,
            existing.attributeMapping,
            c.env,
          )
        : merged
      assertHeaderConnectionConfig(existing.protocol, attributeMapping)
      patch.attributeMapping = attributeMapping
    }
    if (body.role_mapping !== undefined) patch.roleMapping = body.role_mapping
    if (body.jit_enabled !== undefined) patch.jitEnabled = body.jit_enabled
    if (body.want_authn_response_signed !== undefined)
      patch.wantAuthnResponseSigned = body.want_authn_response_signed
    if (body.want_assertions_signed !== undefined)
      patch.wantAssertionsSigned = body.want_assertions_signed
    if (body.saml_clock_skew_ms !== undefined) patch.samlClockSkewMs = body.saml_clock_skew_ms

    const updated = await orgDb.ssoConnections.update(patch, where)
    const row = updated[0]
    if (!row) throw new AppError('not_found', { httpStatus: 404 })
    auditOrgMutation(c, auth, {
      action: 'sso_connection.updated',
      orgId: id,
      targetType: 'sso_connection',
      targetId: row.id,
      details: { fields: Object.keys(patch) },
    })
    return c.json(toConsoleSsoConnection(c.get('tenant'), row))
  })

  // DELETE /v1/organizations/:id/sso-connections/:connectionId
  app.delete('/:id/sso-connections/:connectionId', async (c) => {
    const id = c.req.param('id')
    const auth = await requireApiKeyOrOrgManager(c, id, 'connections:write')
    await assertOrgSelfServiceEditable(c, auth, await requireOrg(c, id))
    const connectionId = c.req.param('connectionId')
    const db = createTenantDb(c.env.DB, c.get('tenant'))
    const orgDb = db.forOrg(id)
    const where = and(
      eq(schema.ssoConnections.id, connectionId),
      eq(schema.ssoConnections.status, 'active'),
    )
    const existing = await orgDb.ssoConnections.findOne(where)
    if (!existing) throw new AppError('not_found', { httpStatus: 404 })
    await orgDb.ssoConnections.update({ status: 'deleted' }, where)
    auditOrgMutation(c, auth, {
      action: 'sso_connection.deleted',
      orgId: id,
      targetType: 'sso_connection',
      targetId: existing.id,
    })
    return new Response(null, { status: 204 })
  })
}
