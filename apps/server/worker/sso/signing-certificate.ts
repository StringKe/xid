import { envelopeEncrypt } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { generateSelfSignedSamlCertificate, loadIdpVerifyKey } from '@xid-kit/saml'
import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { decodeKek } from '../oidc/shared'

const SAML_CERT_KEK_VERSION = 1
const OUTBOUND_IDP_CERT_USAGE = 'saml_idp_signing'
const CERT_PROVISIONING_MIN_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000

type CertRow = typeof schema.certStore.$inferSelect

function certificateCommonName(issuer: string): string {
  try {
    return new URL(issuer).hostname.slice(0, 64)
  } catch {
    throw new AppError('internal_error', { httpStatus: 500 })
  }
}

async function findCertificate(
  c: Context<XidHonoEnv>,
  certificateId?: string,
): Promise<CertRow | null> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const allowedStatus = certificateId
    ? inArray(schema.certStore.status, ['active', 'retiring'])
    : eq(schema.certStore.status, 'active')
  const filter = and(
    ...(certificateId ? [eq(schema.certStore.id, certificateId)] : []),
    eq(schema.certStore.usage, OUTBOUND_IDP_CERT_USAGE),
    allowedStatus,
  )
  return (await db.certStore.findOne(filter)) ?? null
}

async function isCertificateUsable(
  certificate: CertRow,
  now: number,
  minimumRemainingValidityMs: number,
): Promise<boolean> {
  const parsed = await loadIdpVerifyKey(certificate.certificate)
  return (
    parsed.ok &&
    parsed.value.notBefore <= now &&
    parsed.value.notAfter > now + minimumRemainingValidityMs
  )
}

export async function resolveOrProvisionOutboundSamlSigningCertificate(
  c: Context<XidHonoEnv>,
  requestedCertificateId?: string,
): Promise<CertRow> {
  if (requestedCertificateId) {
    const requested = await findCertificate(c, requestedCertificateId)
    if (requested && (await isCertificateUsable(requested, Date.now(), 0))) return requested
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'idp_signing_cert_id' },
    })
  }

  const tenant = c.get('tenant')
  const active = await findCertificate(c)
  const now = Date.now()
  if (active && (await isCertificateUsable(active, now, CERT_PROVISIONING_MIN_VALIDITY_MS))) {
    return active
  }

  const generated = await generateSelfSignedSamlCertificate(
    certificateCommonName(tenant.issuer),
    now,
  )
  if (!generated.ok) throw new AppError('internal_error', { httpStatus: 500 })

  const privateKey = generated.value.privateKeyPkcs8
  let kek: Uint8Array | null = null
  try {
    kek = decodeKek(c.env.KEK)
    const encrypted = await envelopeEncrypt(privateKey, kek, SAML_CERT_KEK_VERSION)
    // D1 accepts Uint8Array blob values, while drizzle's sqlite-core Node typings expose Buffer.
    const privateKeyIv = encrypted.iv as unknown as CertRow['privateKeyIv']
    const privateKeyCiphertext = encrypted.ciphertext as unknown as CertRow['privateKeyCiphertext']
    const privateKeyTag = encrypted.tag as unknown as CertRow['privateKeyTag']
    const id = createPersistedId('certStore')
    const inserted: CertRow = {
      id,
      tenantId: tenant.tenantId,
      usage: OUTBOUND_IDP_CERT_USAGE,
      certificate: generated.value.certificateB64,
      privateKeyIv,
      privateKeyCiphertext,
      privateKeyTag,
      kekVersion: encrypted.kekVersion,
      status: 'active',
      notBefore: new Date(generated.value.notBefore),
      notAfter: new Date(generated.value.notAfter),
      fingerprint: generated.value.fingerprint,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    }
    const statements: D1PreparedStatement[] = []
    if (active) {
      statements.push(
        c.env.DB.prepare(
          `UPDATE cert_store
             SET status = ?, updated_at = ?
           WHERE tenant_id = ? AND id = ? AND usage = ? AND status = ?`,
        ).bind('retiring', now, tenant.tenantId, active.id, OUTBOUND_IDP_CERT_USAGE, 'active'),
      )
    }
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO cert_store (
           id, tenant_id, usage, certificate, private_key_iv, private_key_ciphertext,
           private_key_tag, kek_version, status, not_before, not_after, fingerprint,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        inserted.id,
        inserted.tenantId,
        inserted.usage,
        inserted.certificate,
        encrypted.iv,
        encrypted.ciphertext,
        encrypted.tag,
        inserted.kekVersion,
        inserted.status,
        generated.value.notBefore,
        generated.value.notAfter,
        inserted.fingerprint,
        now,
        now,
      ),
    )
    try {
      await c.env.DB.batch(statements)
      return inserted
    } catch (cause) {
      let winner: CertRow | null
      try {
        const candidate = await findCertificate(c)
        winner =
          candidate &&
          (await isCertificateUsable(candidate, Date.now(), CERT_PROVISIONING_MIN_VALIDITY_MS))
            ? candidate
            : null
      } catch (readCause) {
        throw new AppError('internal_error', {
          httpStatus: 500,
          cause: new AggregateError([cause, readCause], 'certificate provisioning failed'),
        })
      }
      if (winner) return winner
      throw new AppError('internal_error', { httpStatus: 500, cause })
    }
  } finally {
    privateKey.fill(0)
    kek?.fill(0)
  }
}
