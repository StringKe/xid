// 出站 SAML 签名证书显式切换:next -> active,旧 active -> retiring,应用改指新证书,跨租户不可见。
import { generateSelfSignedSamlCertificate } from '@xid-kit/saml'
import { beforeEach, describe, expect, it } from 'vitest'
import { SqliteD1, seedOrganization } from '../../me/__tests__/sqlite-d1'
import {
  RETIRING_CERTIFICATE_OVERLAP_MS,
  activateNextOutboundSamlSigningCertificate,
} from '../outbound-saml-certificate-rotation'

const DAY = 24 * 60 * 60 * 1000

let db: SqliteD1
let certificateB64: string
let notAfter: number

async function seedCertificate(id: string, tenantId: string, status: string): Promise<void> {
  db.insert('cert_store', {
    id,
    tenant_id: tenantId,
    usage: 'saml_idp_signing',
    certificate: certificateB64,
    private_key_iv: new Uint8Array(12),
    private_key_ciphertext: new Uint8Array(32),
    private_key_tag: new Uint8Array(16),
    kek_version: 1,
    status,
    not_before: Date.now() - DAY,
    not_after: notAfter,
    fingerprint: `FP_${id}`,
    created_at: Date.now(),
    updated_at: Date.now(),
  })
}

function seedApp(id: string, tenantId: string, certId: string): void {
  db.insert('saml_service_providers', {
    id,
    tenant_id: tenantId,
    org_id: tenantId,
    sp_entity_id: `https://${id}.example.com`,
    acs_url: `https://${id}.example.com/acs`,
    slo_binding: 'redirect',
    sp_certificates: '[]',
    attribute_mapping: '{}',
    name_id_format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
    idp_signing_cert_id: certId,
    created_at: Date.now(),
    updated_at: Date.now(),
  })
}

function context(tenantId: string) {
  const tenant = { tenantId, issuer: 'https://xid.test' }
  return {
    env: { DB: db.asD1() },
    get: (key: string) => (key === 'tenant' ? tenant : undefined),
  } as never
}

function statusOf(id: string): Record<string, unknown> | undefined {
  return db.rows('SELECT status, retire_after FROM cert_store WHERE id = ?', id)[0]
}

beforeEach(async () => {
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
    created_at: Date.now(),
    updated_at: Date.now(),
  })
  seedOrganization(db, { id: 'tenant_a', tenantId: 'tenant_a' })
  seedOrganization(db, { id: 'tenant_b', tenantId: 'tenant_b' })
  const generated = await generateSelfSignedSamlCertificate('xid.test')
  if (!generated.ok) throw new Error(generated.error.reason)
  generated.value.privateKeyPkcs8.fill(0)
  certificateB64 = generated.value.certificateB64
  notAfter = generated.value.notAfter
})

describe('activateNextOutboundSamlSigningCertificate', () => {
  it('promotes next, retires the old active with an overlap window and repoints every app', async () => {
    await seedCertificate('cert_old', 'tenant_a', 'active')
    await seedCertificate('cert_new', 'tenant_a', 'next')
    seedApp('sp_a1', 'tenant_a', 'cert_old')
    seedApp('sp_a2', 'tenant_a', 'cert_old')
    const now = Date.now()

    const result = await activateNextOutboundSamlSigningCertificate(
      context('tenant_a'),
      'cert_new',
      now,
    )

    expect(result).toEqual({ ok: true, value: { activatedId: 'cert_new', retiringId: 'cert_old' } })
    expect(statusOf('cert_new')?.['status']).toBe('active')
    expect(statusOf('cert_old')).toEqual({
      status: 'retiring',
      retire_after: now + RETIRING_CERTIFICATE_OVERLAP_MS,
    })
    expect(
      db.rows('SELECT DISTINCT idp_signing_cert_id AS id FROM saml_service_providers'),
    ).toEqual([{ id: 'cert_new' }])
  })

  it('rejects an id that is not a next certificate', async () => {
    await seedCertificate('cert_old', 'tenant_a', 'active')

    const result = await activateNextOutboundSamlSigningCertificate(context('tenant_a'), 'cert_old')

    expect(result).toEqual({ ok: false, error: 'certificate_not_found' })
    expect(statusOf('cert_old')?.['status']).toBe('active')
  })

  it('cannot activate another tenant certificate and leaves both tenants untouched', async () => {
    await seedCertificate('cert_a', 'tenant_a', 'active')
    await seedCertificate('cert_b_next', 'tenant_b', 'next')
    seedApp('sp_a', 'tenant_a', 'cert_a')

    const result = await activateNextOutboundSamlSigningCertificate(
      context('tenant_a'),
      'cert_b_next',
    )

    expect(result).toEqual({ ok: false, error: 'certificate_not_found' })
    expect(statusOf('cert_a')?.['status']).toBe('active')
    expect(statusOf('cert_b_next')?.['status']).toBe('next')
    expect(db.rows('SELECT idp_signing_cert_id AS id FROM saml_service_providers')).toEqual([
      { id: 'cert_a' },
    ])
  })

  it('only repoints apps of the acting tenant', async () => {
    await seedCertificate('cert_a_old', 'tenant_a', 'active')
    await seedCertificate('cert_a_new', 'tenant_a', 'next')
    await seedCertificate('cert_b', 'tenant_b', 'active')
    seedApp('sp_b', 'tenant_b', 'cert_b')

    await activateNextOutboundSamlSigningCertificate(context('tenant_a'), 'cert_a_new')

    expect(
      db.rows("SELECT idp_signing_cert_id AS id FROM saml_service_providers WHERE id = 'sp_b'"),
    ).toEqual([{ id: 'cert_b' }])
    expect(statusOf('cert_b')?.['status']).toBe('active')
  })
})
