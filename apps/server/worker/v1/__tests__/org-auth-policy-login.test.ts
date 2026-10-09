// auth-policy 的登录限制(org_policies.force_sso / allow_password_login)与 direct attestation 前置条件:
// 强制 SSO 需要 active 企业连接,direct 需要实例或租户可信根;自助锁与跨租户访问不得写入。

import { describe, expect, it, vi } from 'vitest'
import { schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import { registerOrganizationsRoutes } from '../organizations'
import { trustedRootsKvKey } from '../webauthn-trusted-roots'
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
import type { FakeEnv } from './console-fixtures'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

const BASE = 'https://acme.xid.dev/v1/organizations'

type D1 = ReturnType<typeof makeDb>

async function seedOwner(): Promise<D1> {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a' })
  await seedOrg(d1, { id: 't_b', tenant: TENANT_B })
  await seedUser(d1, { id: 'user_owner', email: 'dana@acme.example' })
  await seedUser(d1, { id: 'user_b', tenant: TENANT_B, email: 'b@beta.example' })
  await seedMembership(d1, { id: 'mem_owner', userId: 'user_owner', orgId: 't_a', role: 'owner' })
  await seedMembership(d1, {
    id: 'mem_b',
    userId: 'user_b',
    orgId: 't_b',
    role: 'owner',
    tenant: TENANT_B,
  })
  return d1
}

async function seedSsoConnection(d1: D1, status: string, protocol = 'saml'): Promise<void> {
  await tenantDb(d1).forOrg('t_a').ssoConnections.insert({
    id: 'conn_a',
    tenantId: 't_a',
    orgId: 't_a',
    protocol,
    status,
  })
}

function patch(
  env: FakeEnv,
  body: unknown,
  options: { actor?: string; token?: string; tenant?: typeof TENANT_B } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`
  return buildApp(registerOrganizationsRoutes, {
    tenant: options.tenant,
    session: options.token ? null : sessionFor(options.actor ?? 'user_owner'),
  }).request(
    `${BASE}/t_a/auth-policy`,
    { method: 'PATCH', headers, body: JSON.stringify(body) },
    env,
  )
}

function get(env: FakeEnv) {
  return buildApp(registerOrganizationsRoutes, { session: sessionFor('user_owner') }).request(
    `${BASE}/t_a/auth-policy`,
    {},
    env,
  )
}

describe('auth-policy loginPolicy', () => {
  it('reports the column defaults when the organization has no policy row', async () => {
    const env = envOf(await seedOwner())

    const body = await json(await get(env))

    expect(body['loginPolicy']).toEqual({ forceSso: false, allowPasswordLogin: true })
  })

  it('rejects requiring SSO when the organization has no active connection', async () => {
    const d1 = await seedOwner()
    await seedSsoConnection(d1, 'disabled')

    const res = await patch(envOf(d1), { loginPolicy: { forceSso: true } })

    expect(res.status).toBe(422)
    expect((await json(res))['meta']).toEqual({ paramName: 'loginPolicy.forceSso' })
    expect(await tenantDb(d1).forOrg('t_a').orgPolicies.findOne()).toBeUndefined()
  })

  it('rejects requiring SSO when the only active connection is not routed by email domain', async () => {
    const d1 = await seedOwner()
    await seedSsoConnection(d1, 'active', 'swa')

    const res = await patch(envOf(d1), { loginPolicy: { forceSso: true } })

    expect(res.status).toBe(422)
    expect((await json(res))['meta']).toEqual({ paramName: 'loginPolicy.forceSso' })
  })

  it('rejects turning on hostedAuth.forceSso when the organization has no active connection', async () => {
    const d1 = await seedOwner()

    const res = await patch(envOf(d1), { hostedAuth: { forceSso: true } })

    expect(res.status).toBe(422)
    expect((await json(res))['meta']).toEqual({ paramName: 'hostedAuth.forceSso' })
  })

  it('stores forceSso and allowPasswordLogin when an active connection exists', async () => {
    const d1 = await seedOwner()
    await seedSsoConnection(d1, 'active')

    const res = await patch(envOf(d1), {
      loginPolicy: { forceSso: true, allowPasswordLogin: false },
    })

    expect(res.status).toBe(200)
    expect((await json(res))['loginPolicy']).toEqual({
      forceSso: true,
      allowPasswordLogin: false,
    })
    const row = await tenantDb(d1).forOrg('t_a').orgPolicies.findOne()
    expect(row?.forceSso).toBe(true)
    expect(row?.allowPasswordLogin).toBe(false)
  })

  it('turns forceSso off without requiring a connection', async () => {
    const d1 = await seedOwner()
    await seedSsoConnection(d1, 'active')
    const env = envOf(d1)
    await patch(env, { loginPolicy: { forceSso: true } })
    await tenantDb(d1)
      .forOrg('t_a')
      .ssoConnections.update({ status: 'disabled' }, eq(schema.ssoConnections.id, 'conn_a'))

    const res = await patch(env, { loginPolicy: { forceSso: false } })

    expect(res.status).toBe(200)
    expect((await tenantDb(d1).forOrg('t_a').orgPolicies.findOne())?.forceSso).toBe(false)
  })

  it('rejects a non-boolean allowPasswordLogin with the field name', async () => {
    const d1 = await seedOwner()

    const res = await patch(envOf(d1), { loginPolicy: { allowPasswordLogin: 'no' } })

    expect(res.status).toBe(422)
    expect((await json(res))['meta']).toEqual({ paramName: 'loginPolicy.allowPasswordLogin' })
  })

  it('rejects an empty loginPolicy object', async () => {
    const d1 = await seedOwner()

    const res = await patch(envOf(d1), { loginPolicy: {} })

    expect(res.status).toBe(422)
    expect((await json(res))['meta']).toEqual({ paramName: 'loginPolicy' })
  })

  it('forbids an organization admin from changing it when self-service is off', async () => {
    const d1 = await seedOwner()
    await seedSsoConnection(d1, 'active')
    await tenantDb(d1).organizations.update(
      { allowOrgSelfService: false },
      eq(schema.organizations.id, 't_a'),
    )

    const res = await patch(envOf(d1), { loginPolicy: { allowPasswordLogin: false } })

    expect(res.status).toBe(403)
    expect(await tenantDb(d1).forOrg('t_a').orgPolicies.findOne()).toBeUndefined()
  })

  it('returns 404 and writes nothing for a tenant B session', async () => {
    const d1 = await seedOwner()
    await seedSsoConnection(d1, 'active')

    const res = await patch(
      envOf(d1),
      { loginPolicy: { forceSso: true, allowPasswordLogin: false } },
      { actor: 'user_b', tenant: TENANT_B },
    )

    expect(res.status).toBe(404)
    expect(await tenantDb(d1).forOrg('t_a').orgPolicies.findOne()).toBeUndefined()
  })

  it('returns 404 and writes nothing for a tenant B API key', async () => {
    const d1 = await seedOwner()
    await seedSsoConnection(d1, 'active')
    const token = await seedApiKey(d1, { id: 'key_b', scopes: ['*'], tenant: TENANT_B })

    const res = await patch(
      envOf(d1),
      { loginPolicy: { forceSso: true } },
      { token, tenant: TENANT_B },
    )

    expect(res.status).toBe(404)
    expect(await tenantDb(d1).forOrg('t_a').orgPolicies.findOne()).toBeUndefined()
  })
})

describe('auth-policy direct attestation', () => {
  const ROOT_PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'

  it('rejects direct when neither the instance nor the tenant has trusted roots', async () => {
    const d1 = await seedOwner()

    const res = await patch(envOf(d1), { hostedAuth: { attestationMode: 'direct' } })

    expect(res.status).toBe(422)
    expect((await json(res))['meta']).toEqual({ paramName: 'hostedAuth.attestationMode' })
  })

  it('accepts direct when the tenant has trusted roots in KV', async () => {
    const env = envOf(await seedOwner())
    await env.CACHE.put(trustedRootsKvKey('t_a'), ROOT_PEM)

    const res = await patch(env, { hostedAuth: { attestationMode: 'direct' } })

    expect(res.status).toBe(200)
    const body = await json<{ hostedAuth: { attestationMode: string } }>(res)
    expect(body.hostedAuth.attestationMode).toBe('direct')
  })

  it('accepts direct when only instance-level roots are configured', async () => {
    const env = { ...envOf(await seedOwner()), WEBAUTHN_TRUSTED_ROOTS_PEM: ROOT_PEM }

    const res = await patch(env, { hostedAuth: { attestationMode: 'direct' } })

    expect(res.status).toBe(200)
    expect((await json(res))['attestationRootsConfigured']).toBe(true)
  })

  it('does not count another tenant roots for this tenant', async () => {
    const env = envOf(await seedOwner())
    await env.CACHE.put(trustedRootsKvKey('t_b'), ROOT_PEM)

    const res = await patch(env, { hostedAuth: { attestationMode: 'direct' } })

    expect(res.status).toBe(422)
  })

  it('keeps saving other fields after roots are removed from a direct policy', async () => {
    const env = envOf(await seedOwner())
    await env.CACHE.put(trustedRootsKvKey('t_a'), ROOT_PEM)
    await patch(env, { hostedAuth: { attestationMode: 'direct' } })
    await env.CACHE.delete(trustedRootsKvKey('t_a'))

    const res = await patch(env, {
      hostedAuth: { attestationMode: 'direct', requireVerifiedEmail: false },
    })

    expect(res.status).toBe(200)
    expect((await json(res))['attestationRootsConfigured']).toBe(false)
  })
})
