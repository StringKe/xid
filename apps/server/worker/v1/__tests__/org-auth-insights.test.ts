// 认证设置页契约:MFA 策略覆盖与回落、登录方式统计、社交登录使用与停用时间、SSO / 出站 SAML 证书、
// 最近登录与活动游标、消息渠道 24 小时失败。真实 sqlite + 迁移链。

import { describe, expect, it, vi } from 'vitest'
import { schema } from '@xid-kit/db'
import { generateSelfSignedSamlCertificate } from '@xid-kit/saml'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
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

const BASE = 'https://acme.xid.dev/v1/organizations'
const DAY = 24 * 60 * 60 * 1000

type D1 = ReturnType<typeof makeDb>

async function seedInstance(d1: D1, mfaPolicy: string): Promise<void> {
  await drizzle(d1 as unknown as D1Database, { schema })
    .insert(schema.instances)
    .values({
      id: 'inst_1',
      name: 'Instance',
      primaryDomain: 'xid.dev',
      mfaPolicy,
      passwordPolicy: {},
      sessionPolicy: {},
    })
}

async function seedPeople(): Promise<D1> {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a', name: 'Northwind Logistics' })
  await seedUser(d1, { id: 'user_owner', email: 'dana@northwind.com' })
  await seedUser(d1, { id: 'user_member', email: 'wen@northwind.com' })
  await seedUser(d1, { id: 'user_crew', email: 'ana@fieldcrews.example' })
  await seedUser(d1, { id: 'user_outsider', email: 'out@northwind.com' })
  await seedMembership(d1, { id: 'mem_owner', userId: 'user_owner', orgId: 't_a', role: 'owner' })
  await seedMembership(d1, { id: 'mem_member', userId: 'user_member', orgId: 't_a' })
  await seedMembership(d1, { id: 'mem_crew', userId: 'user_crew', orgId: 't_a' })
  return d1
}

function request(
  d1: D1,
  path: string,
  init: { method?: string; body?: unknown; actor?: string; token?: string } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (init.token) headers['Authorization'] = `Bearer ${init.token}`
  return buildApp(registerOrganizationsRoutes, {
    session: init.token ? null : sessionFor(init.actor ?? 'user_owner'),
  }).request(
    `${BASE}/${path}`,
    {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    envOf(d1),
  )
}

async function seedAudit(
  d1: D1,
  input: {
    seq: number
    eventType: string
    targetId?: string
    meta?: Record<string, unknown>
    occurredAt?: string
  },
): Promise<void> {
  await tenantDb(d1).auditEvents.insert({
    seq: input.seq,
    id: `evt_${input.seq}`,
    tenantId: 't_a',
    orgId: 't_a',
    eventType: input.eventType,
    targetId: input.targetId ?? null,
    meta: input.meta ?? {},
    occurredAt: input.occurredAt ?? new Date(Date.now() - input.seq * 1000).toISOString(),
    prevHash: '0'.repeat(64),
    hash: String(input.seq).padStart(64, '0'),
  })
}

describe('auth-policy mfaPolicy', () => {
  it('writes an organization override and reports it as effective', async () => {
    const d1 = await seedPeople()
    await seedInstance(d1, 'disabled')

    const res = await request(d1, 't_a/auth-policy', {
      method: 'PATCH',
      body: { mfaPolicy: 'required' },
    })

    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body['mfaPolicy']).toBe('required')
    expect(body['effectiveMfaPolicy']).toBe('required')
  })

  it('falls back to the instance default when the override is cleared with null', async () => {
    const d1 = await seedPeople()
    await seedInstance(d1, 'disabled')
    await request(d1, 't_a/auth-policy', { method: 'PATCH', body: { mfaPolicy: 'required' } })

    await request(d1, 't_a/auth-policy', { method: 'PATCH', body: { mfaPolicy: null } })
    const res = await request(d1, 't_a/auth-policy')

    const body = await json(res)
    expect(body['mfaPolicy']).toBeNull()
    expect(body['effectiveMfaPolicy']).toBe('disabled')
    const row = await tenantDb(d1).forOrg('t_a').orgPolicies.findOne()
    expect(row?.mfaPolicy).toBeNull()
  })

  it('rejects an unknown mfaPolicy value with the field name', async () => {
    const d1 = await seedPeople()

    const res = await request(d1, 't_a/auth-policy', {
      method: 'PATCH',
      body: { mfaPolicy: 'sometimes' },
    })

    expect(res.status).toBe(422)
    expect((await json<{ meta: { paramName: string } }>(res)).meta.paramName).toBe('mfaPolicy')
  })

  it('returns 403 when platform-managed self-service lock is on', async () => {
    const d1 = await seedPeople()
    await tenantDb(d1).organizations.update(
      { allowOrgSelfService: false },
      eq(schema.organizations.id, 't_a'),
    )

    const res = await request(d1, 't_a/auth-policy', {
      method: 'PATCH',
      body: { mfaPolicy: 'required' },
    })

    expect(res.status).toBe(403)
    expect(await tenantDb(d1).forOrg('t_a').orgPolicies.findOne()).toBeUndefined()
  })

  it('records the changed field names in the audit details', async () => {
    const d1 = await seedPeople()
    const env = envOf(d1)

    await buildApp(registerOrganizationsRoutes, { session: sessionFor('user_owner') }).request(
      `${BASE}/t_a/auth-policy`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mfaPolicy: 'optional' }),
      },
      env,
    )

    const message = env.auditSend.mock.calls.at(-1)?.[0] as { action: string; payload: unknown }
    expect(message.action).toBe('organization.auth_policy.updated')
    expect(message.payload).toMatchObject({ fields: ['mfaPolicy'] })
  })
})

