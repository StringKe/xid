// Outbound SAML IdP:XID 给下游 SaaS SP 发 signed SAML Response。
// 与 inbound `/sso/saml/:connection/*` 分离,避免把 XID 作为 SP 和 IdP 的角色混用。

import { buildIdpMetadataXml } from '@xid-kit/saml'
import { Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import {
  OUTBOUND_AUTHN_REQUEST_SIGNATURE_REQUIRED,
  idpEntityId,
  idpSloUrl,
  idpSsoUrl,
  requiredParam,
  resolveSp,
  withOutboundTenant,
} from './outbound-saml-shared'
import { NAME_ID_FORMAT } from './outbound-saml-name-id'
import { publishedSigningCertificates } from './outbound-saml-signing'
import { handleOutboundSlo } from './outbound-saml-slo'
import { handleSso } from './outbound-saml-sso'

export { outboundSamlIdpEndpoints } from './outbound-saml-shared'
export type { OutboundSamlIdpEndpoints } from './outbound-saml-shared'
export { initiateOutboundSamlLogout } from './outbound-saml-logout'
export type { OutboundSamlLogoutAction } from './outbound-saml-logout'

const outbound = new Hono<XidHonoEnv>()

outbound.get('/saml/:appId/metadata', async (c) => {
  const appId = requiredParam(c, 'appId')
  return withOutboundTenant(c, appId, async () => {
    const sp = await resolveSp(c, appId)
    const signingCertsB64 = await publishedSigningCertificates(c, sp)
    const xml = buildIdpMetadataXml({
      entityId: idpEntityId(c, appId),
      ssoUrl: idpSsoUrl(c, appId),
      sloUrl: idpSloUrl(c, appId),
      signingCertsB64,
      nameIdFormats: [
        sp.nameIdFormat,
        ...Object.values(NAME_ID_FORMAT).filter((format) => format !== sp.nameIdFormat),
      ],
      wantAuthnRequestsSigned: OUTBOUND_AUTHN_REQUEST_SIGNATURE_REQUIRED,
    })
    return c.body(xml, 200, { 'content-type': 'application/samlmetadata+xml' })
  })
})

outbound.get('/saml/:appId/sso', async (c) => {
  const appId = requiredParam(c, 'appId')
  return withOutboundTenant(c, appId, () => handleSso(c))
})
outbound.post('/saml/:appId/sso', async (c) => {
  const appId = requiredParam(c, 'appId')
  return withOutboundTenant(c, appId, () => handleSso(c))
})

outbound.get('/saml/:appId/slo', async (c) => {
  const appId = requiredParam(c, 'appId')
  return withOutboundTenant(c, appId, () => handleOutboundSlo(c))
})
outbound.post('/saml/:appId/slo', async (c) => {
  const appId = requiredParam(c, 'appId')
  return withOutboundTenant(c, appId, () => handleOutboundSlo(c))
})

export function registerOutboundSamlRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/sso/outbound', outbound)
}
