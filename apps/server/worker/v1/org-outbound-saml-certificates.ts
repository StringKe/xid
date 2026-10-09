// /v1/organizations/:id/outbound-saml-signing-certificates:出站 SAML IdP 签名证书的查看、准备和显式切换。
// 证书属于租户,所有出站 SAML 应用共用;准备和切换只允许租户顶层组织的管理者执行。

import { Hono } from 'hono'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import {
  activateNextOutboundSamlSigningCertificate,
  listOutboundSamlSigningCertificates,
} from '../sso/outbound-saml-certificate-rotation'
import { certificateCommonName, insertOutboundSamlCertificate } from '../sso/signing-certificate'
import type { CertRow } from '../sso/signing-certificate'
import { assertOrgSelfServiceEditable } from './org-self-service'
import { auditOrgMutation, toIso } from './org-shared'
import { requireApiKeyOrOrgManager, requireOrg, type OrgScopedAuth } from './shared'

const app = new Hono<XidHonoEnv>()

function toCertificateResponse(row: CertRow) {
  return {
    id: row.id,
    status: row.status,
    notBefore: toIso(row.notBefore),
    notAfter: toIso(row.notAfter),
    retireAfter: toIso(row.retireAfter),
    fingerprint: row.fingerprint,
    createdAt: toIso(row.createdAt),
  }
}

async function requireTenantCertificateManager(
  c: Context<XidHonoEnv>,
  orgId: string,
): Promise<OrgScopedAuth> {
  const auth = await requireApiKeyOrOrgManager(c, orgId, 'connections:write')
  if (orgId !== c.get('tenant').tenantId) throw new AppError('access_denied', { httpStatus: 403 })
  await assertOrgSelfServiceEditable(c, auth, await requireOrg(c, orgId))
  return auth
}

app.get('/:id/outbound-saml-signing-certificates', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'connections:read')
  const rows = await listOutboundSamlSigningCertificates(c)
  return c.json({ data: rows.map(toCertificateResponse) })
})

app.post('/:id/outbound-saml-signing-certificates', async (c) => {
  const id = c.req.param('id')
  const auth = await requireTenantCertificateManager(c, id)
  const tenant = c.get('tenant')
  const inserted = await insertOutboundSamlCertificate(c.env, {
    tenantId: tenant.tenantId,
    commonName: certificateCommonName(tenant.issuer),
    status: 'next',
    now: Date.now(),
  })
  if (!inserted) throw new AppError('conflict', { httpStatus: 409 })
  auditOrgMutation(c, auth, {
    action: 'outbound_saml_signing_certificate.prepared',
    orgId: id,
    targetType: 'saml_signing_certificate',
    targetId: inserted.id,
  })
  return c.json(toCertificateResponse(inserted), 201)
})

app.post('/:id/outbound-saml-signing-certificates/:certificateId/activate', async (c) => {
  const id = c.req.param('id')
  const certificateId = c.req.param('certificateId')
  const auth = await requireTenantCertificateManager(c, id)
  const activated = await activateNextOutboundSamlSigningCertificate(c, certificateId)
  if (!activated.ok) {
    if (activated.error === 'certificate_not_found') {
      throw new AppError('not_found', { httpStatus: 404 })
    }
    if (activated.error === 'certificate_expired') {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'certificate_id' },
      })
    }
    throw new AppError('conflict', { httpStatus: 409 })
  }
  auditOrgMutation(c, auth, {
    action: 'outbound_saml_signing_certificate.activated',
    orgId: id,
    targetType: 'saml_signing_certificate',
    targetId: activated.value.activatedId,
    details: { retiringCertificateId: activated.value.retiringId },
  })
  const rows = await listOutboundSamlSigningCertificates(c)
  return c.json({ data: rows.map(toCertificateResponse) })
})

export function registerOrgOutboundSamlCertificateRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/organizations', app)
}
