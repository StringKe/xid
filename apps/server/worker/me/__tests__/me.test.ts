// GET /v1/me 测试:happy path(MeResponse 形状)+ org_manager -> admin role 映射 + cookie 缺失 200 匿名壳 + 跨租户隔离(别租户 user 行不可见 -> 401)。
// permissions 经 RBAC 解析(无 project/grant 时为空数组);activeOrg 由 session.activeOrgId 解析 membership。

import { describe, it, expect } from 'vitest'
import { registerMeRoute } from '../me'
import { buildApp, makeFakeD1, makeSession, TENANT } from './harness'

const now = Date.now()

function userRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'u_1',
    tenant_id: 't_1',
    username: null,
    external_id: null,
    primary_email_id: 'em_1',
    pending_email: null,
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
    ...overrides,
  }
}

function emailRow(): Record<string, unknown> {
  return {
    id: 'em_1',
    tenant_id: 't_1',
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

function verifiedPhoneRow(): Record<string, unknown> {
  return {
    id: 'phone_1',
    tenant_id: 't_1',
    user_id: 'u_1',
    phone: '+15551234567',
    verified: 1,
    verification_status: 'verified',
    is_primary: 1,
    verified_at: now,
    created_at: now,
    updated_at: now,
  }
}

function instanceManagerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mgr_1',
    tenant_id: 'admin_org',
    user_id: 'u_1',
    manager_role: 'instance_manager',
    scope_type: 'instance',
    scope_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function orgManagerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mgr_org_1',
    tenant_id: 't_1',
    user_id: 'u_1',
    manager_role: 'org_manager',
    scope_type: 'org',
    scope_id: 'org_1',
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function membershipRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mem_1',
    tenant_id: 't_1',
    org_id: 'org_1',
    user_id: 'u_1',
    role: 'member',
    membership_type: 'member',
    status: 'active',
    is_managed: 0,
    invited_by_user_id: null,
    joined_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function organizationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'org_1',
    tenant_id: 't_1',
    instance_id: 'ins_1',
    parent_org_id: null,
    slug: 'acme',
    name: 'Acme',
    logo_url: null,
    public_metadata: '{}',
    private_metadata: '{}',
    seat_limit: null,
    seat_used: 1,
    enrollment_mode: 'invite_required',
    allow_org_self_service: 1,
    status: 'active',
    deleted_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

describe('GET /v1/me', () => {
  it('returns user + session view with empty orgs when no memberships', async () => {
    const db = makeFakeD1({
      users: [userRow()],
      user_emails: [emailRow()],
      mfa_factors: [],
      passkey_credentials: [],
      memberships: [],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMeRoute,
      session: makeSession({ sessionId: 's_current', userId: 'u_1' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['user'] as Record<string, unknown>).toMatchObject({
      id: 'u_1',
      email: 'ada@example.com',
      emailVerified: true,
      name: 'Ada Lovelace',
      hasMfa: false,
      instanceManager: false,
    })
    expect(body['activeOrg']).toBeNull()
    expect(body['organizations']).toEqual([])
    expect((body['session'] as Record<string, unknown>)['id']).toBe('s_current')
    expect((body['session'] as Record<string, unknown>)['status']).toBe('active')
    expect((body['session'] as Record<string, unknown>)['isImpersonation']).toBe(false)
  })

  it('exposes provisioned_by (snake_case) so SPA/SDK can detect guest users', async () => {
    const db = makeFakeD1({
      users: [userRow({ provisioned_by: 'anonymous' })],
      user_emails: [emailRow()],
      mfa_factors: [],
      passkey_credentials: [],
      memberships: [],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerMeRoute, session: makeSession({ userId: 'u_1' }) })

    const res = await app.request('https://acme.xid.dev/v1/me', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect((body['user'] as Record<string, unknown>)['provisioned_by']).toBe('anonymous')
  })

  it('returns pending Email as unverified during guest onboarding', async () => {
    const db = makeFakeD1({
      users: [
        userRow({
          primary_email_id: null,
          pending_email: 'guest@example.com',
          provisioned_by: 'anonymous',
        }),
      ],
      user_emails: [],
      mfa_factors: [],
      passkey_credentials: [],
      memberships: [],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMeRoute,
      session: makeSession({ sessionId: 's_guest', userId: 'u_1' }),
    })

    const res = await app.request('https://xid.dev/v1/me', { method: 'GET' }, env)
    const body = (await res.json()) as { user: { email: string; emailVerified: boolean } }

    expect(body.user.email).toBe('guest@example.com')
    expect(body.user.emailVerified).toBe(false)
  })

  it('marks user as instance manager when a platform manager assignment exists', async () => {
    const db = makeFakeD1({
      users: [userRow()],
      user_emails: [emailRow()],
      mfa_factors: [],
      passkey_credentials: [],
      manager_assignments: [instanceManagerRow()],
      memberships: [],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerMeRoute, session: makeSession({ userId: 'u_1' }) })

    const res = await app.request('https://acme.xid.dev/v1/me', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect((body['user'] as Record<string, unknown>)['instanceManager']).toBe(true)
  })

  it('batches project grants into organization permissions and reuses the matching active organization', async () => {
    const db = makeFakeD1({
      users: [userRow()],
      user_emails: [emailRow()],
      mfa_factors: [],
      passkey_credentials: [],
      memberships: [
        {
          id: 'mem_1',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'u_1',
          role: 'member',
          membership_type: 'member',
          status: 'active',
          is_managed: 0,
          invited_by_user_id: null,
          joined_at: now,
          created_at: now,
          updated_at: now,
        },
      ],
      organizations: [organizationRow()],
      projects: [
        {
          id: 'proj_1',
          tenant_id: 't_1',
          org_id: 'org_1',
          name: 'Console',
          description: null,
          created_at: now,
          updated_at: now,
        },
      ],
      user_grants: [
        {
          id: 'grant_1',
          tenant_id: 't_1',
          user_id: 'u_1',
          project_id: 'proj_1',
          role_id: 'role_1',
          granted_via_grant_id: null,
          revoked_at: null,
          created_at: now,
          updated_at: now,
        },
      ],
      role_permissions: [
        {
          id: 'rp_1',
          tenant_id: 't_1',
          role_id: 'role_1',
          permission_id: 'perm_1',
          condition_expression: null,
          created_at: now,
        },
      ],
      permissions: [
        {
          id: 'perm_1',
          tenant_id: 't_1',
          project_id: 'proj_1',
          key: 'users.read',
          description: null,
          status: 'active',
          deleted_at: null,
          created_at: now,
          updated_at: now,
        },
      ],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMeRoute,
      session: makeSession({ userId: 'u_1', activeOrgId: 'org_1' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['organizations']).toEqual([
      {
        id: 'org_1',
        slug: 'acme',
        name: 'Acme',
        role: 'member',
        permissions: ['users.read'],
      },
    ])
    expect(body['activeOrg']).toEqual((body['organizations'] as unknown[])[0])
  })

  it('reports hasMfa true when an active TOTP factor exists', async () => {
    const db = makeFakeD1({
      users: [userRow()],
      user_emails: [emailRow()],
      mfa_factors: [
        {
          id: 'mf_1',
          tenant_id: 't_1',
          user_id: 'u_1',
          factor_type: 'totp',
          status: 'active',
          secret_ciphertext: null,
          target: null,
          passkey_credential_id: null,
          is_default: 1,
          last_used_at: null,
          activated_at: now,
          created_at: now,
          updated_at: now,
        },
      ],
      passkey_credentials: [],
      memberships: [],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerMeRoute, session: makeSession({ userId: 'u_1' }) })

    const res = await app.request('https://acme.xid.dev/v1/me', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect((body['user'] as Record<string, unknown>)['hasMfa']).toBe(true)
  })

  it('reports hasMfa true when only a passkey exists', async () => {
    const db = makeFakeD1({
      users: [userRow()],
      user_emails: [emailRow()],
      mfa_factors: [],
      passkey_credentials: [
        {
          id: 'pk_1',
          tenant_id: 't_1',
          user_id: 'u_1',
          credential_id: 'cred_1',
          public_key: 'pk',
          sign_count: 0,
          device_name: 'This device',
          transports: null,
          backup_eligible: 0,
          backup_state: 0,
          last_used_at: null,
          revoked_at: null,
          created_at: now,
          updated_at: now,
        },
      ],
      memberships: [],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerMeRoute, session: makeSession({ userId: 'u_1' }) })

    const res = await app.request('https://acme.xid.dev/v1/me', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect((body['user'] as Record<string, unknown>)['hasMfa']).toBe(true)
  })

  it('reports hasMfa true for verified phone only when SMS provider is ready', async () => {
    const db = makeFakeD1({
      users: [userRow()],
      user_emails: [emailRow()],
      user_phones: [verifiedPhoneRow()],
      mfa_factors: [],
      passkey_credentials: [],
      memberships: [],
    })
    const env = {
      DB: db,
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'token',
      SMS_FROM: '+15550000000',
    } as unknown as Env
    const app = buildApp({
      register: registerMeRoute,
      session: makeSession({ userId: 'u_1' }),
      tenant: {
        ...TENANT,
        policy: {
          deliveryChannels: {
            sms: {
              provider: 'twilio',
              enabled: true,
              secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
              from: '+15550000000',
            },
          },
        },
      },
    })

    const res = await app.request('https://acme.xid.dev/v1/me', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect((body['user'] as Record<string, unknown>)['hasMfa']).toBe(true)
  })

  it('does not report SMS MFA when provider is not ready', async () => {
    const db = makeFakeD1({
      users: [userRow()],
      user_emails: [emailRow()],
      user_phones: [verifiedPhoneRow()],
      mfa_factors: [],
      passkey_credentials: [],
      memberships: [],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerMeRoute, session: makeSession({ userId: 'u_1' }) })

    const res = await app.request('https://acme.xid.dev/v1/me', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect((body['user'] as Record<string, unknown>)['hasMfa']).toBe(false)
  })

  it('returns anonymous shell when no session cookie present', async () => {
    const db = makeFakeD1({ users: [userRow()], user_emails: [emailRow()] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerMeRoute, session: null })

    const res = await app.request('https://acme.xid.dev/v1/me', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['user']).toBeNull()
    expect(body['activeOrg']).toBeNull()
    expect(body['organizations']).toEqual([])
    expect(body['session']).toBeNull()
  })

  it('returns anonymous shell for middleware-injected pending MFA session', async () => {
    const db = makeFakeD1({ users: [userRow()], user_emails: [emailRow()] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMeRoute,
      session: makeSession({ userId: 'u_1', status: 'pending_mfa' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['user']).toBeNull()
    expect(body['activeOrg']).toBeNull()
    expect(body['organizations']).toEqual([])
    expect(body['session']).toBeNull()
  })

  it('returns 401 when session user has been soft deleted', async () => {
    const db = makeFakeD1({
      users: [userRow({ deleted_at: now, status: 'deleted' })],
      user_emails: [emailRow()],
      mfa_factors: [],
      passkey_credentials: [],
      memberships: [],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerMeRoute, session: makeSession({ userId: 'u_1' }) })

    const res = await app.request('https://acme.xid.dev/v1/me', { method: 'GET' }, env)

    expect(res.status).toBe(401)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('unauthorized')
  })

  it('does not leak another tenant user (cross-tenant user row -> 401)', async () => {
    // session 指向 u_victim,但 u_victim 行归属 t_other -> 查询层注入 tenant_id=t_1 查不到 -> 401。
    const db = makeFakeD1({
      users: [userRow({ id: 'u_victim', tenant_id: 't_other' })],
      user_emails: [],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMeRoute,
      session: makeSession({ userId: 'u_victim' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me', { method: 'GET' }, env)

    expect(res.status).toBe(401)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('unauthorized')
  })

  it('elevates membership role to admin when an org_manager assignment exists for the org', async () => {
    const db = makeFakeD1({
      users: [userRow()],
      user_emails: [emailRow()],
      mfa_factors: [],
      passkey_credentials: [],
      memberships: [membershipRow()],
      manager_assignments: [orgManagerRow()],
      organizations: [organizationRow()],
      projects: [],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerMeRoute, session: makeSession({ userId: 'u_1' }) })

    const res = await app.request('https://acme.xid.dev/v1/me', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['organizations']).toEqual([
      { id: 'org_1', slug: 'acme', name: 'Acme', role: 'admin', permissions: [] },
    ])
  })

  it('includes org without membership when an org_manager assignment exists', async () => {
    const db = makeFakeD1({
      users: [userRow()],
      user_emails: [emailRow()],
      mfa_factors: [],
      passkey_credentials: [],
      memberships: [],
      manager_assignments: [orgManagerRow()],
      organizations: [organizationRow()],
      projects: [],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerMeRoute, session: makeSession({ userId: 'u_1' }) })

    const res = await app.request('https://acme.xid.dev/v1/me', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['organizations']).toEqual([
      { id: 'org_1', slug: 'acme', name: 'Acme', role: 'admin', permissions: [] },
    ])
  })

  it('does not leak orgs managed by other users and keeps plain member role', async () => {
    const db = makeFakeD1({
      users: [userRow()],
      user_emails: [emailRow()],
      mfa_factors: [],
      passkey_credentials: [],
      memberships: [membershipRow()],
      manager_assignments: [
        orgManagerRow({ id: 'mgr_org_2', user_id: 'u_other', scope_id: 'org_2' }),
      ],
      organizations: [
        organizationRow(),
        organizationRow({ id: 'org_2', slug: 'globex', name: 'Globex' }),
      ],
      projects: [],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerMeRoute, session: makeSession({ userId: 'u_1' }) })

    const res = await app.request('https://acme.xid.dev/v1/me', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['organizations']).toEqual([
      { id: 'org_1', slug: 'acme', name: 'Acme', role: 'member', permissions: [] },
    ])
  })
})
