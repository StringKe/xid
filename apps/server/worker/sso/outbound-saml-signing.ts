// 出站 SAML IdP 签名证书读取与私钥导入。

import { envelopeDecrypt, toBufferSource } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { loadIdpVerifyKey } from '@xid-kit/saml'
import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { decodeKek } from '../oidc/shared'
import type { SamlServiceProvider } from './outbound-saml-shared'

type CertRow = typeof schema.certStore.$inferSelect

export async function loadSigningCert(
  c: Context<XidHonoEnv>,
  sp: SamlServiceProvider,
): Promise<CertRow> {
  if (!sp.idpSigningCertId) throw new AppError('connection_not_found', { httpStatus: 404 })
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const cert = await db.certStore.findOne(
    and(
      eq(schema.certStore.id, sp.idpSigningCertId),
      eq(schema.certStore.usage, 'saml_idp_signing'),
      inArray(schema.certStore.status, ['active', 'retiring']),
    ),
  )
  if (!cert) throw new AppError('connection_not_found', { httpStatus: 404 })
  const parsed = await loadIdpVerifyKey(cert.certificate)
  const now = Date.now()
  if (!parsed.ok || parsed.value.notBefore > now || parsed.value.notAfter <= now) {
    throw new AppError('connection_not_found', { httpStatus: 404 })
  }
  return cert
}

export async function importSamlSigningKey(cert: CertRow, kekB64: string): Promise<CryptoKey> {
  const kek = decodeKek(kekB64)
  let pkcs8: Uint8Array | null = null
  try {
    pkcs8 = await envelopeDecrypt(
      {
        iv: new Uint8Array(cert.privateKeyIv),
        ciphertext: new Uint8Array(cert.privateKeyCiphertext),
        tag: new Uint8Array(cert.privateKeyTag),
        kekVersion: cert.kekVersion,
        kid: cert.id,
        alg: 'RS256',
      },
      kek,
    )
    return await crypto.subtle.importKey(
      'pkcs8',
      toBufferSource(pkcs8),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    )
  } finally {
    pkcs8?.fill(0)
    kek.fill(0)
  }
}
