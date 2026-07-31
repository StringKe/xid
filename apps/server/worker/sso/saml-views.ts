// SAML SP 视图:SP metadata XML 输出 + SP-initiated AuthnRequest 发起(DEFLATE+base64 HTTP-Redirect binding)。
// metadata 字段见 8.9;AuthnRequest 生成走 @xid-kit/saml(不自研 XML),ID 存 DO 一次性(InResponseTo 比对)。
// SP 签名/加密证书取 CertStore(public X.509,base64 DER);DEFLATE 用 Workers 原生 CompressionStream('deflate-raw')。

import { buildSpMetadataXml, generateAuthnRequest } from '@xid-kit/saml'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { readAllById } from '../lib/db-pagination'
import { acsUrl, sloUrl, spEntityId } from './saml-connection'
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
    authnRequestsSigned: Boolean(connection.spCertId),
    wantAssertionsSigned: connection.wantAssertionsSigned,
    signingCertsB64: signingCerts,
    ...(encryptionCerts.length > 0 ? { encryptionCertsB64: encryptionCerts } : {}),
  })
  return c.body(xml, 200, { 'content-type': 'application/samlmetadata+xml' })
}

// DEFLATE(raw,无 zlib 头)+ 标准 base64 -> HTTP-Redirect binding 的 SAMLRequest 值。
// Redirect binding 用标准 base64(URLSearchParams 负责 URL 编码),非 base64url(见 SAML 2.0 Bindings)。
async function deflateBase64(xml: string): Promise<string> {
  const stream = new Blob([xml]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer())
  let binary = ''
  for (const b of compressed) binary += String.fromCharCode(b)
  return btoa(binary)
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

  const samlRequest = await deflateBase64(request.xml)
  const params = new URLSearchParams({ SAMLRequest: samlRequest })
  params.set('RelayState', flowContext.continuePath.slice(0, 2048))
  const sep = connection.idpSsoUrl.includes('?') ? '&' : '?'
  return c.redirect(`${connection.idpSsoUrl}${sep}${params.toString()}`)
}
