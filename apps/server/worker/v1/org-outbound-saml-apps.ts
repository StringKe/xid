// /v1/organizations/:id/outbound-saml-apps:XID 作为 SAML IdP 为下游 SaaS 签发断言的应用配置。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt } from 'drizzle-orm'
import type { Hono } from 'hono'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { assignmentGateFromBody, withAssignmentGate } from '../sso/assignment-gate'
import { assertNoTemplatePlaceholders, internalMappingKeys } from '../sso/config-input'
import {
  OUTBOUND_SAAS_PRESETS,
  withPresetAttributeMapping,
  type OutboundSaasPresetKey,
} from '../sso/provider-presets'
import { resolveOrProvisionOutboundSamlSigningCertificate } from '../sso/signing-certificate'
import { importSpMetadata } from '../sso/sp-metadata'
import { outboundLastSignIns, outboundSigningCertificates } from './org-auth-insights'
import {
  assertOutboundInput,
  assertOutboundSloConfiguration,
  assertValidOutboundSpCertificates,
  createOutboundSamlAppBodySchema,
  patchOutboundSamlAppBodySchema,
  toConsoleOutboundSamlApp,
} from './org-outbound-saml-input'
import { assertOptionalPublicHttpsUrl } from './org-policy-fields'
import { assertOrgSelfServiceEditable } from './org-self-service'
import { ORG_LIST_BATCH_SIZE, auditOrgMutation, readAllById } from './org-shared'
import { emitWebhookAsync, requireApiKeyOrOrgManager, requireOrg } from './shared'

