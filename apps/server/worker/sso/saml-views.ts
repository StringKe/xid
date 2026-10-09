// SAML SP 视图:SP metadata XML 输出 + SP-initiated AuthnRequest 发起(DEFLATE+base64 HTTP-Redirect binding)。
// metadata 字段见 8.9;AuthnRequest 生成走 @xid-kit/saml(不自研 XML),ID 存 DO 一次性(InResponseTo 比对)。
// SP 签名/加密证书取 CertStore(public X.509,base64 DER);有 active saml_sp_signing 证书时 AuthnRequest 签名。

import {
  buildSpMetadataXml,
  encodeRedirectBindingMessage,
  generateAuthnRequest,
  signRedirectBindingRequest,
} from '@xid-kit/saml'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { readAllById } from '../lib/db-pagination'
import { acsUrl, loadSpSigningKey, sloUrl, spEntityId } from './saml-connection'
import type { SamlConnection } from './saml-connection'
import type { XidHonoEnv } from '../lib/types'
import type { SamlAuthnRequestContext } from './saml-do'

type StoreAuthnRequestId = (
  c: Context<XidHonoEnv>,
  connectionId: string,
  requestId: string,
  context?: SamlAuthnRequestContext,
) => Promise<void>

// 取 connection 的 SP 证书集(CertStore,public X.509 base64 DER),按 usage 过滤,轮换期可多把。
async function spCerts(
  c: Context<XidHonoEnv>,
  usage: 'saml_sp_signing' | 'saml_sp_encryption',
): Promise<string[]> {
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)
  const filter = and(eq(schema.certStore.usage, usage), eq(schema.certStore.status, 'active'))
  const rows = await readAllById((cursor, limit) =>
    db.certStore.findMany(cursor ? and(filter, gt(schema.certStore.id, cursor)) : filter, {
      orderBy: asc(schema.certStore.id),
      limit,
    }),
  )
  return rows.map((r) => r.certificate)
}

// GET metadata:输出 SP metadata XML(application/samlmetadata+xml)。
export async function buildSpMetadata(
  c: Context<XidHonoEnv>,
  connection: SamlConnection,
): Promise<Response> {
  const ctx = c.get('tenant')
  const signingCerts = await spCerts(c, 'saml_sp_signing')
  const encryptionCerts = await spCerts(c, 'saml_sp_encryption')
  const xml = buildSpMetadataXml({
    entityId: spEntityId(ctx, connection.id),
    acsUrl: acsUrl(ctx, connection.id),
    sloUrl: sloUrl(ctx, connection.id),
    authnRequestsSigned: signingCerts.length > 0,
    wantAssertionsSigned: connection.wantAssertionsSigned,
    signingCertsB64: signingCerts,
    ...(encryptionCerts.length > 0 ? { encryptionCertsB64: encryptionCerts } : {}),
  })
  return c.body(xml, 200, { 'content-type': 'application/samlmetadata+xml' })
}

// HTTP-Redirect binding 查询串:有 SP 签名私钥时按 Bindings 3.4.4.1 对 SAMLRequest&RelayState&SigAlg
// 做 detached 签名,与 metadata 的 AuthnRequestsSigned 同源判断。
async function authnRequestQuery(
  c: Context<XidHonoEnv>,
  samlRequest: string,
  relayState: string,
): Promise<string> {
  const signingKey = await loadSpSigningKey(c)
  if (!signingKey) {
    return new URLSearchParams({ SAMLRequest: samlRequest, RelayState: relayState }).toString()
  }
  const signed = await signRedirectBindingRequest(samlRequest, relayState, signingKey)
  if (!signed.ok) {
    throw new AppError('server_error', { cause: signed.error.reason })
  }
  return signed.value.query
}

// GET login:生成 AuthnRequest -> 存 ID 到 DO(一次性)-> 302 到 IdP SSO URL(HTTP-Redirect binding)。
export async function redirectToIdp(
  c: Context<XidHonoEnv>,
  connection: SamlConnection,
  storeAuthnRequestId: StoreAuthnRequestId,
  flowContext: SamlAuthnRequestContext,
): Promise<Response> {
  const ctx = c.get('tenant')
  if (!connection.idpSsoUrl) throw new AppError('connection_not_found', { httpStatus: 404 })

  const request = generateAuthnRequest({
    spEntityId: spEntityId(ctx, connection.id),
    idpSsoUrl: connection.idpSsoUrl,
    acsUrl: acsUrl(ctx, connection.id),
  })
  await storeAuthnRequestId(c, connection.id, request.id, flowContext)

  const samlRequest = await encodeRedirectBindingMessage(request.xml)
  const query = await authnRequestQuery(c, samlRequest, flowContext.continuePath.slice(0, 2048))
  const sep = connection.idpSsoUrl.includes('?') ? '&' : '?'
  return c.redirect(`${connection.idpSsoUrl}${sep}${query}`)
}