describe('auth-policy insights', () => {
  it('counts only active members for each sign-in method', async () => {
    const d1 = await seedPeople()
    const db = tenantDb(d1)
    const now = Date.now()
    for (const [id, userId, lastUsedAt] of [
      ['pk_1', 'user_owner', new Date(now - DAY)],
      ['pk_2', 'user_member', new Date(now - 40 * DAY)],
      ['pk_3', 'user_outsider', new Date(now - DAY)],
    ] as const) {
      await db.passkeyCredentials.insert({
        id,
        tenantId: 't_a',
        userId,
        credentialId: id,
        publicKey: Buffer.from([1]),
        coseAlg: -7,
        aaguid: Buffer.alloc(16),
        credentialDeviceType: 'multiDevice',
        lastUsedAt,
      })
    }
    for (const userId of ['user_member', 'user_crew', 'user_outsider']) {
      await db.passwords.insert({
        id: `pw_${userId}`,
        tenantId: 't_a',
        userId,
        hash: 'h',
        pepperVersion: 1,
      })
    }
    await db.mfaFactors.insert({
      id: 'mfa_1',
      tenantId: 't_a',
      userId: 'user_crew',
      factorType: 'totp',
      status: 'active',
    })
    await db.forOrg('t_a').organizationDomains.insert({
      id: 'dom_1',
      tenantId: 't_a',
      orgId: 't_a',
      domain: 'northwind.com',
      verificationToken: 'tok',
      verificationStatus: 'verified',
      verifiedAt: new Date(now - DAY),
    })

    const res = await request(d1, 't_a/auth-policy/insights')

    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body['passkeySignIns30d']).toBe(1)
    expect(body['passwordUserCount']).toBe(2)
    expect(body['usersWithoutSecondFactor']).toBe(0)
    expect(body['routedDomains']).toEqual([
      expect.objectContaining({ domain: 'northwind.com', verified: true, memberCount: 2 }),
    ])
  })

  it('reports members without any active factor or passkey', async () => {
    const d1 = await seedPeople()

    const body = await json(await request(d1, 't_a/auth-policy/insights'))

    expect(body['usersWithoutSecondFactor']).toBe(3)
    expect(body['routedDomains']).toEqual([])
  })
})

