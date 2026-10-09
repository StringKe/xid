// 投递渠道与社交登录配置的保存期校验:未知 provider、发送方格式、多租户发送方修改权限、
// 端点与必填项,以及这些写入路径的跨租户隔离。

import { describe, expect, it, vi } from 'vitest'
import { schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import { registerOrganizationsRoutes } from '../organizations'
import {
  TENANT_B,
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

const BASE = 'https://acme.xid.dev/v1/organizations/t_a'

const TWILIO_SMS = { provider: 'twilio', secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] }

const GOOGLE = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  clientId: 'google-client',
  issuer: 'https://accounts.google.com',
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
  scopes: ['openid', 'email'],
  enabled: true,
}

async function seed(options: { mode?: 'multi_tenant' | 'single_tenant' } = {}) {
  const d1 = makeDb()
  if (options.mode) {
    d1.database
      .prepare(
        `INSERT INTO instances (id, name, primary_domain, mode, password_policy, session_policy, created_at, updated_at)
         VALUES ('inst_1', 'Acme', 'xid.dev', ?, '{}', '{}', 0, 0)`,
      )
      .run(options.mode)
  }
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

function patch(
  d1: ReturnType<typeof makeDb>,
  path: string,
  body: Record<string, unknown>,
  options: { tenantB?: boolean } = {},
) {
  const app = buildApp(registerOrganizationsRoutes, {
    session: sessionFor(options.tenantB ? 'user_b' : 'user_a'),
    ...(options.tenantB ? { tenant: TENANT_B } : {}),
  })
  return app.request(
    `${BASE}/${path}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    envOf(d1),
  )
}

async function paramName(response: Response): Promise<unknown> {
  return (await json<{ meta: { paramName?: string } | null }>(response)).meta?.paramName
}

async function storedMetadata(d1: ReturnType<typeof makeDb>): Promise<Record<string, unknown>> {
  const org = await tenantDb(d1).organizations.findOne(eq(schema.organizations.id, 't_a'))
  return (org?.privateMetadata ?? {}) as Record<string, unknown>
}

describe('delivery channel input', () => {
  it('rejects an unknown SMS provider instead of keeping the previous one', async () => {
    const d1 = await seed()

    const res = await patch(d1, 'delivery-channels', {
      sms: { provider: 'carrier-pigeon', secretRefs: [] },
    })

    expect(res.status).toBe(422)
    expect(await paramName(res)).toBe('sms.provider')
  })

  it('rejects an SMS sender that is neither E.164 nor an 11-character sender ID', async () => {
    const d1 = await seed()

    const res = await patch(d1, 'delivery-channels', {
      sms: { ...TWILIO_SMS, from: 'Acme Corporation Ltd' },
    })

    expect(res.status).toBe(422)
    expect(await paramName(res)).toBe('sms.from')
  })

  it('rejects an alphanumeric WhatsApp sender', async () => {
    const d1 = await seed()

    const res = await patch(d1, 'delivery-channels', {
      whatsapp: { provider: 'twilio', from: 'ACME' },
    })

    expect(res.status).toBe(422)
    expect(await paramName(res)).toBe('whatsapp.from')
  })

  it('accepts enabling Meta WhatsApp without a sender', async () => {
    const d1 = await seed()

    const res = await patch(d1, 'delivery-channels', {
      whatsapp: { provider: 'meta', enabled: true },
    })

    expect(res.status).toBe(200)
  })

  it('accepts an alphanumeric SMS sender on a single-tenant instance', async () => {
    const d1 = await seed({ mode: 'single_tenant' })

    const res = await patch(d1, 'delivery-channels', { sms: { ...TWILIO_SMS, from: 'ACME' } })

    expect(res.status).toBe(200)
    expect(await storedMetadata(d1)).toMatchObject({ deliveryChannels: { sms: { from: 'ACME' } } })
  })

  it('refuses an organization admin changing the sender on a multi-tenant instance', async () => {
    const d1 = await seed({ mode: 'multi_tenant' })

    const res = await patch(d1, 'delivery-channels', {
      sms: { ...TWILIO_SMS, from: '+15550000000' },
    })

    expect(res.status).toBe(403)
    expect(await storedMetadata(d1)).not.toHaveProperty('deliveryChannels')
  })

  it('keeps another tenant from changing this organization channels', async () => {
    const d1 = await seed()

    const res = await patch(
      d1,
      'delivery-channels',
      { sms: { ...TWILIO_SMS, from: '+15550000000' } },
      { tenantB: true },
    )

    expect([403, 404]).toContain(res.status)
    expect(await storedMetadata(d1)).not.toHaveProperty('deliveryChannels')
  })
})

describe('social provider input', () => {
  it('rejects an enabled provider without a client ID', async () => {
    const d1 = await seed()

    const res = await patch(d1, 'social-providers', {
      socialProviders: { google: { ...GOOGLE, clientId: '' } },
    })

    expect(res.status).toBe(422)
    expect(await paramName(res)).toBe('clientId')
  })

  it('rejects a token endpoint on a private address', async () => {
    const d1 = await seed()

    const res = await patch(d1, 'social-providers', {
      socialProviders: { google: { ...GOOGLE, tokenEndpoint: 'https://10.0.0.5/token' } },
    })

    expect(res.status).toBe(422)
    expect(await paramName(res)).toBe('tokenEndpoint')
  })

  it('rejects a provider that has no deployment credential binding', async () => {
    const d1 = await seed()

    const res = await patch(d1, 'social-providers', {
      socialProviders: { myspace: { ...GOOGLE } },
    })

    expect(res.status).toBe(422)
    expect(await paramName(res)).toBe('provider')
  })

  it('saves a complete provider configuration', async () => {
    const d1 = await seed()

    const res = await patch(d1, 'social-providers', { socialProviders: { google: GOOGLE } })

    expect(res.status).toBe(200)
    expect(await storedMetadata(d1)).toMatchObject({
      socialProviders: { google: { clientId: 'google-client', enabled: true } },
    })
  })

  it('keeps another tenant from changing this organization providers', async () => {
    const d1 = await seed()

    const res = await patch(
      d1,
      'social-providers',
      { socialProviders: { google: GOOGLE } },
      { tenantB: true },
    )

    expect([403, 404]).toContain(res.status)
    expect(await storedMetadata(d1)).not.toHaveProperty('socialProviders')
  })
})
