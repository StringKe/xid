// 认证设置页的 SAML 证书与出站应用只读统计:IdP 证书有效期和指纹、出站签名证书、出站应用最近登录。

import { createTenantDb, schema } from '@xid-kit/db'
import { loadIdpVerifyKey, setSamlEngine } from '@xid-kit/saml'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { toIso } from './org-shared'

const OUTBOUND_IDP_CERT_USAGE = 'saml_idp_signing'

export type CertificateSummary = {
  fingerprintSha256: string
  notBefore: string
  notAfter: string
}

export type SigningCertificateSummary = {
  id: string
  status: 'active' | 'retiring'
  notBefore: string | null
  notAfter: string | null
  fingerprint: string
  algorithm: { key: string; size: number | null; hash: string | null }
}

export async function parseCertificates(
  certificates: readonly string[],
): Promise<CertificateSummary[]> {
  setSamlEngine(globalThis.crypto)
  const parsed = await Promise.all(certificates.map((cert) => loadIdpVerifyKey(cert)))
  return parsed.flatMap((result) =>
    result.ok
      ? [
          {
            fingerprintSha256: result.value.fingerprint,
            notBefore: new Date(result.value.notBefore).toISOString(),
            notAfter: new Date(result.value.notAfter).toISOString(),
          },
        ]
      : [],
  )
}

function describeKeyAlgorithm(key: CryptoKey): SigningCertificateSummary['algorithm'] {
  const algorithm = key.algorithm as KeyAlgorithm & {
    modulusLength?: number
    namedCurve?: string
    hash?: { name?: string }
  }
  if (algorithm.name.startsWith('RSA')) {
    return { key: 'RSA', size: algorithm.modulusLength ?? null, hash: algorithm.hash?.name ?? null }
  }
  if (algorithm.name === 'ECDSA') {
    return { key: algorithm.namedCurve ?? 'ECDSA', size: null, hash: null }
  }
  return { key: algorithm.name, size: null, hash: null }
}

export async function outboundSigningCertificates(
  c: Context<XidHonoEnv>,
): Promise<SigningCertificateSummary[]> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows = await db.certStore.findMany(
    and(
      eq(schema.certStore.usage, OUTBOUND_IDP_CERT_USAGE),
      inArray(schema.certStore.status, ['active', 'retiring']),
    ),
    { orderBy: desc(schema.certStore.createdAt), limit: 10 },
  )
  setSamlEngine(globalThis.crypto)
  return Promise.all(
    rows.map(async (row) => {
      const loaded = await loadIdpVerifyKey(row.certificate)
      return {
        id: row.id,
        status: row.status === 'retiring' ? 'retiring' : 'active',
        notBefore: toIso(row.notBefore),
        notAfter: toIso(row.notAfter),
        fingerprint: row.fingerprint,
        algorithm: loaded.ok
          ? describeKeyAlgorithm(loaded.value.publicKey)
          : { key: 'unknown', size: null, hash: null },
      }
    }),
  )
}

export async function outboundLastSignIns(
  c: Context<XidHonoEnv>,
  appIds: readonly string[],
): Promise<Map<string, string | null>> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const entries = await Promise.all(
    appIds.map(async (appId) => {
      const rows = await db.samlSessionBindings.findMany(
        and(
          eq(schema.samlSessionBindings.direction, 'outbound'),
          eq(schema.samlSessionBindings.scopeId, appId),
        ),
        { orderBy: desc(schema.samlSessionBindings.updatedAt), limit: 1 },
      )
      return [appId, toIso(rows[0]?.updatedAt)] as const
    }),
  )
  return new Map(entries)
}