describe('social-providers activity', () => {
  async function seedGoogle(d1: D1, enabled: boolean): Promise<void> {
    await tenantDb(d1).organizations.update(
      {
        privateMetadata: {
          socialProviders: {
            google: {
              authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
              tokenEndpoint: 'https://oauth2.googleapis.com/token',
              clientId: 'client',
              issuer: 'https://accounts.google.com',
              jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
              scopes: ['openid', 'email'],
              usesPkce: true,
              enabled,
              allowLogin: enabled,
            },
          },
        },
      },
      eq(schema.organizations.id, 't_a'),
    )
  }

  it('counts members who used the provider in the last 30 days', async () => {
    const d1 = await seedPeople()
    await seedGoogle(d1, true)
    const db = tenantDb(d1)
    const now = Date.now()
    for (const [id, userId, lastUsedAt] of [
      ['idn_1', 'user_owner', new Date(now - DAY)],
      ['idn_2', 'user_member', new Date(now - 31 * DAY)],
      ['idn_3', 'user_outsider', new Date(now - DAY)],
    ] as const) {
      await db.userIdentities.insert({
        id,
        tenantId: 't_a',
        userId,
        identityType: 'oauth',
        provider: 'google',
        providerUserId: id,
        lastUsedAt,
      })
    }

    const body = await json<{ socialProviders: Record<string, Record<string, unknown>> }>(
      await request(d1, 't_a/social-providers'),
    )

    expect(body.socialProviders['google']).toMatchObject({ signIns30d: 1, disabledAt: null })
  })

  it('returns the time of the latest audit event that turned a provider off', async () => {
    const d1 = await seedPeople()
    await seedGoogle(d1, false)
    await seedAudit(d1, {
      seq: 1,
      eventType: 'organization.social_providers.updated',
      meta: { disabledProviders: ['google'] },
      occurredAt: '2026-08-01T00:00:00.000Z',
    })
    await seedAudit(d1, {
      seq: 2,
      eventType: 'organization.social_providers.updated',
      meta: { disabledProviders: ['google'] },
      occurredAt: '2026-08-12T00:00:00.000Z',
    })
    await seedAudit(d1, {
      seq: 3,
      eventType: 'organization.social_providers.updated',
      meta: { disabledProviders: ['github'] },
      occurredAt: '2026-08-20T00:00:00.000Z',
    })

    const body = await json<{ socialProviders: Record<string, Record<string, unknown>> }>(
      await request(d1, 't_a/social-providers'),
    )

    expect(body.socialProviders['google']?.['disabledAt']).toBe('2026-08-12T00:00:00.000Z')
  })

  it('audits which providers a PATCH turned off', async () => {
    const d1 = await seedPeople()
    await seedGoogle(d1, true)
    const env = envOf(d1)

    await buildApp(registerOrganizationsRoutes, { session: sessionFor('user_owner') }).request(
      `${BASE}/t_a/social-providers`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ socialProviders: { google: { enabled: false } } }),
      },
      env,
    )

    const message = env.auditSend.mock.calls.at(-1)?.[0] as { payload: unknown }
    expect(message.payload).toMatchObject({ disabledProviders: ['google'], enabledProviders: [] })
  })
})

