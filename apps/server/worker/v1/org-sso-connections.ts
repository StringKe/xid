// /v1/organizations/:id/sso-connections:组织的入站企业 SSO 连接(一个组织一条)。

import { createTenantDb, schema } from '@xid-kit/db'
import { DEFAULT_SAML_CLOCK_SKEW_MS, MAX_SAML_CLOCK_SKEW_MS } from '@xid-kit/saml'
import { ORGANIZATION_MEMBERSHIP_ROLES } from '@xid-kit/types'
import { and, asc, eq, gt } from 'drizzle-orm'
import type { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { publicHttpsUrlSchema, readJsonBody, validateBody } from '../lib/validate'
import { internalMappingKeys } from '../sso/config-input'
import {
  assertConnectionInput,
  idpMetadataXmlSchema,
  relayStatePatch,
  relayStateUrlSchema,
  samlMetadataPatch,
} from '../sso/connection-input'
import {
  assertHeaderConnectionConfig,
  assertInboundSsoProtocol,
  isLegacySsoProtocol,
  prepareLegacyAttributeMapping,
} from '../sso/legacy-shared'
import { oidcClientSecretInputSchema, oidcClientSecretPatch } from '../sso/oidc-client-secret'
import {
  INBOUND_IDP_PRESETS,
  LEGACY_INBOUND_PRESETS,
  withPresetAttributeMapping,
  type InboundIdpPresetKey,
  type LegacyInboundPresetKey,
} from '../sso/provider-presets'
import { parseCertificates, ssoConnectionInsights } from './org-auth-insights'
import { assertOrgSelfServiceEditable } from './org-self-service'
import { ORG_LIST_BATCH_SIZE, auditOrgMutation, readAllById } from './org-shared'
import { toConsoleSsoConnection } from './org-sso-connection-view'
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
  idp_metadata_xml: v.optional(idpMetadataXmlSchema),
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
  relay_state_url: v.optional(relayStateUrlSchema),
})

const patchSsoConnectionBodySchema = v.object({
  display_name: v.optional(v.nullable(ssoConnectionDisplayNameSchema)),
  idp_entity_id: v.optional(v.string()),
  idp_sso_url: v.optional(publicHttpsUrlSchema),
  idp_slo_url: v.optional(v.nullable(publicHttpsUrlSchema)),
  idp_metadata_url: v.optional(publicHttpsUrlSchema),
  idp_metadata_xml: v.optional(idpMetadataXmlSchema),
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
  relay_state_url: v.optional(relayStateUrlSchema),
})

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
    if (presetKey !== undefined && !preset && !legacyPreset) {
      throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'preset' } })
    }
    const protocolRaw = body.protocol ?? legacyPreset?.protocol ?? preset?.protocol
    if (!protocolRaw) {
      throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'protocol' } })
    }
    const protocol = assertInboundSsoProtocol(protocolRaw)
    // 入站预设只有 SAML 一种;OIDC 连接走通用 discovery,不套用 SAML 属性名。
    const samlPreset = protocol === 'saml' ? preset : undefined
    if (preset && !samlPreset) {
      throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'protocol' } })
    }
    if (legacyPreset && legacyPreset.protocol !== protocol) {
      throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'protocol' } })
    }
    assertConnectionInput(body)
    const existing = await db.forOrg(id).ssoConnections.findOne()
    if (existing && existing.status !== 'deleted') {
      throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'protocol' } })
    }
    const requestedMapping =
      body.attribute_mapping ??
      (legacyPreset
        ? { ...legacyPreset.attributeMapping, _xidPreset: legacyPreset.key }
        : samlPreset
          ? withPresetAttributeMapping(samlPreset.key, samlPreset.attributeMapping)
          : {})
    const attributeMapping = isLegacySsoProtocol(protocol)
      ? await prepareLegacyAttributeMapping(protocol, requestedMapping, null, c.env)
      : requestedMapping
    assertHeaderConnectionConfig(protocol, attributeMapping)
    const roleMapping =
      body.role_mapping ??
      (legacyPreset ? legacyPreset.roleMapping : samlPreset ? samlPreset.roleMapping : {})
    const patch = {
      protocol,
      displayName: body.display_name ?? preset?.displayName ?? legacyPreset?.displayName ?? null,
      idpEntityId: body.idp_entity_id,
      idpSsoUrl: body.idp_sso_url,
      idpSloUrl: body.idp_slo_url,
      idpMetadataUrl: body.idp_metadata_url,
      idpCertificates: body.idp_certificates ?? [],
      ...(await samlMetadataPatch(protocol, body)),
      oidcClientId: body.oidc_client_id,
      oidcDiscoveryUrl: body.oidc_discovery_url,
      oidcClientSecretCiphertext: null,
      ...(await oidcClientSecretPatch(c.env, body.oidc_client_secret)),
      attributeMapping,
      roleMapping,
      jitEnabled: body.jit_enabled ?? legacyPreset?.jitEnabled ?? preset?.jitEnabled ?? true,
      wantAuthnResponseSigned:
        body.want_authn_response_signed ?? samlPreset?.wantAuthnResponseSigned,
      wantAssertionsSigned: body.want_assertions_signed ?? samlPreset?.wantAssertionsSigned,
      samlClockSkewMs: body.saml_clock_skew_ms ?? DEFAULT_SAML_CLOCK_SKEW_MS,
      relayStateUrl: relayStatePatch(tenant.issuer, body).relayStateUrl ?? null,
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
    assertConnectionInput(body)

    const patch: Partial<typeof schema.ssoConnections.$inferInsert> = {}
    if (body.display_name !== undefined) patch.displayName = body.display_name
    if (body.idp_entity_id !== undefined) patch.idpEntityId = body.idp_entity_id
    if (body.idp_sso_url !== undefined) patch.idpSsoUrl = body.idp_sso_url
    if (body.idp_slo_url !== undefined) patch.idpSloUrl = body.idp_slo_url
    if (body.idp_metadata_url !== undefined) patch.idpMetadataUrl = body.idp_metadata_url
    if (body.idp_certificates !== undefined) patch.idpCertificates = body.idp_certificates
    if (body.oidc_client_id !== undefined) patch.oidcClientId = body.oidc_client_id
    if (body.oidc_discovery_url !== undefined) patch.oidcDiscoveryUrl = body.oidc_discovery_url
    Object.assign(patch, await samlMetadataPatch(existing.protocol, body))
    if (patch.idpCertificates !== undefined) patch.idpCertificateRetirements = null
    Object.assign(patch, relayStatePatch(tenant.issuer, body))
    Object.assign(patch, await oidcClientSecretPatch(c.env, body.oidc_client_secret))
    if (body.attribute_mapping !== undefined) {
      // 响应剔除了 `_` 前缀的内部键,回写时保留服务端已有的内部键,请求里的 `_legacy` 覆盖旧值。
      const merged = {
        ...internalMappingKeys(existing.attributeMapping),
        ...body.attribute_mapping,
      }
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
