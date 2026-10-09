// Organization Overview:待处理事项判定、登录活动比较期、新组织引导进度。真实 sqlite + 迁移链。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IDP_CERT_B64,
  certificateWithValidity,
} from '../../../../../packages/saml/src/__tests__/fixtures'
import { registerOrgMembersRoutes } from '../org-members'
import { activityPeriods, shiftMonth, sortAttention } from '../org-overview'
import type { AttentionItem } from '../org-overview'
import {
  buildApp,
  envOf,
  json,
  makeDb,
  seedApiKey,
  seedOrg,
  seedUser,
  tenantDb,
} from './console-fixtures'
import {
  seedAudit,
  seedDomain,
  seedInvitation,
  seedSsoConnection,
  seedWebhook,
  seedWebhookDelivery,
} from './governance-fixtures'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

const BASE = 'https://acme.xid.dev/v1/organizations'
const NOW = new Date('2026-10-07T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

type Attention = {
  items: AttentionItem[]
  checkedAt: string
  nextCertificateExpiry: { connectionName: string | null; notAfter: string } | null
}

type Activity = {
  period: { from: string; to: string }
  previous: { from: string; to: string }
  metrics: { key: string; value: number; previousValue: number; series: number[] }[]
}

function certExpiringIn(days: number): string {
  return certificateWithValidity(
    IDP_CERT_B64,
    NOW.getTime() - 365 * DAY,
    NOW.getTime() + days * DAY,
  )
}

async function setup() {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a', name: 'Northwind Logistics' })
  await seedOrg(d1, { id: 'org_fin', name: 'Finance' })
  const token = await seedApiKey(d1, { id: 'ak_read', scopes: ['organizations:read'] })
  const app = buildApp(registerOrgMembersRoutes)
  const get = (path: string) =>
    app.request(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } }, envOf(d1))
  return { d1, get }
}

describe('attention ordering', () => {
  it('lists critical items before warnings and notices', () => {
    const items: AttentionItem[] = [
      { kind: 'invitation_expired', severity: 'notice', targetId: 'i', facts: {} },
      { kind: 'domain_unverified', severity: 'warning', targetId: 'd', facts: {} },
      { kind: 'webhook_failing', severity: 'critical', targetId: 'w', facts: {} },
      { kind: 'sso_certificate_expiring', severity: 'critical', targetId: 's', facts: {} },
    ]

    const sorted = sortAttention(items)

    expect(sorted.map((item) => item.targetId)).toEqual(['s', 'w', 'd', 'i'])
  })
})

