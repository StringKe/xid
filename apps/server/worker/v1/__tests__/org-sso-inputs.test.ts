// 企业 SSO 连接与出站 SAML 应用的保存期校验:模板占位符、内部映射键、metadata 同步导入、
// 落地页同源、NameID 格式,以及这些写入路径的跨租户隔离。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import { registerConnections } from '../connections'
import { registerOrganizationsRoutes } from '../organizations'
import {
  TENANT_B,
  buildApp,
  envOf,
  json,
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

const BASE = 'https://acme.xid.dev/v1/organizations/t_a'

const IDP_METADATA = `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://idp.acme-corp.test/entity">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>MIIBcert</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.acme-corp.test/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`

const SP_METADATA = `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://sp.acme-corp.test/saml">
  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Artifact" Location="https://sp.acme-corp.test/artifact" index="0"/>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.acme-corp.test/acs" index="1"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`

async function seed() {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a' })
  await seedOrg(d1, { id: 't_b', tenant: TENANT_B })
  await seedUser(d1, { id: 'user_a', email: 'a@acme.example' })
  await seedUser(d1, { id: 'user_b', tenant: TENANT_B, email: 'b@beta.example' })
  await seedMembership(d1, { id: 'mem_a', userId: 'user_a', orgId: 't_a', role: 'owner' })
  await seedMembership(d1, {
    id: 'mem_b',
    userId: 'user_b',
    orgId: 't_b',
    role: 'owner',
    tenant: TENANT_B,
  })
  return d1
}

function send(
  d1: ReturnType<typeof makeDb>,
  input: { method: string; path: string; body: Record<string, unknown>; tenantB?: boolean },
) {
  const app = buildApp(registerOrganizationsRoutes, {
    session: sessionFor(input.tenantB ? 'user_b' : 'user_a'),
    ...(input.tenantB ? { tenant: TENANT_B } : {}),
  })
  return app.request(
    `${BASE}/${input.path}`,
    {
      method: input.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input.body),
    },
    envOf(d1),
  )
}

const RETIREMENT = { certificate: 'MIIBold', retiredAt: Date.parse('2026-10-01T00:00:00Z') }

async function insertConnectionWithRetiredCertificate(d1: ReturnType<typeof makeDb>) {
  await tenantDb(d1)
    .forOrg('t_a')
    .ssoConnections.insert({
      id: 'conn_a',
      tenantId: 't_a',
      orgId: 't_a',
      protocol: 'saml',
      idpCertificates: ['MIIBnew', 'MIIBold'],
      idpCertificateRetirements: [RETIREMENT],
    })
}

function readConnection(d1: ReturnType<typeof makeDb>) {
  return tenantDb(d1).forOrg('t_a').ssoConnections.findOne(eq(schema.ssoConnections.id, 'conn_a'))
}

