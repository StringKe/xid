// 删除后再新建企业 SSO 连接会复用组织唯一的那一行:旧连接的 metadata、刷新错误、证书保留记录、
// 密钥、落地页与显示名都不能带进新连接;未给出 display_name 时不写入预设的英文默认名。

import { describe, expect, it, vi } from 'vitest'
import { schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import { registerConnections } from '../connections'
import { registerOrganizationsRoutes } from '../organizations'
import {
  buildApp,
  envOf,
  makeDb,
  seedApiKey,
  seedMembership,
  seedOrg,
  seedUser,
  sessionFor,
  tenantDb,
} from './console-fixtures'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

type D1 = ReturnType<typeof makeDb>

async function seed(): Promise<D1> {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a' })
  await seedUser(d1, { id: 'user_a', email: 'a@acme.example' })
  await seedMembership(d1, { id: 'mem_a', userId: 'user_a', orgId: 't_a', role: 'owner' })
  return d1
}

async function seedDeletedSamlConnection(d1: D1): Promise<void> {
  await tenantDb(d1)
    .forOrg('t_a')
    .ssoConnections.insert({
      id: 'conn_a',
      tenantId: 't_a',
      orgId: 't_a',
      protocol: 'saml',
      displayName: 'Old IdP',
      idpEntityId: 'https://old-idp.acme-corp.test/entity',
      idpSsoUrl: 'https://old-idp.acme-corp.test/sso',
      idpSloUrl: 'https://old-idp.acme-corp.test/slo',
      idpMetadataUrl: 'https://old-idp.acme-corp.test/metadata',
      idpMetadataXml: '<md:EntityDescriptor/>',
      idpMetadataRefreshedAt: new Date('2026-09-01T00:00:00Z'),
      idpMetadataLastError: 'metadata_fetch_failed',
      idpMetadataLastErrorAt: new Date('2026-10-01T00:00:00Z'),
      idpCertificates: ['MIIBold'],
      idpCertificateRetirements: [{ certificate: 'MIIBolder', retiredAt: 1 }],
      oidcClientId: 'old-client',
      spCertId: 'cert_old',
      wantAuthnResponseSigned: false,
      samlClockSkewMs: 60_000,
      roleMapping: { admins: 'admin' },
      jitEnabled: false,
      relayStateUrl: 'https://acme.xid.dev/account',
      status: 'deleted',
    })
}

function readConnection(d1: D1) {
  return tenantDb(d1).forOrg('t_a').ssoConnections.findOne(eq(schema.ssoConnections.id, 'conn_a'))
}

function createOrgConnection(d1: D1, body: Record<string, unknown>) {
  return buildApp(registerOrganizationsRoutes, { session: sessionFor('user_a') }).request(
    'https://acme.xid.dev/v1/organizations/t_a/sso-connections',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    envOf(d1),
  )
}

const SWA_BODY = {
  protocol: 'swa',
  preset: 'swa',
  attribute_mapping: {
    _legacy: {
      swaTargetUrl: 'https://intranet.acme-corp.io/login',
      swaUsernameField: 'username',
      swaPasswordField: 'password',
    },
  },
}

const FRESH_STATE = {
  idpEntityId: null,
  idpSsoUrl: null,
  idpSloUrl: null,
  idpMetadataUrl: null,
  idpMetadataXml: null,
  idpMetadataRefreshedAt: null,
  idpMetadataLastError: null,
  idpMetadataLastErrorAt: null,
  idpCertificates: [],
  idpCertificateRetirements: null,
  oidcClientId: null,
  oidcClientSecretCiphertext: null,
  spCertId: null,
  relayStateUrl: null,
}

describe('re-creating an SSO connection over a deleted one', () => {
  it('drops every value of the deleted connection on the organization route', async () => {
    const d1 = await seed()
    await seedDeletedSamlConnection(d1)

    const res = await createOrgConnection(d1, { ...SWA_BODY, display_name: 'Intranet' })

    expect(res.status).toBe(201)
    const row = await readConnection(d1)
    expect(row).toMatchObject({
      ...FRESH_STATE,
      displayName: 'Intranet',
      protocol: 'swa',
      status: 'active',
      wantAuthnResponseSigned: true,
      samlClockSkewMs: 180_000,
      roleMapping: {},
    })
  })

  it('drops every value of the deleted connection on the Management API route', async () => {
    const d1 = await seed()
    await seedDeletedSamlConnection(d1)
    const token = await seedApiKey(d1, { id: 'key_a', scopes: ['connections:write'] })

    const res = await buildApp(registerConnections).request(
      'https://acme.xid.dev/v1/connections',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: 't_a', ...SWA_BODY, preset: undefined }),
      },
      envOf(d1),
    )

    expect(res.status).toBe(201)
    expect(await readConnection(d1)).toMatchObject({
      ...FRESH_STATE,
      displayName: null,
      protocol: 'swa',
      status: 'active',
      jitEnabled: true,
    })
  })
})

describe('SSO connection display name', () => {
  it('stores no display name when a legacy preset is created without one', async () => {
    const d1 = await seed()

    const res = await createOrgConnection(d1, SWA_BODY)

    expect(res.status).toBe(201)
    const [row] = await tenantDb(d1).forOrg('t_a').ssoConnections.findMany()
    expect(row?.displayName).toBeNull()
  })

  it('stores no display name over a deleted connection that had one', async () => {
    const d1 = await seed()
    await seedDeletedSamlConnection(d1)

    const res = await createOrgConnection(d1, SWA_BODY)

    expect(res.status).toBe(201)
    expect((await readConnection(d1))?.displayName).toBeNull()
  })
})
