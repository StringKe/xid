// 出站 SAML 签名证书每日维护:发布 next、下线 retiring、到期告警,且从不切换 active。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1, seedOrganization } from '../../me/__tests__/sqlite-d1'
import { maintainOutboundSamlSigningCertificates } from '../saml-signing-certificates'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 1)

type CertSeed = {
  id: string
  tenantId: string
  status: string
  notAfter: number
  retireAfter?: number | null
}

function seedCertificate(db: SqliteD1, input: CertSeed): void {
  db.insert('cert_store', {
    id: input.id,
    tenant_id: input.tenantId,
    usage: 'saml_idp_signing',
    certificate: `CERT_${input.id}`,
    private_key_iv: new Uint8Array(12),
    private_key_ciphertext: new Uint8Array(32),
    private_key_tag: new Uint8Array(16),
    kek_version: 1,
    status: input.status,
    not_before: input.notAfter - 365 * DAY,
    not_after: input.notAfter,
    fingerprint: `FP_${input.id}`,
    retire_after: input.retireAfter ?? null,
    created_at: NOW - DAY,
    updated_at: NOW - DAY,
  })
}

function certificates(db: SqliteD1, tenantId: string) {
  return db.rows(
    'SELECT id, status FROM cert_store WHERE tenant_id = ? ORDER BY created_at, id',
    tenantId,
  )
}

let db: SqliteD1
let sent: Array<Record<string, unknown>>
let env: Env

beforeEach(() => {
  db = new SqliteD1()
  db.insert('instances', {
    id: 'inst_1',
    name: 'XID',
    primary_domain: 'xid.test',
    mode: 'multi_tenant',
    default_locale: 'en',
    data_residency: 'us',
    mfa_policy: 'optional',
    password_policy: '{}',
    session_policy: '{}',
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
  })
  seedOrganization(db, { id: 'tenant_a', tenantId: 'tenant_a' })
  seedOrganization(db, { id: 'tenant_b', tenantId: 'tenant_b' })
  sent = []
  env = {
    DB: db.asD1(),
    KEK: btoa('k'.repeat(32)),
    AUDIT_QUEUE: {
      send: vi.fn(async (message: Record<string, unknown>) => {
        sent.push(message)
      }),
    },
  } as unknown as Env
})

describe('maintainOutboundSamlSigningCertificates', () => {
  it('publishes a next certificate 60 days before the active one expires without switching', async () => {
    seedCertificate(db, {
      id: 'cert_active',
      tenantId: 'tenant_a',
      status: 'active',
      notAfter: NOW + 40 * DAY,
    })

    await maintainOutboundSamlSigningCertificates(env, NOW)

    const rows = certificates(db, 'tenant_a')
    expect(rows.find((row) => row['id'] === 'cert_active')?.['status']).toBe('active')
    const next = rows.filter((row) => row['status'] === 'next')
    expect(next).toHaveLength(1)
    expect(sent).toEqual([
      expect.objectContaining({
        tenantId: 'tenant_a',
        action: 'outbound_saml_signing_certificate.next_published',
        payload: { certificateId: next[0]?.['id'], activeCertificateId: 'cert_active' },
      }),
    ])
  })

  it('does nothing for an active certificate far from expiry', async () => {
    seedCertificate(db, {
      id: 'cert_active',
      tenantId: 'tenant_a',
      status: 'active',
      notAfter: NOW + 200 * DAY,
    })

    await maintainOutboundSamlSigningCertificates(env, NOW)

    expect(certificates(db, 'tenant_a')).toEqual([{ id: 'cert_active', status: 'active' }])
    expect(sent).toEqual([])
  })

  it('alerts when the active certificate is close to expiry and the next one is not activated', async () => {
    seedCertificate(db, {
      id: 'cert_active',
      tenantId: 'tenant_a',
      status: 'active',
      notAfter: NOW + 10 * DAY,
    })
    seedCertificate(db, {
      id: 'cert_next',
      tenantId: 'tenant_a',
      status: 'next',
      notAfter: NOW + 355 * DAY,
    })

    await maintainOutboundSamlSigningCertificates(env, NOW)

    expect(certificates(db, 'tenant_a')).toHaveLength(2)
    expect(sent).toEqual([
      expect.objectContaining({
        tenantId: 'tenant_a',
        action: 'outbound_saml_signing_certificate.expiring',
        payload: expect.objectContaining({
          certificateId: 'cert_active',
          expired: false,
          nextCertificateId: 'cert_next',
        }),
      }),
    ])
  })

  it('keeps an expired active certificate active and reports it as expired', async () => {
    seedCertificate(db, {
      id: 'cert_active',
      tenantId: 'tenant_a',
      status: 'active',
      notAfter: NOW - DAY,
    })
    seedCertificate(db, {
      id: 'cert_next',
      tenantId: 'tenant_a',
      status: 'next',
      notAfter: NOW + 355 * DAY,
    })

    await maintainOutboundSamlSigningCertificates(env, NOW)

    expect(certificates(db, 'tenant_a')).toEqual([
      { id: 'cert_active', status: 'active' },
      { id: 'cert_next', status: 'next' },
    ])
    expect(sent[0]?.['payload']).toMatchObject({ expired: true })
  })

  it('retires retiring certificates after the overlap window and leaves other tenants alone', async () => {
    seedCertificate(db, {
      id: 'cert_done',
      tenantId: 'tenant_a',
      status: 'retiring',
      notAfter: NOW + 100 * DAY,
      retireAfter: NOW - 1,
    })
    seedCertificate(db, {
      id: 'cert_overlap',
      tenantId: 'tenant_a',
      status: 'retiring',
      notAfter: NOW + 100 * DAY,
      retireAfter: NOW + DAY,
    })
    seedCertificate(db, {
      id: 'cert_legacy_expired',
      tenantId: 'tenant_b',
      status: 'retiring',
      notAfter: NOW - 1,
    })
    seedCertificate(db, {
      id: 'cert_legacy_valid',
      tenantId: 'tenant_b',
      status: 'retiring',
      notAfter: NOW + 100 * DAY,
    })

    await maintainOutboundSamlSigningCertificates(env, NOW)

    expect(certificates(db, 'tenant_a')).toEqual([
      { id: 'cert_done', status: 'retired' },
      { id: 'cert_overlap', status: 'retiring' },
    ])
    expect(certificates(db, 'tenant_b')).toEqual([
      { id: 'cert_legacy_expired', status: 'retired' },
      { id: 'cert_legacy_valid', status: 'retiring' },
    ])
  })
})
