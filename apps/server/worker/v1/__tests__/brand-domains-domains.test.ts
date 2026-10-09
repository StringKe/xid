// 邮件域名立即检查与列表补充字段、登录域名的 passkey 影响人数与 DNS 记录状态。真实 sqlite + 迁移链。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCustomHostnameRoutes } from '../custom-hostnames'
import { registerOrgDomainsRoutes } from '../org-domains'
import {
  TENANT_B,
  buildApp,
  envOf,
  json,
  makeDb,
  seedApiKey,
  seedOrg,
  seedUser,
  tenantDb,
} from './console-fixtures'
import { seedAudit, seedDomain, seedSsoConnection } from './governance-fixtures'
import type { SqliteD1 } from '../../../../../packages/db/src/__tests__/sqlite-d1'
import type { TenantContext } from '@xid-kit/types'

const BASE = 'https://acme.xid.dev/v1/organizations/t_a'

type Domain = {
  id: string
  verification_status: string
  user_count: number
  routed_connection: { id: string; name: string | null } | null
  added_by: { kind: string; id: string; display_name: string | null } | null
  last_checked_at: string | null
  last_check_result: string | null
}

async function setup() {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a', name: 'Northwind Logistics' })
  await seedOrg(d1, { id: 'org_fin', name: 'Finance' })
  const token = await seedApiKey(d1, {
    id: 'ak_dom',
    scopes: ['organization_domains:read', 'organization_domains:write', 'custom_hostnames:read'],
  })
  const env = envOf(d1)
  const app = buildApp((parent) => {
    registerOrgDomainsRoutes(parent)
    registerCustomHostnameRoutes(parent)
  })
  const headers = { Authorization: `Bearer ${token}` }
  const get = (path: string) => app.request(`${BASE}${path}`, { headers }, env)
  const post = (path: string) => app.request(`${BASE}${path}`, { method: 'POST', headers }, env)
  return { d1, env, get, post }
}