describe('GET /v1/organizations/:id/attention', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns an empty list for an organization with nothing to do', async () => {
    const { get } = await setup()

    const response = await get('/t_a/attention')

    expect(response.status).toBe(200)
    const body = await json<Attention>(response)
    expect(body.items).toEqual([])
    expect(body.nextCertificateExpiry).toBeNull()
    expect(body.checkedAt).toBe(NOW.toISOString())
  })

  it('flags an SSO certificate expiring within 30 days with the affected user count', async () => {
    const { d1, get } = await setup()
    await seedSsoConnection(d1, { id: 'sso_okta', orgId: 't_a', certificates: [certExpiringIn(9)] })
    await seedUser(d1, { id: 'user_ravi' })
    await tenantDb(d1).userIdentities.insert({
      id: 'idn_ravi',
      tenantId: 't_a',
      userId: 'user_ravi',
      identityType: 'sso',
      provider: 'sso_okta',
      providerUserId: 'ravi',
    })

    const body = await json<Attention>(await get('/t_a/attention'))

    expect(body.items).toEqual([
      {
        kind: 'sso_certificate_expiring',
        severity: 'critical',
        targetId: 'sso_okta',
        facts: {
          connectionName: 'Okta',
          notAfter: new Date(NOW.getTime() + 9 * DAY).toISOString(),
          affectedUserCount: 1,
        },
      },
    ])
  })

  it('reports a distant certificate only as the next expiry', async () => {
    const { d1, get } = await setup()
    await seedSsoConnection(d1, {
      id: 'sso_okta',
      orgId: 't_a',
      certificates: [certExpiringIn(97)],
    })

    const body = await json<Attention>(await get('/t_a/attention'))

    expect(body.items).toEqual([])
    expect(body.nextCertificateExpiry).toEqual({
      connectionName: 'Okta',
      notAfter: new Date(NOW.getTime() + 97 * DAY).toISOString(),
    })
  })

  it('ignores an expiring certificate when a newer one is already registered', async () => {
    const { d1, get } = await setup()
    await seedSsoConnection(d1, {
      id: 'sso_okta',
      orgId: 't_a',
      certificates: [certExpiringIn(5), certExpiringIn(400)],
    })

    const body = await json<Attention>(await get('/t_a/attention'))

    expect(body.items).toEqual([])
  })

  it('flags failing webhook deliveries from the last 24 hours on the top-level organization', async () => {
    const { d1, get } = await setup()
    await seedWebhook(d1, { id: 'wh_billing', url: 'https://billing.northwind.com/hooks' })
    await seedWebhookDelivery(d1, {
      id: 'del_dead',
      webhookId: 'wh_billing',
      status: 'dead',
      attemptCount: 5,
      createdAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
    })
    await seedWebhookDelivery(d1, {
      id: 'del_retrying',
      webhookId: 'wh_billing',
      status: 'pending',
      attemptCount: 2,
      createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    })
    await seedWebhookDelivery(d1, {
      id: 'del_ok',
      webhookId: 'wh_billing',
      status: 'delivered',
      attemptCount: 1,
      createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    })
    await seedWebhookDelivery(d1, {
      id: 'del_old',
      webhookId: 'wh_billing',
      status: 'dead',
      attemptCount: 5,
      createdAt: new Date(NOW.getTime() - 2 * DAY),
    })

    const [top, sub] = await Promise.all([get('/t_a/attention'), get('/org_fin/attention')])

    const topBody = await json<Attention>(top)
    expect(topBody.items).toEqual([
      {
        kind: 'webhook_failing',
        severity: 'critical',
        targetId: 'wh_billing',
        facts: {
          url: 'https://billing.northwind.com/hooks',
          failedCount: 2,
          deadCount: 1,
          since: new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString(),
          lastResponseStatus: null,
        },
      },
    ])
    expect((await json<Attention>(sub)).items).toEqual([])
  })

  it('flags unverified domains of the organization only', async () => {
    const { d1, get } = await setup()
    await seedSsoConnection(d1, { id: 'sso_okta', orgId: 't_a', certificates: [] })
    await seedDomain(d1, { id: 'dom_de', orgId: 't_a', domain: 'northwind.de' })
    await seedDomain(d1, { id: 'dom_com', orgId: 't_a', domain: 'northwind.com', verified: true })
    await seedDomain(d1, { id: 'dom_fin', orgId: 'org_fin', domain: 'finance.northwind.de' })

    const body = await json<Attention>(await get('/t_a/attention'))

    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({
      kind: 'domain_unverified',
      severity: 'warning',
      targetId: 'dom_de',
      facts: { domain: 'northwind.de', ssoConnectionName: 'Okta' },
    })
  })

  it('merges recently expired invitations into one item and skips old ones', async () => {
    const { d1, get } = await setup()
    await seedInvitation(d1, {
      id: 'inv_sam',
      orgId: 't_a',
      email: 'sam.okafor@northwind.com',
      status: 'expired',
      expiresAt: new Date(NOW.getTime() - 3 * DAY),
    })
    await seedInvitation(d1, {
      id: 'inv_lazy',
      orgId: 't_a',
      email: 'lee@northwind.com',
      status: 'pending',
      expiresAt: new Date(NOW.getTime() - DAY),
    })
    await seedInvitation(d1, {
      id: 'inv_old',
      orgId: 't_a',
      email: 'old@northwind.com',
      status: 'expired',
      expiresAt: new Date(NOW.getTime() - 40 * DAY),
    })
    await seedInvitation(d1, {
      id: 'inv_live',
      orgId: 't_a',
      email: 'live@northwind.com',
      status: 'pending',
      expiresAt: new Date(NOW.getTime() + DAY),
    })

    const body = await json<Attention>(await get('/t_a/attention'))

    expect(body.items).toEqual([
      {
        kind: 'invitation_expired',
        severity: 'notice',
        targetId: 'inv_lazy',
        facts: {
          count: 2,
          email: 'lee@northwind.com',
          expiredAt: new Date(NOW.getTime() - DAY).toISOString(),
        },
      },
    ])
  })
})