async function paramName(response: Response): Promise<unknown> {
  return (await json<{ meta: { paramName?: string } | null }>(response)).meta?.paramName
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('inbound SSO connection input', () => {
  it('rejects a metadata URL that still contains a preset template', async () => {
    const d1 = await seed()

    const res = await send(d1, {
      method: 'POST',
      path: 'sso-connections',
      body: {
        preset: 'okta',
        idp_metadata_url: 'https://{oktaDomain}/app/{appId}/sso/saml/metadata',
      },
    })

    expect(res.status).toBe(422)
    expect(await paramName(res)).toBe('idp_metadata_url')
  })

  it('stores no template URL when a preset is created without metadata', async () => {
    const d1 = await seed()

    const res = await send(d1, {
      method: 'POST',
      path: 'sso-connections',
      body: { preset: 'okta' },
    })

    expect(res.status).toBe(201)
    const body = await json<Record<string, unknown>>(res)
    expect(body['idp_metadata_url']).toBeNull()
    expect(body['want_authn_response_signed']).toBe(true)
  })

  it('applies the assertion-only signature default of the Entra preset', async () => {
    const d1 = await seed()

    const res = await send(d1, {
      method: 'POST',
      path: 'sso-connections',
      body: { preset: 'microsoft-entra' },
    })

    const body = await json<Record<string, unknown>>(res)
    expect(body['want_authn_response_signed']).toBe(false)
    expect(body['want_assertions_signed']).toBe(true)
  })

  it('rejects an OIDC connection created from a SAML-only preset', async () => {
    const d1 = await seed()

    const res = await send(d1, {
      method: 'POST',
      path: 'sso-connections',
      body: { preset: 'okta', protocol: 'oidc' },
    })

    expect(res.status).toBe(422)
    expect(await paramName(res)).toBe('protocol')
  })

  it('rejects client-supplied server-owned mapping keys', async () => {
    const d1 = await seed()

    const res = await send(d1, {
      method: 'POST',
      path: 'sso-connections',
      body: { protocol: 'saml', attribute_mapping: { email: 'mail', _swaVault: { x: 1 } } },
    })

    expect(res.status).toBe(422)
    expect(await paramName(res)).toBe('attribute_mapping._swaVault')
  })

  it('imports entity ID, sign-in URL and certificates from uploaded metadata XML', async () => {
    const d1 = await seed()

    const res = await send(d1, {
      method: 'POST',
      path: 'sso-connections',
      body: { protocol: 'saml', idp_metadata_xml: IDP_METADATA },
    })

    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({
      idp_entity_id: 'https://idp.acme-corp.test/entity',
      idp_sso_url: 'https://idp.acme-corp.test/sso',
      idp_certificates: ['MIIBcert'],
      idp_metadata_source: 'xml',
    })
    const row = await tenantDb(d1).forOrg('t_a').ssoConnections.findOne()
    expect(row?.idpMetadataXml).toBe(IDP_METADATA)
  })

  it('fetches the metadata URL when the connection is saved', async () => {
    const d1 = await seed()
    const fetchMock = vi.fn().mockResolvedValue(new Response(IDP_METADATA, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await send(d1, {
      method: 'POST',
      path: 'sso-connections',
      body: { protocol: 'saml', idp_metadata_url: 'https://idp.acme-corp.test/metadata' },
    })

    expect(res.status).toBe(201)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(await json(res)).toMatchObject({ idp_sso_url: 'https://idp.acme-corp.test/sso' })
  })

  it('returns 422 on the metadata URL when the IdP answers with an error', async () => {
    const d1 = await seed()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })))

    const res = await send(d1, {
      method: 'POST',
      path: 'sso-connections',
      body: { protocol: 'saml', idp_metadata_url: 'https://idp.acme-corp.test/metadata' },
    })

    expect(res.status).toBe(422)
    expect(await paramName(res)).toBe('idp_metadata_url')
  })

  it('rejects uploaded XML that is not IdP metadata', async () => {
    const d1 = await seed()

    const res = await send(d1, {
      method: 'POST',
      path: 'sso-connections',
      body: { protocol: 'saml', idp_metadata_xml: '<html></html>' },
    })

    expect(res.status).toBe(422)
    expect(await paramName(res)).toBe('idp_metadata_xml')
  })

  it('stores a same-origin landing page and rejects another origin', async () => {
    const d1 = await seed()
    const created = await send(d1, {
      method: 'POST',
      path: 'sso-connections',
      body: { protocol: 'saml', relay_state_url: '/account' },
    })
    const id = (await json<{ id: string }>(created)).id

    const rejected = await send(d1, {
      method: 'PATCH',
      path: `sso-connections/${id}`,
      body: { relay_state_url: 'https://evil.example/landing' },
    })

    expect(created.status).toBe(201)
    const row = await tenantDb(d1)
      .forOrg('t_a')
      .ssoConnections.findOne(eq(schema.ssoConnections.id, id))
    expect(row?.relayStateUrl).toBe('https://acme.xid.dev/account')
    expect(rejected.status).toBe(422)
    expect(await paramName(rejected)).toBe('relay_state_url')
  })

  it('clears the retained metadata certificates when an admin saves certificates', async () => {
    const d1 = await seed()
    await insertConnectionWithRetiredCertificate(d1)

    const res = await send(d1, {
      method: 'PATCH',
      path: 'sso-connections/conn_a',
      body: { idp_certificates: ['MIIBmanual'] },
    })

    expect(res.status).toBe(200)
    const row = await readConnection(d1)
    expect(row?.idpCertificates).toEqual(['MIIBmanual'])
    expect(row?.idpCertificateRetirements).toBeNull()
  })

  it('keeps the retained metadata certificates when the patch does not touch certificates', async () => {
    const d1 = await seed()
    await insertConnectionWithRetiredCertificate(d1)

    await send(d1, {
      method: 'PATCH',
      path: 'sso-connections/conn_a',
      body: { display_name: 'Acme IdP' },
    })

    const row = await readConnection(d1)
    expect(row?.idpCertificateRetirements).toEqual([RETIREMENT])
  })

  it('keeps another tenant from patching the connection with new fields', async () => {
    const d1 = await seed()
    await tenantDb(d1).forOrg('t_a').ssoConnections.insert({
      id: 'conn_a',
      tenantId: 't_a',
      orgId: 't_a',
      protocol: 'saml',
    })

    const res = await send(d1, {
      method: 'PATCH',
      path: 'sso-connections/conn_a',
      body: { idp_metadata_xml: IDP_METADATA, relay_state_url: '/account' },
      tenantB: true,
    })

    expect([403, 404]).toContain(res.status)
    const row = await tenantDb(d1)
      .forOrg('t_a')
      .ssoConnections.findOne(eq(schema.ssoConnections.id, 'conn_a'))
    expect(row?.idpEntityId).toBeNull()
  })
})

