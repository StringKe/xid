// 出站 SAML IdP 签名证书读取与私钥导入。签名只用 SP 当前指向的证书;metadata 同时发布租户内
// 仍在有效期的 next / active / retiring 证书,让 SP 在管理员切换前后都能验签。

import { envelopeDecrypt, toBufferSource } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { decodeKek } from '../oidc/shared'
import type { SamlServiceProvider } from './outbound-saml-shared'
import {
  OUTBOUND_IDP_CERT_USAGE,
  PUBLISHED_CERTIFICATE_STATUSES,
  SIGNING_CERTIFICATE_STATUSES,
  isCertificateTimeValid,
  signingCertificateUnavailable,
} from './signing-certificate'
import type { CertRow } from './signing-certificate'

const PUBLISHED_CERTIFICATE_LIMIT = 10

export async function loadSigningCert(
  c: Context<XidHonoEnv>,
  sp: SamlServiceProvider,
): Promise<CertRow> {
  if (!sp.idpSigningCertId)
    throw signingCertificateUnavailable('service_provider_without_certificate')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const cert = await db.certStore.findOne(
    and(
      eq(schema.certStore.id, sp.idpSigningCertId),
      eq(schema.certStore.usage, OUTBOUND_IDP_CERT_USAGE),
      inArray(schema.certStore.status, [...SIGNING_CERTIFICATE_STATUSES]),
    ),
  )
  if (!cert) throw signingCertificateUnavailable('signing_certificate_retired')
  if (!(await isCertificateTimeValid(cert, Date.now()))) {
    throw signingCertificateUnavailable('signing_certificate_expired')
  }
  return cert
}

export async function publishedSigningCertificates(
  c: Context<XidHonoEnv>,
  sp: SamlServiceProvider,
): Promise<string[]> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows = await db.certStore.findMany(
    and(
      eq(schema.certStore.usage, OUTBOUND_IDP_CERT_USAGE),
      inArray(schema.certStore.status, [...PUBLISHED_CERTIFICATE_STATUSES]),
    ),
    { orderBy: asc(schema.certStore.createdAt), limit: PUBLISHED_CERTIFICATE_LIMIT },
  )
  const now = Date.now()
  const valid: CertRow[] = []
  for (const row of rows) {
    if (await isCertificateTimeValid(row, now)) valid.push(row)
  }
  if (valid.length === 0) throw signingCertificateUnavailable('no_valid_signing_certificate')
  const pinned = valid.filter((row) => row.id === sp.idpSigningCertId)
  const others = valid.filter((row) => row.id !== sp.idpSigningCertId)
  return [...pinned, ...others].map((row) => row.certificate)
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
