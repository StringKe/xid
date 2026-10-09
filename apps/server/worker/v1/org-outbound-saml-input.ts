// 出站 SAML 应用的请求体形状与保存期校验:模板占位符、内部映射键、SP 证书与 SLO 组合、响应形状。

import type { schema } from '@xid-kit/db'
import { loadIdpVerifyKeys, setSamlEngine } from '@xid-kit/saml'
import type { TenantContext } from '@xid-kit/types'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { publicHttpsUrlSchema } from '../lib/validate'
import { parseAssignmentGate, serializeAssignmentGate } from '../sso/assignment-gate'
import { assertClientMappingKeys, assertNoTemplatePlaceholders } from '../sso/config-input'
import { SAML_METADATA_MAX_BYTES } from '../sso/metadata-source'
import { outboundSamlIdpEndpoints } from '../sso/outbound-saml'
import { OUTBOUND_SAML_NAME_ID_FORMATS } from '../sso/outbound-saml-name-id'
import { presetKeyFromAttributeMapping } from '../sso/provider-presets'
import { toIso } from './org-shared'

const metadataRecordSchema = v.record(v.string(), v.unknown())
// assignment_gate 的字段级校验在 assignmentGateFromBody(paramName 契约已固定),schema 只放行键存在性。
const assignmentGateFieldSchema = v.optional(v.unknown())
const outboundSamlCertificatesSchema = v.pipe(
  v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(64 * 1024))),
  v.maxLength(10),
)
const outboundSloBindingSchema = v.picklist(['redirect', 'post'])
const nameIdFormatSchema = v.picklist(OUTBOUND_SAML_NAME_ID_FORMATS)
const spMetadataXmlSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(SAML_METADATA_MAX_BYTES))

const outboundSamlAppFields = {
  sp_metadata_url: v.optional(publicHttpsUrlSchema),
  sp_metadata_xml: v.optional(spMetadataXmlSchema),
  sp_entity_id: v.optional(v.string()),
  acs_url: v.optional(publicHttpsUrlSchema),
  slo_url: v.optional(v.nullable(publicHttpsUrlSchema)),
  slo_binding: v.optional(outboundSloBindingSchema),
  sp_certificates: v.optional(outboundSamlCertificatesSchema),
  name_id_format: v.optional(nameIdFormatSchema),
  idp_signing_cert_id: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
  attribute_mapping: v.optional(metadataRecordSchema),
  assignment_gate: assignmentGateFieldSchema,
  assignmentGate: assignmentGateFieldSchema,
}

export const createOutboundSamlAppBodySchema = v.object({
  preset: v.optional(v.string()),
  ...outboundSamlAppFields,
})

export const patchOutboundSamlAppBodySchema = v.object(outboundSamlAppFields)

type OutboundInput = {
  sp_entity_id?: string | undefined
  acs_url?: string | undefined
  slo_url?: string | null | undefined
  attribute_mapping?: Record<string, unknown> | undefined
}

// 预设标记与分配门槛是服务端写入的内部键,客户端不能直接提交任何 `_` 前缀键。
export function assertOutboundInput(body: OutboundInput): void {
  assertNoTemplatePlaceholders({
    sp_entity_id: body.sp_entity_id,
    acs_url: body.acs_url,
    slo_url: body.slo_url,
  })
  assertClientMappingKeys(body.attribute_mapping, [])
}

export async function assertValidOutboundSpCertificates(
  certificates: readonly string[],
): Promise<void> {
  if (certificates.length === 0) return
  setSamlEngine(globalThis.crypto)
  const verified = await loadIdpVerifyKeys(certificates)
  if (!verified.ok) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'sp_certificates' },
    })
  }
}

export function assertOutboundSloConfiguration(
  sloUrl: string | null | undefined,
  certificates: readonly string[],
): void {
  if (sloUrl && certificates.length === 0) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'sp_certificates' },
    })
  }
}

export function toConsoleOutboundSamlApp(
  tenant: TenantContext,
  row: typeof schema.samlServiceProviders.$inferSelect,
) {
  const mapping = row.attributeMapping as Record<string, unknown>
  const gate = parseAssignmentGate(mapping)
  const idp = outboundSamlIdpEndpoints(tenant.issuer, row.id)
  return {
    id: row.id,
    provider: presetKeyFromAttributeMapping(mapping) ?? 'custom',
    spEntityId: row.spEntityId,
    acsUrl: row.acsUrl,
    sloUrl: row.sloUrl,
    sloBinding: row.sloBinding ?? 'redirect',
    spCertificates: row.spCertificates ?? [],
    idpSigningCertId: row.idpSigningCertId,
    attributeMapping: mapping,
    assignmentGate: serializeAssignmentGate(gate),
    nameIdFormat: row.nameIdFormat,
    idpEntityId: idp.entityId,
    idpMetadataUrl: idp.metadataUrl,
    idpSsoUrl: idp.ssoUrl,
    idpSloUrl: idp.sloUrl,
    createdAt: toIso(row.createdAt) ?? '',
  }
}