describe('/v1/connections input', () => {
  it('rejects client-supplied SWA vault keys', async () => {
    const d1 = await seed()
    const token = await seedApiKey(d1, { id: 'key_a', scopes: ['connections:write'] })

    const res = await buildApp(registerConnections).request(
      'https://acme.xid.dev/v1/connections',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: 't_a',
          protocol: 'saml',
          attribute_mapping: { _swaVaultEnvelope: { ciphertext: 'x' } },
        }),
      },
      envOf(d1),
    )

    expect(res.status).toBe(422)
    expect(await paramName(res)).toBe('attribute_mapping._swaVaultEnvelope')
  })

  it('clears the retained metadata certificates when certificates are saved through the API', async () => {
    const d1 = await seed()
    await insertConnectionWithRetiredCertificate(d1)
    const token = await seedApiKey(d1, { id: 'key_a', scopes: ['connections:write'] })

    const res = await buildApp(registerConnections).request(
      'https://acme.xid.dev/v1/connections/conn_a',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ idp_certificates: ['MIIBmanual'] }),
      },
      envOf(d1),
    )

    expect(res.status).toBe(200)
    expect((await readConnection(d1))?.idpCertificateRetirements).toBeNull()
  })

  it('does not let another tenant create a connection for this organization', async () => {
    const d1 = await seed()
    const token = await seedApiKey(d1, {
      id: 'key_b',
      scopes: ['connections:write'],
      tenant: TENANT_B,
    })

    const res = await buildApp(registerConnections, { tenant: TENANT_B }).request(
      'https://acme.xid.dev/v1/connections',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: 't_a', protocol: 'saml', idp_metadata_xml: IDP_METADATA }),
      },
      envOf(d1),
    )

    expect(res.status).toBe(404)
    expect(await tenantDb(d1).forOrg('t_a').ssoConnections.findOne()).toBeUndefined()
  })
})

describe('outbound SAML app input', () => {
  it('rejects a preset Entity ID that still contains a template', async () => {
    const d1 = await seed()

    const res = await send(d1, {
      method: 'POST',
      path: 'outbound-saml-apps',
      body: {
        preset: 'github-enterprise',
        acs_url: 'https://github.com/enterprises/acme/saml/consume',
      },
    })

    expect(res.status).toBe(422)
    expect(await paramName(res)).toBe('sp_entity_id')
  })

  it('rejects an unsupported NameID format', async () => {
    const d1 = await seed()

    const res = await send(d1, {
      method: 'POST',
      path: 'outbound-saml-apps',
      body: {
        sp_entity_id: 'https://sp.acme-corp.test/saml',
        acs_url: 'https://sp.acme-corp.test/acs',
        name_id_format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:kerberos',
      },
    })

    expect(res.status).toBe(422)
    expect(await paramName(res)).toBe('name_id_format')
  })

  it('imports Entity ID and the HTTP-POST ACS from SP metadata XML', async () => {
    const d1 = await seed()

    const res = await send(d1, {
      method: 'POST',
      path: 'outbound-saml-apps',
      body: { sp_metadata_xml: SP_METADATA },
    })

    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({
      spEntityId: 'https://sp.acme-corp.test/saml',
      acsUrl: 'https://sp.acme-corp.test/acs',
    })
  })

  it('rejects client-supplied assignment gate internals in the attribute mapping', async () => {
    const d1 = await seed()

    const res = await send(d1, {
      method: 'POST',
      path: 'outbound-saml-apps',
      body: {
        sp_entity_id: 'https://sp.acme-corp.test/saml',
        acs_url: 'https://sp.acme-corp.test/acs',
        attribute_mapping: { _xidAssignmentGate: { mode: 'all' } },
      },
    })

    expect(res.status).toBe(422)
    expect(await paramName(res)).toBe('attribute_mapping._xidAssignmentGate')
  })

  it('removes the pairwise NameIDs of an app when the app is deleted', async () => {
    const d1 = await seed()
    const created = await send(d1, {
      method: 'POST',
      path: 'outbound-saml-apps',
      body: { sp_metadata_xml: SP_METADATA },
    })
    const appId = (await json<{ id: string }>(created)).id
    await tenantDb(d1).samlPersistentNameIds.insertMany([
      { tenantId: 't_a', spId: appId, userId: 'user_a', nameId: 'pairwise-a' },
      { tenantId: 't_a', spId: 'sap_other', userId: 'user_a', nameId: 'pairwise-other' },
    ])

    const res = await buildApp(registerOrganizationsRoutes, {
      session: sessionFor('user_a'),
    }).request(`${BASE}/outbound-saml-apps/${appId}`, { method: 'DELETE' }, envOf(d1))

    expect(res.status).toBe(204)
    const remaining = await tenantDb(d1).samlPersistentNameIds.findMany()
    expect(remaining.map((row) => row.spId)).toEqual(['sap_other'])
  })

  it('keeps another tenant from importing SP metadata into this organization', async () => {
    const d1 = await seed()

    const res = await send(d1, {
      method: 'POST',
      path: 'outbound-saml-apps',
      body: { sp_metadata_xml: SP_METADATA },
      tenantB: true,
    })

    expect([403, 404]).toContain(res.status)
    expect(await tenantDb(d1).samlServiceProviders.findMany()).toHaveLength(0)
  })
})