describe('sso-connections certificates, routing and activity', () => {
  async function seedConnection(d1: D1, certificates: string[]): Promise<void> {
    await tenantDb(d1).forOrg('t_a').ssoConnections.insert({
      id: 'conn_1',
      tenantId: 't_a',
      orgId: 't_a',
      protocol: 'saml',
      idpEntityId: 'https://idp.example/entity',
      idpSsoUrl: 'https://idp.example/sso',
      idpCertificates: certificates,
    })
  }

  it('parses validity and fingerprint of each IdP certificate, including an expired one', async () => {
    const d1 = await seedPeople()
    const issued = Date.UTC(2020, 0, 1)
    const cert = await generateSelfSignedSamlCertificate('idp.example', issued)
    if (!cert.ok) throw new Error('certificate generation failed')
    await seedConnection(d1, [cert.value.certificateB64, 'not-a-certificate'])

    const body = await json<Record<string, unknown>[]>(await request(d1, 't_a/sso-connections'))

    expect(body[0]?.['idpCertificates']).toEqual([
      {
        fingerprintSha256: cert.value.fingerprint,
        notBefore: new Date(issued).toISOString(),
        notAfter: new Date(cert.value.notAfter).toISOString(),
      },
    ])
    expect(cert.value.notAfter).toBeLessThan(Date.now())
  })

  it('reports the latest sign-in through the connection', async () => {
    const d1 = await seedPeople()
    await seedConnection(d1, [])
    await tenantDb(d1).userIdentities.insert({
      id: 'idn_sso',
      tenantId: 't_a',
      userId: 'user_member',
      identityType: 'saml',
      provider: 'conn_1',
      providerUserId: 'wen',
      lastUsedAt: new Date('2026-09-01T10:00:00.000Z'),
    })

    const body = await json<Record<string, unknown>[]>(await request(d1, 't_a/sso-connections'))

    expect(body[0]?.['lastSignInAt']).toBe('2026-09-01T10:00:00.000Z')
  })

  it('pages connection activity newest first with a cursor', async () => {
    const d1 = await seedPeople()
    await seedConnection(d1, [])
    await seedAudit(d1, { seq: 1, eventType: 'sso_connection.created', targetId: 'conn_1' })
    await seedAudit(d1, { seq: 2, eventType: 'user.created', meta: { connectionId: 'conn_1' } })
    await seedAudit(d1, { seq: 3, eventType: 'sso_connection.updated', targetId: 'conn_1' })
    await seedAudit(d1, { seq: 4, eventType: 'webhook.created', targetId: 'wh_1' })

    const first = await json<{ data: { seq: number }[]; next_cursor: string; has_more: boolean }>(
      await request(d1, 't_a/sso-connections/conn_1/activity?limit=2'),
    )
    const second = await json<{ data: { seq: number }[]; has_more: boolean }>(
      await request(d1, `t_a/sso-connections/conn_1/activity?limit=2&cursor=${first.next_cursor}`),
    )

    expect(first.data.map((row) => row.seq)).toEqual([3, 2])
    expect(first.has_more).toBe(true)
    expect(second.data.map((row) => row.seq)).toEqual([1])
    expect(second.has_more).toBe(false)
  })

  it('rejects a malformed activity cursor', async () => {
    const d1 = await seedPeople()
    await seedConnection(d1, [])

    const res = await request(d1, 't_a/sso-connections/conn_1/activity?cursor=bm90LWEtc2Vx')

    expect(res.status).toBe(422)
  })

  it('rejects an out-of-range activity limit', async () => {
    const d1 = await seedPeople()
    await seedConnection(d1, [])

    const res = await request(d1, 't_a/sso-connections/conn_1/activity?limit=500')

    expect(res.status).toBe(422)
  })
})

describe('outbound-saml-apps signing certificates and last sign-in', () => {
  it('lists active and retiring IdP signing certificates and the latest assertion', async () => {
    const d1 = await seedPeople()
    const db = tenantDb(d1)
    const cert = await generateSelfSignedSamlCertificate('xid-idp')
    if (!cert.ok) throw new Error('certificate generation failed')
    for (const [id, status] of [
      ['cert_active', 'active'],
      ['cert_old', 'retired'],
    ] as const) {
      await db.certStore.insert({
        id,
        tenantId: 't_a',
        usage: 'saml_idp_signing',
        certificate: cert.value.certificateB64,
        privateKeyIv: Buffer.from([1]),
        privateKeyCiphertext: Buffer.from([1]),
        privateKeyTag: Buffer.from([1]),
        kekVersion: 1,
        status,
        notBefore: new Date(cert.value.notBefore),
        notAfter: new Date(cert.value.notAfter),
        fingerprint: cert.value.fingerprint,
      })
    }
    await db.samlServiceProviders.insert({
      id: 'sap_1',
      tenantId: 't_a',
      orgId: 't_a',
      spEntityId: 'https://sp.example',
      acsUrl: 'https://sp.example/acs',
      idpSigningCertId: 'cert_active',
    })
    await db.samlSessionBindings.insert({
      id: 'bind_1',
      tenantId: 't_a',
      direction: 'outbound',
      scopeId: 'sap_1',
      sessionIndex: 'si_1',
      userId: 'user_member',
      sessionId: 'sess_1',
      expiresAt: new Date(Date.now() + DAY),
      updatedAt: new Date('2026-09-02T08:00:00.000Z'),
    })

    const body = await json<Record<string, unknown>[]>(await request(d1, 't_a/outbound-saml-apps'))

    expect(body[0]?.['lastSignInAt']).toBe('2026-09-02T08:00:00.000Z')
    expect(body[0]?.['signingCertificates']).toEqual([
      expect.objectContaining({
        id: 'cert_active',
        status: 'active',
        fingerprint: cert.value.fingerprint,
        algorithm: { key: 'RSA', size: 2048, hash: 'SHA-256' },
      }),
    ])
  })

  it('pages app activity and 404s for an app of another organization', async () => {
    const d1 = await seedPeople()
    await seedOrg(d1, { id: 'org_child' })
    await tenantDb(d1).samlServiceProviders.insert({
      id: 'sap_child',
      tenantId: 't_a',
      orgId: 'org_child',
      spEntityId: 'https://sp.example',
      acsUrl: 'https://sp.example/acs',
    })

    const res = await request(d1, 't_a/outbound-saml-apps/sap_child/activity')

    expect(res.status).toBe(404)
  })
})