describe('sign-in activity periods', () => {
  it('compares the last 7 days with the same days of the previous month', () => {
    const periods = activityPeriods(NOW, 7)

    expect(periods.period).toEqual({ from: '2026-10-01', to: '2026-10-07' })
    expect(periods.previous).toEqual({ from: '2026-09-01', to: '2026-09-07' })
    expect(periods.days).toHaveLength(7)
  })

  it('clamps the previous day to the end of a shorter month', () => {
    expect(shiftMonth('2026-03-31', -1)).toBe('2026-02-28')
    expect(shiftMonth('2026-01-15', -1)).toBe('2025-12-15')
  })
})

describe('GET /v1/organizations/:id/sign-in-activity', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns monthly active users, sign-in counts and their previous values', async () => {
    const { d1, get } = await setup()
    const success = 'auth.login_succeeded'
    await seedAudit(d1, {
      seq: 1,
      eventType: success,
      orgId: null,
      actorId: 'u1',
      occurredAt: '2026-09-03T10:00:00.000Z',
    })
    await seedAudit(d1, {
      seq: 2,
      eventType: success,
      orgId: null,
      actorId: 'u1',
      occurredAt: '2026-10-02T10:00:00.000Z',
    })
    await seedAudit(d1, {
      seq: 3,
      eventType: success,
      orgId: null,
      actorId: 'u2',
      occurredAt: '2026-10-05T10:00:00.000Z',
    })
    await seedAudit(d1, {
      seq: 4,
      eventType: success,
      orgId: null,
      actorId: 'u1',
      occurredAt: '2026-10-05T11:00:00.000Z',
    })
    await seedAudit(d1, {
      seq: 5,
      eventType: 'auth.login_failed',
      orgId: null,
      occurredAt: '2026-10-06T08:00:00.000Z',
    })
    await seedAudit(d1, {
      seq: 6,
      eventType: success,
      orgId: null,
      actorId: 'u3',
      occurredAt: '2026-09-30T23:59:59.000Z',
    })

    const response = await get('/t_a/sign-in-activity?days=7')

    expect(response.status).toBe(200)
    const body = await json<Activity>(response)
    expect(body.period).toEqual({ from: '2026-10-01', to: '2026-10-07' })
    expect(body.previous).toEqual({ from: '2026-09-01', to: '2026-09-07' })
    expect(body.metrics).toEqual([
      { key: 'mau', value: 2, previousValue: 1, series: [0, 1, 1, 1, 2, 2, 2] },
      { key: 'sign_in_succeeded', value: 3, previousValue: 1, series: [0, 1, 0, 0, 2, 0, 0] },
      { key: 'sign_in_failed', value: 1, previousValue: 0, series: [0, 0, 0, 0, 0, 1, 0] },
    ])
  })

  it.each(['0', '29', 'seven', '-1'])('rejects days=%s with validation_failed', async (days) => {
    const { get } = await setup()

    const response = await get(`/t_a/sign-in-activity?days=${days}`)

    expect(response.status).toBe(422)
    expect((await json<{ code: string }>(response)).code).toBe('validation_failed')
  })
})

describe('GET /v1/organizations/:id/setup-progress', () => {
  it('reports every step as open for a new organization', async () => {
    const { d1, get } = await setup()
    await seedDomain(d1, { id: 'dom_com', orgId: 't_a', domain: 'northwind.com' })

    const body = await json(await get('/t_a/setup-progress'))

    expect(body).toEqual({
      domainVerified: false,
      signInDecided: false,
      membersInvited: false,
      pendingDomain: 'northwind.com',
    })
  })

  it('reports every step as done once domain, sign-in and invitations are in place', async () => {
    const { d1, get } = await setup()
    await seedDomain(d1, { id: 'dom_com', orgId: 't_a', domain: 'northwind.com', verified: true })
    await seedSsoConnection(d1, { id: 'sso_okta', orgId: 't_a', certificates: [] })
    await seedInvitation(d1, {
      id: 'inv_1',
      orgId: 't_a',
      email: 'amara@northwind.com',
      status: 'pending',
      expiresAt: new Date(Date.now() + DAY),
    })

    const body = await json(await get('/t_a/setup-progress'))

    expect(body).toEqual({
      domainVerified: true,
      signInDecided: true,
      membersInvited: true,
      pendingDomain: null,
    })
  })

  it('counts a required two-step policy as a sign-in decision', async () => {
    const { d1, get } = await setup()
    await tenantDb(d1).orgPolicies.insert({
      id: 'pol_a',
      tenantId: 't_a',
      orgId: 't_a',
      mfaPolicy: 'required',
    })

    const body = await json<{ signInDecided: boolean }>(await get('/t_a/setup-progress'))

    expect(body.signInDecided).toBe(true)
  })
})