function stubTxtAnswer(values: string[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(Response.json({ Answer: values.map((value) => ({ data: `"${value}"` })) }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('email domain list', () => {
  it('returns user count, routed SSO connection, creator and last check per domain', async () => {
    const { d1, get } = await setup()
    await seedDomain(d1, { id: 'dom_com', orgId: 't_a', domain: 'northwind.com', verified: true })
    await seedDomain(d1, { id: 'dom_de', orgId: 't_a', domain: 'northwind.de' })
    await seedSsoConnection(d1, { id: 'sso_1', orgId: 't_a', certificates: [], name: 'Okta' })
    await seedUser(d1, { id: 'u_dana', email: 'dana@northwind.com', firstName: 'Dana' })
    await seedUser(d1, { id: 'u_lee', email: 'lee@NORTHWIND.com' })
    await seedUser(d1, { id: 'u_other', email: 'kim@sub.northwind.com.evil' })
    await seedAudit(d1, {
      seq: 1,
      eventType: 'organization_domain.created',
      occurredAt: '2026-10-06T10:00:00.000Z',
      actorId: 'u_dana',
      targetType: 'organization_domain',
      targetId: 'dom_de',
    })

    const body = await json<{ data: Domain[] }>(await get('/domains'))
    const byId = new Map(body.data.map((row) => [row.id, row]))

    expect(byId.get('dom_com')).toMatchObject({
      user_count: 2,
      routed_connection: { id: 'sso_1', name: 'Okta' },
      added_by: null,
    })
    expect(byId.get('dom_de')).toMatchObject({
      user_count: 0,
      routed_connection: null,
      added_by: { kind: 'user', id: 'u_dana', display_name: 'Dana' },
      last_checked_at: null,
    })
  })
})

describe('POST /domains/:domainId/verify', () => {
  it('marks the domain verified when the TXT record is found', async () => {
    const { d1, post, env } = await setup()
    await seedDomain(d1, { id: 'dom_de', orgId: 't_a', domain: 'northwind.de' })
    const fetchMock = stubTxtAnswer(['xid-verify=token_dom_de'])

    const res = await post('/domains/dom_de/verify')
    const body = await json<Domain>(res)

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloudflare-dns.com/dns-query?name=_xid.northwind.de&type=TXT',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(body).toMatchObject({ verification_status: 'verified', last_check_result: 'found' })
    expect(body.last_checked_at).not.toBeNull()
    expect(env.auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'organization.domain.verification_checked',
        payload: expect.objectContaining({ domain: 'northwind.de', result: 'found' }),
      }),
    )
  })

  it('records not_found and keeps the domain pending when the record is missing', async () => {
    const { d1, post } = await setup()
    await seedDomain(d1, { id: 'dom_de', orgId: 't_a', domain: 'northwind.de' })
    stubTxtAnswer(['xid-verify=someone-else'])

    const body = await json<Domain>(await post('/domains/dom_de/verify'))

    expect(body).toMatchObject({ verification_status: 'pending', last_check_result: 'not_found' })
  })

  it('returns 503 and writes nothing when the DNS lookup times out', async () => {
    const { d1, post } = await setup()
    await seedDomain(d1, { id: 'dom_de', orgId: 't_a', domain: 'northwind.de' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')))

    const res = await post('/domains/dom_de/verify')
    const row = (await tenantDb(d1).organizationDomains.findMany())[0]!

    expect(res.status).toBe(503)
    expect(row.lastCheckedAt).toBeNull()
  })

  it('returns 404 for a domain of another organization in the same tenant', async () => {
    const { d1, post } = await setup()
    await seedDomain(d1, { id: 'dom_fin', orgId: 'org_fin', domain: 'finance.example' })
    const fetchMock = stubTxtAnswer([])

    const res = await post('/domains/dom_fin/verify')

    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

async function seedPasskey(
  d1: SqliteD1,
  id: string,
  userId: string,
  options: { revoked?: boolean; tenant?: TenantContext } = {},
) {
  const tenant = options.tenant ?? undefined
  await tenantDb(d1, tenant).passkeyCredentials.insert({
    id,
    tenantId: (tenant ?? { tenantId: 't_a' }).tenantId,
    userId,
    credentialId: `cred_${id}`,
    publicKey: Buffer.from([1]),
    coseAlg: -7,
    aaguid: Buffer.alloc(16),
    credentialDeviceType: 'multiDevice',
    revokedAt: options.revoked ? new Date(1000) : null,
  })
}

async function seedHostname(
  d1: SqliteD1,
  overrides: { hostnameStatus: string; sslStatus: string | null },
) {
  await tenantDb(d1).customHostnames.insert({
    id: 'ch_1',
    tenantId: 't_a',
    orgId: 't_a',
    instanceId: 'inst_1',
    hostname: 'auth.northwind.com',
    status: 'pending',
    cloudflareHostnameId: 'cf_1',
    ownershipVerificationType: 'txt',
    ownershipVerificationName: '_cf-custom-hostname.auth.northwind.com',
    ownershipVerificationValue: 'ownership',
    trafficCnameTarget: 'customers.xid.dev',
    ...overrides,
  })
}

describe('custom hostname detail', () => {
  it('counts people with active passkeys in this tenant only', async () => {
    const { d1, get } = await setup()
    await seedHostname(d1, { hostnameStatus: 'active', sslStatus: 'pending_validation' })
    await seedPasskey(d1, 'pk_1', 'u_1')
    await seedPasskey(d1, 'pk_2', 'u_1')
    await seedPasskey(d1, 'pk_3', 'u_2')
    await seedPasskey(d1, 'pk_4', 'u_3', { revoked: true })
    await seedPasskey(d1, 'pk_b', 'u_b', { tenant: TENANT_B })

    const body = await json<{
      affected_passkey_user_count: number
      dns_checks: { txt: string; cname: string }
    }>(await get('/custom-hostnames/ch_1'))

    expect(body.affected_passkey_user_count).toBe(2)
    expect(body.dns_checks).toEqual({ txt: 'found', cname: 'pending' })
  })

  it('reports the CNAME as found once the certificate is active', async () => {
    const { d1, get } = await setup()
    await seedHostname(d1, { hostnameStatus: 'active', sslStatus: 'active' })

    const body = await json<{ data: { dns_checks: { txt: string; cname: string } }[] }>(
      await get('/custom-hostnames'),
    )

    expect(body.data[0]!.dns_checks).toEqual({ txt: 'found', cname: 'found' })
  })
})
