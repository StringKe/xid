// 响应里看不到 `_` 前缀的内部映射键(预设标记、SWA vault、分配门槛),PATCH 属性映射时必须保留它们。

import { describe, expect, it, vi } from 'vitest'
import { schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import { registerOrganizationsRoutes } from '../organizations'
import {
  buildApp,
  envOf,
  json,
  makeDb,
  seedMembership,
  seedOrg,
  seedUser,
  sessionFor,
  tenantDb,
} from './console-fixtures'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

const BASE = 'https://acme.xid.dev/v1/organizations'

async function seed() {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a' })
  await seedUser(d1, { id: 'user_owner', email: 'dana@acme.example' })
  await seedMembership(d1, { id: 'mem_owner', userId: 'user_owner', orgId: 't_a', role: 'owner' })
  return d1
}

function patch(d1: ReturnType<typeof makeDb>, path: string, body: Record<string, unknown>) {
  return buildApp(registerOrganizationsRoutes, { session: sessionFor('user_owner') }).request(
    `${BASE}/t_a/${path}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    envOf(d1),
  )
}

describe('attribute mapping internal keys', () => {
  it('keeps the SSO preset marker when the visible mapping is replaced', async () => {
    const d1 = await seed()
    await tenantDb(d1)
      .forOrg('t_a')
      .ssoConnections.insert({
        id: 'conn_1',
        tenantId: 't_a',
        orgId: 't_a',
        protocol: 'saml',
        attributeMapping: { _xidPreset: 'okta', email: 'mail' },
      })

    const res = await patch(d1, 'sso-connections/conn_1', {
      attribute_mapping: { email: 'emailAddress' },
    })

    expect(res.status).toBe(200)
    expect(
      (await json<{ attribute_mapping: Record<string, unknown> }>(res)).attribute_mapping,
    ).toEqual({
      email: 'emailAddress',
    })
    const row = await tenantDb(d1)
      .forOrg('t_a')
      .ssoConnections.findOne(eq(schema.ssoConnections.id, 'conn_1'))
    expect(row?.attributeMapping).toEqual({ _xidPreset: 'okta', email: 'emailAddress' })
  })

  it('refuses to create a header connection from the preset without an explicit secret', async () => {
    const d1 = await seed()

    const res = await buildApp(registerOrganizationsRoutes, {
      session: sessionFor('user_owner'),
    }).request(
      `${BASE}/t_a/sso-connections`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset: 'header' }),
      },
      envOf(d1),
    )

    expect(res.status).toBe(422)
    expect(await tenantDb(d1).forOrg('t_a').ssoConnections.findOne()).toBeUndefined()
  })

  it('stores only a digest of a strong header proxy secret and rejects the public placeholder', async () => {
    const d1 = await seed()
    const app = buildApp(registerOrganizationsRoutes, { session: sessionFor('user_owner') })
    const create = (secret: string) =>
      app.request(
        `${BASE}/t_a/sso-connections`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            protocol: 'header',
            attribute_mapping: {
              _legacy: { trustedProxySecret: secret, headerEmail: 'X-Remote-Email' },
            },
          }),
        },
        envOf(d1),
      )

    const placeholder = await create('replace-with-proxy-secret')
    const strong = await create('a'.repeat(16) + 'B7#kq9Lm2Vx4Pz8W')

    expect(placeholder.status).toBe(422)
    expect(strong.status).toBe(201)
    const row = await tenantDb(d1).forOrg('t_a').ssoConnections.findOne()
    expect(JSON.stringify(row?.attributeMapping)).not.toContain('B7#kq9Lm2Vx4Pz8W')
    expect(JSON.stringify(row?.attributeMapping)).toContain('sha256:v1:')
  })

  it('keeps the SAML app preset and assignment gate when attributes are replaced', async () => {
    const d1 = await seed()
    const gate = { mode: 'restricted', allowed_roles: ['admin'], allowed_user_ids: [] }
    await tenantDb(d1).samlServiceProviders.insert({
      id: 'sap_1',
      tenantId: 't_a',
      orgId: 't_a',
      spEntityId: 'https://sp.example',
      acsUrl: 'https://sp.example/acs',
      idpSigningCertId: null,
      attributeMapping: { _xidPreset: 'salesforce', _xidAssignmentGate: gate, email: 'email' },
    })

    const res = await patch(d1, 'outbound-saml-apps/sap_1', {
      attribute_mapping: { mail: 'email' },
    })

    expect(res.status).toBe(200)
    const body = await json<{ provider: string; assignmentGate: { mode: string } }>(res)
    expect(body.provider).toBe('salesforce')
    expect(body.assignmentGate.mode).toBe('restricted')
  })
})
