// Active organization cookie flow:
// 不注入 session,不 mock readSession。通过真实 __Host- cookie 名、refresh token hash、
// SessionDO fake 和 fake D1 验证 active organization 更新后能被下一次 /v1/me 读到。

import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { sha256Hex } from '@xid-kit/crypto'
import type { XidHonoEnv } from '../../lib/types'
import { rtCookieName } from '../../lib/cookies'
import { isAppError } from '../../lib/errors'
import { registerAccountRoutes } from '../../me'
import { asUnknown, makeFakeD1, makeFakeSessionNs, TENANT } from '../../me/__tests__/harness'
import { registerSessionAuthRoutes } from '../index'

const now = Date.now()

function userRow(): Record<string, unknown> {
  return {
    id: 'u_1',
    tenant_id: TENANT.tenantId,
    username: null,
    external_id: null,
    primary_email_id: 'em_1',
    primary_phone_id: null,
    first_name: 'Ada',
    last_name: 'Lovelace',
    display_name: null,
    avatar_url: null,
    locale: 'en',
    timezone: null,
    public_metadata: '{}',
    private_metadata: '{}',
    unsafe_metadata: '{}',
    custom_attributes: '{}',
    status: 'active',
    password_change_required: 0,
    is_new_user: 0,
    profile_completion_status: 'complete',
    lockout_until: null,
    failed_login_count: 0,
    last_login_at: null,
    merged_into_user_id: null,
    provisioned_by: null,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  }
}

function emailRow(): Record<string, unknown> {
  return {
    id: 'em_1',
    tenant_id: TENANT.tenantId,
    user_id: 'u_1',
    email: 'ada@example.com',
    verified: 1,
    verification_status: 'verified',
    is_primary: 1,
    verified_at: now,
    created_at: now,
    updated_at: now,
  }
}

function organizationRow(): Record<string, unknown> {
  return {
    id: 'org_1',
    tenant_id: TENANT.tenantId,
    parent_org_id: null,
    status: 'active',
    slug: 'default',
    name: 'Default Organization',
    seat_used: 1,
    seat_limit: null,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  }
}

function membershipRow(): Record<string, unknown> {
  return {
    id: 'mem_1',
    tenant_id: TENANT.tenantId,
    org_id: 'org_1',
    user_id: 'u_1',
    role: 'admin',
    status: 'active',
    joined_at: now,
    created_at: now,
    updated_at: now,
  }
}

async function sessionFixture(): Promise<{
  cookie: string
  row: Record<string, unknown>
}> {
  const sessionId = 'sess_abcdef0123456789'
  const token = 'rt_test_token_value_123'
  return {
    cookie: `${rtCookieName(sessionId)}=${token}`,
    row: {
      id: sessionId,
      tenant_id: TENANT.tenantId,
      user_id: 'u_1',
      refresh_token_hash: await sha256Hex(token),
      active_org_id: null,
      device_fingerprint_hash: null,
      device_name: null,
      user_agent: null,
      ip: null,
      location: null,
      status: 'active',
      remember_me: 0,
      is_impersonation: 0,
      impersonator_user_id: null,
      authenticated_at: now,
      last_active_at: now,
      expires_at: now + 3_600_000,
      revoked_at: null,
      created_at: now,
      updated_at: now,
    },
  }
}

function buildApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError((err, c) => {
    if (isAppError(err)) {
      return c.json({ code: err.code, meta: err.meta }, err.httpStatus as 400)
    }
    return c.json({ code: 'server_error' }, 500)
  })
  app.use('*', async (c: Context<XidHonoEnv>, next) => {
    c.set('tenant', TENANT)
    c.set('session', null)
    c.set('locale', asUnknown<XidHonoEnv['Variables']['locale']>('en'))
    await next()
  })
  registerSessionAuthRoutes(app)
  registerAccountRoutes(app)
  return app
}

describe('POST /v1/sessions/active-organization cookie flow', () => {
  it('updates the cookie session active organization and /v1/me observes the change', async () => {
    const { cookie, row } = await sessionFixture()
    const sessionDoNames: string[] = []
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        sessions: [row],
        users: [userRow()],
        user_emails: [emailRow()],
        memberships: [membershipRow()],
        organizations: [organizationRow()],
        manager_assignments: [],
        mfa_factors: [],
        passkey_credentials: [],
        projects: [],
      }),
      SESSION_REVOCATION: makeFakeSessionNs(sessionDoNames),
    })
    const app = buildApp()

    const before = await app.request(
      'https://acme.xid.dev/v1/me',
      { method: 'GET', headers: { Cookie: cookie } },
      env,
    )
    expect(before.status).toBe(200)
    expect(((await before.json()) as Record<string, unknown>)['activeOrg']).toBeNull()

    const update = await app.request(
      'https://acme.xid.dev/v1/sessions/active-organization',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ organizationId: 'org_1' }),
      },
      env,
    )
    expect(update.status).toBe(200)
    expect(((await update.json()) as Record<string, unknown>)['activeOrganizationId']).toBe('org_1')

    const after = await app.request(
      'https://acme.xid.dev/v1/me',
      { method: 'GET', headers: { Cookie: cookie } },
      env,
    )
    expect(after.status).toBe(200)
    const body = (await after.json()) as Record<string, unknown>
    expect((body['activeOrg'] as Record<string, unknown>)['id']).toBe('org_1')
    expect(sessionDoNames).toContain('session:u_1')
  })
})