describe('delivery-channels failures24h', () => {
  async function seedFailure(
    d1: D1,
    input: { id: string; tenantId: string; channel: string; reason: string; ageMs: number },
  ): Promise<void> {
    await drizzle(d1 as unknown as D1Database, { schema })
      .insert(schema.notificationFailures)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        channel: input.channel,
        recipient: '+5511999990000',
        type: 'otp',
        payload: { code: 'otp-482913' },
        reason: input.reason,
        failedAt: new Date(Date.now() - input.ageMs).toISOString(),
      })
  }

  it('summarizes the last 24 hours per channel without recipients or payloads', async () => {
    const d1 = await seedPeople()
    await seedFailure(d1, {
      id: 'f1',
      tenantId: 't_a',
      channel: 'sms',
      reason: 'carrier_rejected',
      ageMs: 1000,
    })
    await seedFailure(d1, {
      id: 'f2',
      tenantId: 't_a',
      channel: 'sms',
      reason: 'carrier_rejected',
      ageMs: 2000,
    })
    await seedFailure(d1, {
      id: 'f3',
      tenantId: 't_a',
      channel: 'sms',
      reason: 'timeout',
      ageMs: 3000,
    })
    await seedFailure(d1, {
      id: 'f4',
      tenantId: 't_a',
      channel: 'email',
      reason: 'bounced',
      ageMs: 2 * DAY,
    })
    await seedFailure(d1, {
      id: 'f5',
      tenantId: 't_b',
      channel: 'email',
      reason: 'bounced',
      ageMs: 1000,
    })

    const res = await request(d1, 't_a/delivery-channels')
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(JSON.parse(text).failures24h).toEqual({
      email: { count: 0, topReason: null },
      sms: { count: 3, topReason: 'carrier_rejected' },
      whatsapp: { count: 0, topReason: null },
    })
    expect(text).not.toContain('+5511999990000')
    expect(text).not.toContain('otp-482913')
  })

  it('serves API key callers with organizations:read', async () => {
    const d1 = await seedPeople()
    const token = await seedApiKey(d1, { id: 'key_read', scopes: ['organizations:read'] })

    const res = await request(d1, 't_a/delivery-channels', { token })

    expect(res.status).toBe(200)
  })

  it('does not include another tenant failures', async () => {
    const d1 = await seedPeople()
    await seedOrg(d1, { id: 't_b', tenant: TENANT_B })
    await seedFailure(d1, { id: 'f5', tenantId: 't_b', channel: 'sms', reason: 'x', ageMs: 1000 })

    const body = await json<{ failures24h: { sms: { count: number } } }>(
      await request(d1, 't_a/delivery-channels'),
    )

    expect(body.failures24h.sms.count).toBe(0)
  })
})