export function registerOrgOutboundSamlAppRoutes(app: Hono<XidHonoEnv>): void {
  // GET /v1/organizations/:id/outbound-saml-apps
  app.get('/:id/outbound-saml-apps', async (c) => {
    const id = c.req.param('id')
    await requireApiKeyOrOrgManager(c, id, 'connections:read')
    const tenant = c.get('tenant')
    const db = createTenantDb(c.env.DB, tenant)
    const rows = await readAllById((cursor) =>
      db.samlServiceProviders.findMany(
        cursor
          ? and(
              eq(schema.samlServiceProviders.orgId, id),
              gt(schema.samlServiceProviders.id, cursor),
            )
          : eq(schema.samlServiceProviders.orgId, id),
        { orderBy: asc(schema.samlServiceProviders.id), limit: ORG_LIST_BATCH_SIZE },
      ),
    )
    const [lastSignIns, signingCertificates] = await Promise.all([
      outboundLastSignIns(
        c,
        rows.map((row) => row.id),
      ),
      rows.length === 0 ? Promise.resolve([]) : outboundSigningCertificates(c),
    ])
    return c.json(
      rows.map((row) => ({
        ...toConsoleOutboundSamlApp(c.get('tenant'), row),
        lastSignInAt: lastSignIns.get(row.id) ?? null,
        signingCertificates,
      })),
    )
  })

  // POST /v1/organizations/:id/outbound-saml-apps
  app.post('/:id/outbound-saml-apps', async (c) => {
    const id = c.req.param('id')
    const auth = await requireApiKeyOrOrgManager(c, id, 'connections:write')
    await assertOrgSelfServiceEditable(c, auth, await requireOrg(c, id))
    const tenant = c.get('tenant')
    const db = createTenantDb(c.env.DB, tenant)
    const json = await readJsonBody(c)
    if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
    const body = validateBody(createOutboundSamlAppBodySchema, json.value)
    const presetKey = body.preset
    const preset = presetKey ? OUTBOUND_SAAS_PRESETS[presetKey as OutboundSaasPresetKey] : undefined
    if (presetKey !== undefined && !preset) {
      throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'preset' } })
    }
    assertOutboundInput(body)
    const imported = await importSpMetadata({
      url: body.sp_metadata_url,
      xml: body.sp_metadata_xml,
    })
    // 预设的 Entity ID 是模板,只有管理员给出真实值或 metadata 时才能保存。
    const spEntityId = body.sp_entity_id ?? imported?.entityId ?? preset?.spEntityId
    assertNoTemplatePlaceholders({ sp_entity_id: spEntityId })
    if (!spEntityId) {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'sp_entity_id' },
      })
    }
    const acsUrl = body.acs_url ?? imported?.acsUrl
    if (!acsUrl) {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'acs_url' },
      })
    }
    const sloUrl =
      body.slo_url !== undefined ? body.slo_url : (imported?.sloUrl ?? preset?.sloUrl ?? null)
    const spCertificates = body.sp_certificates ?? imported?.certificates ?? []
    assertOptionalPublicHttpsUrl(acsUrl, 'acs_url')
    assertOptionalPublicHttpsUrl(sloUrl, 'slo_url')
    await assertValidOutboundSpCertificates(spCertificates)
    assertOutboundSloConfiguration(sloUrl, spCertificates)
    const signingCertificate = await resolveOrProvisionOutboundSamlSigningCertificate(
      c,
      body.idp_signing_cert_id ?? undefined,
    )
    let attributeMapping: Record<string, unknown> =
      body.attribute_mapping ??
      (preset ? withPresetAttributeMapping(preset.key, preset.attributeMapping) : {})
    const gate = assignmentGateFromBody(body)
    if (gate) attributeMapping = withAssignmentGate(attributeMapping, gate)
    const row = await db.samlServiceProviders.insert({
      id: createPersistedId('samlServiceProvider'),
      tenantId: tenant.tenantId,
      orgId: id,
      spEntityId,
      acsUrl,
      sloUrl,
      sloBinding: body.slo_binding ?? imported?.sloBinding ?? 'redirect',
      spCertificates,
      attributeMapping,
      nameIdFormat:
        body.name_id_format ??
        preset?.nameIdFormat ??
        'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      idpSigningCertId: signingCertificate.id,
    })
    emitWebhookAsync(c, {
      tenantId: tenant.tenantId,
      event: 'organization.outbound_saml_app.created',
      payload: { orgId: id, appId: row.id, preset: presetKey ?? null },
    })
    auditOrgMutation(c, auth, {
      action: 'outbound_saml_app.created',
      orgId: id,
      targetType: 'outbound_saml_app',
      targetId: row.id,
    })
    return c.json(toConsoleOutboundSamlApp(c.get('tenant'), row), 201)
  })

  // PATCH /v1/organizations/:id/outbound-saml-apps/:appId
  app.patch('/:id/outbound-saml-apps/:appId', async (c) => {
    const id = c.req.param('id')
    const appId = c.req.param('appId')
    const auth = await requireApiKeyOrOrgManager(c, id, 'connections:write')
    await assertOrgSelfServiceEditable(c, auth, await requireOrg(c, id))
    const tenant = c.get('tenant')
    const db = createTenantDb(c.env.DB, tenant)
    const json = await readJsonBody(c)
    if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
    const body = validateBody(patchOutboundSamlAppBodySchema, json.value)
    const where = and(
      eq(schema.samlServiceProviders.id, appId),
      eq(schema.samlServiceProviders.tenantId, tenant.tenantId),
      eq(schema.samlServiceProviders.orgId, id),
    )
    const existing = await db.samlServiceProviders.findOne(where)
    if (!existing) throw new AppError('not_found', { httpStatus: 404 })
    assertOutboundInput(body)
    const imported = await importSpMetadata({
      url: body.sp_metadata_url,
      xml: body.sp_metadata_xml,
    })
    const metadataFields = imported
      ? {
          sp_entity_id: body.sp_entity_id ?? imported.entityId,
          acs_url: body.acs_url ?? imported.acsUrl,
          slo_url: body.slo_url !== undefined ? body.slo_url : imported.sloUrl,
          slo_binding: body.slo_binding ?? imported.sloBinding,
          sp_certificates: body.sp_certificates ?? imported.certificates,
        }
      : {}
    Object.assign(body, metadataFields)
    const nextSloUrl = body.slo_url === undefined ? existing.sloUrl : body.slo_url
    const nextSpCertificates = body.sp_certificates ?? existing.spCertificates ?? []
    if (body.sp_certificates !== undefined || nextSloUrl) {
      await assertValidOutboundSpCertificates(nextSpCertificates)
    }
    assertOutboundSloConfiguration(nextSloUrl, nextSpCertificates)
    const requestedSigningCertificateId =
      body.idp_signing_cert_id === undefined
        ? (existing.idpSigningCertId ?? undefined)
        : (body.idp_signing_cert_id ?? undefined)
    const signingCertificate = await resolveOrProvisionOutboundSamlSigningCertificate(
      c,
      requestedSigningCertificateId,
    )
    const patch: Partial<typeof schema.samlServiceProviders.$inferInsert> = {}
    if (body.sp_entity_id !== undefined) patch.spEntityId = body.sp_entity_id
    if (body.acs_url !== undefined) patch.acsUrl = body.acs_url
    if (body.slo_url !== undefined) patch.sloUrl = body.slo_url
    if (body.slo_binding !== undefined) patch.sloBinding = body.slo_binding
    if (body.sp_certificates !== undefined) patch.spCertificates = body.sp_certificates
    if (body.name_id_format !== undefined) patch.nameIdFormat = body.name_id_format
    if (signingCertificate.id !== existing.idpSigningCertId) {
      patch.idpSigningCertId = signingCertificate.id
    }
    const gate = assignmentGateFromBody(body)
    if (body.attribute_mapping !== undefined) {
      // 预设标记与分配门槛存于 `_` 前缀内部键,只由服务端维护,回写时沿用已有值。
      patch.attributeMapping = {
        ...internalMappingKeys(existing.attributeMapping),
        ...body.attribute_mapping,
      }
    }
    if (gate) {
      const base = (patch.attributeMapping ?? existing.attributeMapping) as Record<string, unknown>
      patch.attributeMapping = withAssignmentGate(base, gate)
    }
    const updated = await db.samlServiceProviders.update(patch, where)
    const row = updated[0]
    if (!row) throw new AppError('not_found', { httpStatus: 404 })
    auditOrgMutation(c, auth, {
      action: 'outbound_saml_app.updated',
      orgId: id,
      targetType: 'outbound_saml_app',
      targetId: row.id,
      details: { fields: Object.keys(patch) },
    })
    return c.json(toConsoleOutboundSamlApp(c.get('tenant'), row))
  })

  // DELETE /v1/organizations/:id/outbound-saml-apps/:appId
  app.delete('/:id/outbound-saml-apps/:appId', async (c) => {
    const id = c.req.param('id')
    const appId = c.req.param('appId')
    const auth = await requireApiKeyOrOrgManager(c, id, 'connections:write')
    await assertOrgSelfServiceEditable(c, auth, await requireOrg(c, id))
    const tenant = c.get('tenant')
    const db = createTenantDb(c.env.DB, tenant)
    const where = and(
      eq(schema.samlServiceProviders.id, appId),
      eq(schema.samlServiceProviders.tenantId, tenant.tenantId),
      eq(schema.samlServiceProviders.orgId, id),
    )
    const existing = await db.samlServiceProviders.findOne(where)
    if (!existing) throw new AppError('not_found', { httpStatus: 404 })
    await db.samlServiceProviders.hardDelete(where)
    emitWebhookAsync(c, {
      tenantId: tenant.tenantId,
      event: 'organization.outbound_saml_app.deleted',
      payload: { orgId: id, appId },
    })
    auditOrgMutation(c, auth, {
      action: 'outbound_saml_app.deleted',
      orgId: id,
      targetType: 'outbound_saml_app',
      targetId: appId,
    })
    return new Response(null, { status: 204 })
  })
}
