// 出站 SAML IdP 签名证书:租户级 cert_store 行,状态 next -> active -> retiring -> retired。
// 后台只生成 next 和下线 retiring;next 升为 active 只能由管理员显式切换(见 outbound-saml-certificate-rotation.ts)。

import { envelopeEncrypt } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { generateSelfSignedSamlCertificate, loadIdpVerifyKey } from '@xid-kit/saml'
import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import { logWorkerError } from '../lib/safe-log'
import type { XidHonoEnv } from '../lib/types'
import { decodeKek } from '../oidc/shared'

const SAML_CERT_KEK_VERSION = 1
export const OUTBOUND_IDP_CERT_USAGE = 'saml_idp_signing'
export const SIGNING_CERTIFICATE_STATUSES = ['active', 'retiring'] as const
export const PUBLISHED_CERTIFICATE_STATUSES = ['next', 'active', 'retiring'] as const

export type CertRow = typeof schema.certStore.$inferSelect
type CertStatus = 'active' | 'next'

export function certificateCommonName(issuer: string): string {
  try {
    return new URL(issuer).hostname.slice(0, 64)
  } catch {
    throw new AppError('internal_error', { httpStatus: 500 })
  }
}

export async function isCertificateTimeValid(certificate: CertRow, now: number): Promise<boolean> {
  const parsed = await loadIdpVerifyKey(certificate.certificate)
  return parsed.ok && parsed.value.notBefore <= now && parsed.value.notAfter > now
}

export function signingCertificateUnavailable(reason: string): AppError {
  logWorkerError('sso.outbound_saml.signing_certificate_unavailable', undefined, {
    component: 'outbound-saml',
    operation: 'signing_certificate',
    reason,
  })
  return new AppError('service_unavailable', {
    httpStatus: 503,
    longMessage: 'outbound_saml_signing_certificate_unavailable',
  })
}

async function hasCertificateWithStatus(
  db: D1Database,
  input: { tenantId: string; status: CertStatus },
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM cert_store WHERE tenant_id = ? AND usage = ? AND status = ? LIMIT 1`)
    .bind(input.tenantId, OUTBOUND_IDP_CERT_USAGE, input.status)
    .first<{ id: string }>()
  return row !== null
}

// 生成自签证书并以给定状态写入。同租户已有同状态证书(部分唯一索引冲突,并发写入方胜出)时返回 null。
export async function insertOutboundSamlCertificate(
  env: { DB: D1Database; KEK: string },
  input: { tenantId: string; commonName: string; status: CertStatus; now: number },
): Promise<CertRow | null> {
  const generated = await generateSelfSignedSamlCertificate(input.commonName, input.now)
  if (!generated.ok) throw new AppError('internal_error', { httpStatus: 500 })
  const privateKey = generated.value.privateKeyPkcs8
  let kek: Uint8Array | null = null
  try {
    kek = decodeKek(env.KEK)
    const encrypted = await envelopeEncrypt(privateKey, kek, SAML_CERT_KEK_VERSION)
    const id = createPersistedId('certStore')
    const insert = env.DB.prepare(
      `INSERT INTO cert_store (
         id, tenant_id, usage, certificate, private_key_iv, private_key_ciphertext,
         private_key_tag, kek_version, status, not_before, not_after, fingerprint,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      input.tenantId,
      OUTBOUND_IDP_CERT_USAGE,
      generated.value.certificateB64,
      encrypted.iv,
      encrypted.ciphertext,
      encrypted.tag,
      encrypted.kekVersion,
      input.status,
      generated.value.notBefore,
      generated.value.notAfter,
      generated.value.fingerprint,
      input.now,
      input.now,
    )
    try {
      await env.DB.batch([insert])
    } catch (cause) {
      if (await hasCertificateWithStatus(env.DB, input)) return null
      throw new AppError('internal_error', { httpStatus: 500, cause })
    }
    // D1 accepts Uint8Array blob values, while drizzle's sqlite-core Node typings expose Buffer.
    return {
      id,
      tenantId: input.tenantId,
      usage: OUTBOUND_IDP_CERT_USAGE,
      certificate: generated.value.certificateB64,
      privateKeyIv: encrypted.iv as unknown as CertRow['privateKeyIv'],
      privateKeyCiphertext: encrypted.ciphertext as unknown as CertRow['privateKeyCiphertext'],
      privateKeyTag: encrypted.tag as unknown as CertRow['privateKeyTag'],
      kekVersion: encrypted.kekVersion,
      status: input.status,
      notBefore: new Date(generated.value.notBefore),
      notAfter: new Date(generated.value.notAfter),
      fingerprint: generated.value.fingerprint,
      retireAfter: null,
      createdAt: new Date(input.now),
      updatedAt: new Date(input.now),
    }
  } finally {
    privateKey.fill(0)
    kek?.fill(0)
  }
}

async function findCertificate(
  c: Context<XidHonoEnv>,
  filter: { id?: string; statuses: readonly string[] },
): Promise<CertRow | null> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.certStore.findOne(
    and(
      ...(filter.id ? [eq(schema.certStore.id, filter.id)] : []),
      eq(schema.certStore.usage, OUTBOUND_IDP_CERT_USAGE),
      inArray(schema.certStore.status, [...filter.statuses]),
    ),
  )
  return row ?? null
}

// 新建或修改出站 SAML 应用时选定签名证书:指定 id 时必须是租户内仍在有效期的 active/retiring;
// 未指定时用当前 active,租户还没有任何 active 证书时才生成第一张。active 已过期时不自动换证。
export async function resolveOrProvisionOutboundSamlSigningCertificate(
  c: Context<XidHonoEnv>,
  requestedCertificateId?: string,
): Promise<CertRow> {
  const now = Date.now()
  if (requestedCertificateId) {
    const requested = await findCertificate(c, {
      id: requestedCertificateId,
      statuses: SIGNING_CERTIFICATE_STATUSES,
    })
    if (requested && (await isCertificateTimeValid(requested, now))) return requested
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'idp_signing_cert_id' },
    })
  }

  const active = await findCertificate(c, { statuses: ['active'] })
  if (active) {
    if (await isCertificateTimeValid(active, now)) return active
    throw signingCertificateUnavailable('active_certificate_expired')
  }
  const tenant = c.get('tenant')
  const inserted = await insertOutboundSamlCertificate(c.env, {
    tenantId: tenant.tenantId,
    commonName: certificateCommonName(tenant.issuer),
    status: 'active',
    now,
  })
  if (inserted) return inserted
  const winner = await findCertificate(c, { statuses: ['active'] })
  if (winner && (await isCertificateTimeValid(winner, now))) return winner
  throw signingCertificateUnavailable('active_certificate_provisioning_conflict')
}
