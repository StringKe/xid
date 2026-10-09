import { describe, expect, it, vi } from 'vitest'
import { asUnknown, buildApp, makeSession } from '../../me/__tests__/harness'
import { seedOrganization, seedUser, SqliteD1 } from '../../me/__tests__/sqlite-d1'
import { registerPlatformSettingsRoutes } from '../settings'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

const NOW = 1_700_000_000_000
const URL_SETTINGS = 'https://xid.dev/v1/platform/settings'

const SECRETS = {
  TURNSTILE_SECRET: 'turnstile-secret-value',
  CLOUDFLARE_FOR_SAAS_API_TOKEN: 'saas-api-token-value',
  STRIPE_SECRET_KEY: 'sk_live_stripe-secret-value',
  STRIPE_WEBHOOK_SECRET: 'whsec_stripe-webhook-value',
}

type StatusBody = {
  turnstile: { status: string; siteKey: string | null }
  emailSending: { provider: string; fromAddress: string; fromName: string }
  customDomains: { status: string; cnameTarget: string | null }
  billingAdapter: { kind: string; status: string }
  orgsFollowingDefaults: { following: number; total: number }
}

function seedDatabase(options: { manager?: boolean } = {}): SqliteD1 {
  const db = new SqliteD1()
  db.insert('instances', {
    id: 'inst_1',
    name: 'XID',
    primary_domain: 'xid.dev',
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
  for (const id of ['t_1', 't_2', 't_3', 't_4']) seedOrganization(db, { id, tenantId: id })
  seedOrganization(db, { id: 'org_child', tenantId: 't_1', parentOrgId: 't_1' })
  db.rows("UPDATE organizations SET status = 'deleted', deleted_at = ? WHERE id = 't_4'", NOW)
  db.insert('org_policies', {
    id: 'pol_t2',
    tenant_id: 't_2',
    org_id: 't_2',
    mfa_policy: 'required',
    force_sso: 0,
    allow_password_login: 1,
    created_at: NOW,
    updated_at: NOW,
  })
  db.insert('org_policies', {
    id: 'pol_t3',
    tenant_id: 't_3',
    org_id: 't_3',
    mfa_policy: null,
    force_sso: 0,
    allow_password_login: 1,
    created_at: NOW,
    updated_at: NOW,
  })
  seedUser(db, { id: 'u_admin', tenantId: 't_1' })
  if (options.manager !== false) {
    db.insert('manager_assignments', {
      id: 'mgr_1',
      tenant_id: 't_1',
      user_id: 'u_admin',
      manager_role: 'instance_manager',
      scope_type: 'instance',
      scope_id: null,
      created_at: NOW,
      updated_at: NOW,
    })
  }
  return db
}

async function getSettings(db: SqliteD1, vars: Record<string, string>): Promise<Response> {
  const app = buildApp({
    register: registerPlatformSettingsRoutes,
    session: makeSession({ userId: 'u_admin' }),
  })
  return app.request(URL_SETTINGS, undefined, asUnknown<Env>({ DB: db.asD1(), ...vars }))
}

describe('GET /v1/platform/settings deployment status', () => {
  it('reports every adapter as configured without returning any secret', async () => {
    const db = seedDatabase()

    const res = await getSettings(db, {
      ...SECRETS,
      TURNSTILE_SITE_KEY: '0x4AAAAAAAB9kq2T',
      CLOUDFLARE_FOR_SAAS_ZONE_ID: 'zone_1',
      CLOUDFLARE_FOR_SAAS_CNAME_TARGET: 'auth.xid.dev',
      STRIPE_METER_EVENT_NAME: 'xid_mau',
      EMAIL_FROM_ADDRESS: 'accounts@mail.xid.dev',
      EMAIL_FROM_NAME: 'XID Accounts',
    })

    expect(res.status).toBe(200)
    const raw = await res.text()
    for (const secret of Object.values(SECRETS)) expect(raw).not.toContain(secret)
    expect(JSON.parse(raw)).toMatchObject({
      turnstile: { status: 'configured', siteKey: '0x4AAAAAAAB9kq2T' },
      emailSending: {
        provider: 'cloudflare_email_service',
        fromAddress: 'accounts@mail.xid.dev',
        fromName: 'XID Accounts',
      },
      customDomains: { status: 'configured', cnameTarget: 'auth.xid.dev' },
      billingAdapter: { kind: 'stripe_metered_mau', status: 'configured' },
    } satisfies Partial<StatusBody>)
  })

  it('reports a partial pair as misconfigured instead of failing the page', async () => {
    const db = seedDatabase()

    const res = await getSettings(db, {
      TURNSTILE_SITE_KEY: '0x4AAAAAAAB9kq2T',
      CLOUDFLARE_FOR_SAAS_API_TOKEN: SECRETS.CLOUDFLARE_FOR_SAAS_API_TOKEN,
      STRIPE_SECRET_KEY: SECRETS.STRIPE_SECRET_KEY,
    })

    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain(SECRETS.CLOUDFLARE_FOR_SAAS_API_TOKEN)
    expect(raw).not.toContain(SECRETS.STRIPE_SECRET_KEY)
    expect(JSON.parse(raw)).toMatchObject({
      turnstile: { status: 'misconfigured' },
      customDomains: { status: 'misconfigured' },
      billingAdapter: { kind: 'off', status: 'misconfigured' },
    })
  })

  it('reports unset adapters as not configured and the built-in sender', async () => {
    const db = seedDatabase()

    const res = await getSettings(db, {})

    expect(await res.json()).toMatchObject({
      turnstile: { status: 'not_configured', siteKey: null },
      emailSending: { fromAddress: 'no-reply@xid.dev', fromName: 'XID' },
      customDomains: { status: 'not_configured', cnameTarget: null },
      billingAdapter: { kind: 'off', status: 'not_configured' },
    })
  })

  it('counts live top-level organizations without their own two-step policy', async () => {
    const db = seedDatabase()

    const res = await getSettings(db, {})

    expect(((await res.json()) as StatusBody).orgsFollowingDefaults).toEqual({
      following: 2,
      total: 3,
    })
  })

  it('rejects a session without an instance_manager assignment', async () => {
    const db = seedDatabase({ manager: false })

    const res = await getSettings(db, {})

    expect(res.status).toBe(403)
  })
})
