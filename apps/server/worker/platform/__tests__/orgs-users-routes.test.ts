// 平台组织、用户与实例管理员路由:node:sqlite + 全量迁移链,SQL 真实执行。
// 覆盖 instance_manager 门控、创建组织(冲突、审计、owner 邀请)、详情与只读子资源、删除确认、
// MAU 排序分页、用户空 q 浏览与过滤、实例管理员 granted_by。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'
import type { TenantVar, XidHonoEnv } from '../../lib/types'
import { SqliteD1, seedMembership, seedOrganization, seedUser } from '../../me/__tests__/sqlite-d1'
import { execCtx, makeApp, makeEnv, makeSession, makeTenant } from '../../me-auth/__tests__/helpers'
import { registerPlatformManagerAssignmentRoutes } from '../manager-assignments'
import { registerPlatformOrganizationsRoutes } from '../organizations'
import { registerPlatformUsersRoutes } from '../users'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

const NOW = 1_700_000_000_000
const YEAR_MONTH = new Date().toISOString().slice(0, 7)

let db: SqliteD1

function insertOrganization(input: {
  id: string
  slug: string
  name?: string
  status?: string
  parentOrgId?: string
}): void {
  db.insert('organizations', {
    id: input.id,
    tenant_id: input.parentOrgId ?? input.id,
    instance_id: 'inst_1',
    parent_org_id: input.parentOrgId ?? null,
    slug: input.slug,
    name: input.name ?? input.slug,
    public_metadata: '{}',
    private_metadata: '{}',
    seat_used: 0,
    enrollment_mode: 'invite_required',
    allow_org_self_service: 1,
    status: input.status ?? 'active',
    created_at: NOW,
    updated_at: NOW,
  })
}

function insertSession(input: {
  id: string
  tenantId: string
  userId: string
  lastActiveAt: number
}): void {
  db.insert('sessions', {
    id: input.id,
    tenant_id: input.tenantId,
    user_id: input.userId,
    refresh_token_hash: `hash_${input.id}`,
    status: 'active',
    remember_me: 0,
    is_impersonation: 0,
    authenticated_at: input.lastActiveAt,
    last_active_at: input.lastActiveAt,
    expires_at: input.lastActiveAt + 86_400_000,
    created_at: input.lastActiveAt,
  })
}

function grantInstanceManager(
  id: string,
  tenantId: string,
  userId: string,
  grantedBy: string | null = null,
): void {
  db.insert('manager_assignments', {
    id,
    tenant_id: tenantId,
    user_id: userId,
    manager_role: 'instance_manager',
    scope_type: 'instance',
    scope_id: null,
    granted_by: grantedBy,
    created_at: NOW,
    updated_at: NOW,
  })
}

function seedInstance(): void {
  db.insert('instances', {
    id: 'inst_1',
    name: 'XID',
    primary_domain: 'xid.test',
    mode: 'multi_tenant',
    password_policy: '{}',
    session_policy: '{}',
    created_at: NOW,
    updated_at: NOW,
  })
}

function platformApp(userId = 'user_mgr'): Hono<XidHonoEnv> {
  const tenant = { ...makeTenant('org_admin'), instanceId: 'inst_1', issuer: 'https://xid.test' }
  return makeApp(
    (app) => {
      registerPlatformOrganizationsRoutes(app)
      registerPlatformUsersRoutes(app)
      registerPlatformManagerAssignmentRoutes(app)
    },
    { tenant: tenant as unknown as TenantVar, session: makeSession(userId) },
  )
}

function env(): Env {
  return { ...makeEnv(), DB: db.asD1() } as Env
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; userId?: string } = {},
): Promise<Response> {
  return platformApp(init.userId).request(
    path,
    {
      method: init.method ?? 'GET',
      ...(init.body === undefined
        ? {}
        : { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }),
    },
    env(),
    execCtx,
  )
}

beforeEach(() => {
  db = new SqliteD1()
  seedInstance()
  insertOrganization({ id: 'org_admin', slug: 'default', name: 'Default Organization' })
  seedUser(db, {
    id: 'user_mgr',
    tenantId: 'org_admin',
    primaryEmail: 'dana@xid.test',
    displayName: 'Dana Ortiz',
  })
  seedUser(db, { id: 'user_plain', tenantId: 'org_admin', primaryEmail: 'plain@xid.test' })
  grantInstanceManager('ma_mgr', 'org_admin', 'user_mgr')
})

afterEach(() => {
  db.database.close()
})

describe('platform organizations and users access control', () => {
  it.each([
    ['GET', '/v1/platform/organizations'],
    ['POST', '/v1/platform/organizations'],
    ['GET', '/v1/platform/organizations/org_admin'],
    ['GET', '/v1/platform/organizations/org_admin/members'],
    ['GET', '/v1/platform/organizations/org_admin/domains'],
    ['GET', '/v1/platform/users'],
    ['GET', '/v1/platform/manager-assignments'],
  ])('rejects %s %s for a session without instance_manager', async (method, path) => {
    const res = await call(path, {
      method,
      userId: 'user_plain',
      ...(method === 'POST'
        ? { body: { name: 'Kestrel', slug: 'kestrel', ownerEmail: 'a@b.test' } }
        : {}),
    })

    expect(res.status).toBe(403)
  })
})

describe('POST /v1/platform/organizations', () => {
  it('creates a top-level organization, invites the owner and records the platform audit', async () => {
    const res = await call('/v1/platform/organizations', {
      method: 'POST',
      body: { name: 'Kestrel Health', slug: 'kestrel', ownerEmail: 'Priya@Kestrel.test' },
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; primaryHost: string; status: string }
    expect(body).toMatchObject({ status: 'active', primaryHost: 'kestrel.xid.test' })
    const [org] = db.rows(
      'SELECT tenant_id, parent_org_id FROM organizations WHERE id = ?',
      body.id,
    )
    expect(org).toEqual({ tenant_id: body.id, parent_org_id: null })
    const invitations = db.rows(
      'SELECT email, role, status, tenant_id FROM invitations WHERE org_id = ?',
      body.id,
    )
    expect(invitations).toEqual([
      { email: 'priya@kestrel.test', role: 'owner', status: 'pending', tenant_id: body.id },
    ])
    const audits = db.rows(
      `SELECT actor_id, payload FROM platform_audit_outbox WHERE action = 'platform.organization.created'`,
    )
    expect(audits).toHaveLength(1)
    expect(audits[0]?.['actor_id']).toBe('user_mgr')
    expect(String(audits[0]?.['payload'])).not.toContain('priya@kestrel.test')
  })

  it('returns conflict for a slug already used in the instance and writes nothing', async () => {
    insertOrganization({ id: 'org_kestrel', slug: 'kestrel' })

    const res = await call('/v1/platform/organizations', {
      method: 'POST',
      body: { name: 'Kestrel again', slug: 'kestrel', ownerEmail: 'owner@kestrel.test' },
    })

    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('conflict')
    expect(db.rows('SELECT id FROM platform_audit_outbox')).toHaveLength(0)
    expect(db.rows('SELECT id FROM invitations')).toHaveLength(0)
  })

  it('rejects an invalid owner email with paramName', async () => {
    const res = await call('/v1/platform/organizations', {
      method: 'POST',
      body: { name: 'Kestrel', slug: 'kestrel', ownerEmail: 'not-an-email' },
    })

    expect(res.status).toBe(422)
    expect(((await res.json()) as { meta: { paramName: string } }).meta.paramName).toBe(
      'ownerEmail',
    )
  })
})

describe('GET /v1/platform/organizations', () => {
  beforeEach(() => {
    insertOrganization({ id: 'org_kestrel', slug: 'kestrel', name: 'Kestrel Health' })
    insertOrganization({
      id: 'org_bluefin',
      slug: 'bluefin',
      name: 'Bluefin Maritime',
      status: 'suspended',
    })
    insertOrganization({ id: 'org_lumen', slug: 'lumen', name: 'Lumen Schools' })
    db.insert('usage_monthly', {
      tenant_id: 'org_kestrel',
      year_month: YEAR_MONTH,
      mau: 900,
      archived_at: '',
    })
    db.insert('usage_monthly', {
      tenant_id: 'org_lumen',
      year_month: YEAR_MONTH,
      mau: 300,
      archived_at: '',
    })
    db.database.exec(
      `INSERT INTO organization_quotas (tenant_id, quota_key, "limit", enforcement, created_at, updated_at)
       VALUES ('org_kestrel', 'mau', 1000, 'observe', ${NOW}, ${NOW})`,
    )
    seedUser(db, { id: 'user_k1', tenantId: 'org_kestrel' })
    db.insert('users', {
      id: 'user_k_deleted',
      tenant_id: 'org_kestrel',
      public_metadata: '{}',
      private_metadata: '{}',
      unsafe_metadata: '{}',
      custom_attributes: '{}',
      status: 'active',
      password_change_required: 0,
      is_new_user: 0,
      profile_completion_status: 'complete',
      failed_login_count: 0,
      deleted_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    })
  })

  it('sorts by MAU and pages with a stable cursor', async () => {
    const first = await call('/v1/platform/organizations?sort=mau_desc&limit=2')
    const page1 = (await first.json()) as {
      data: { id: string; mauThisMonth: number; mauQuota: number | null; userCount: number }[]
      nextCursor: string
      counts: { total: number; suspended: number; deleted: number }
    }

    expect(page1.data.map((org) => org.id)).toEqual(['org_kestrel', 'org_lumen'])
    expect(page1.data[0]).toMatchObject({ mauThisMonth: 900, mauQuota: 1000, userCount: 1 })
    expect(page1.counts).toEqual({ total: 4, suspended: 1, deleted: 0 })

    const second = await call(
      `/v1/platform/organizations?sort=mau_desc&limit=2&cursor=${page1.nextCursor}`,
    )
    const page2 = (await second.json()) as { data: { id: string }[]; nextCursor: string | null }
    expect(page2.data.map((org) => org.id)).toEqual(['org_admin', 'org_bluefin'])
    expect(page2.nextCursor).toBeNull()
  })

  it('filters by status and keeps the default organization non-suspendable', async () => {
    const suspended = (await (
      await call('/v1/platform/organizations?status=suspended')
    ).json()) as {
      data: { id: string }[]
      total: number
    }
    const all = (await (await call('/v1/platform/organizations')).json()) as {
      data: { slug: string; canChangeStatus: boolean }[]
    }

    expect(suspended.data.map((org) => org.id)).toEqual(['org_bluefin'])
    expect(suspended.total).toBe(1)
    expect(all.data.find((org) => org.slug === 'default')?.canChangeStatus).toBe(false)
    expect(all.data.find((org) => org.slug === 'kestrel')?.canChangeStatus).toBe(true)
  })

  it('rejects an unknown status filter', async () => {
    const res = await call('/v1/platform/organizations?status=archived')

    expect(res.status).toBe(422)
  })
})

describe('organization detail and lifecycle', () => {
  beforeEach(() => {
    insertOrganization({ id: 'org_kestrel', slug: 'kestrel', name: 'Kestrel Health' })
    insertOrganization({ id: 'org_kestrel_ops', slug: 'kestrel-ops', parentOrgId: 'org_kestrel' })
    seedUser(db, {
      id: 'user_owner',
      tenantId: 'org_kestrel',
      primaryEmail: 'priya@kestrel.test',
      displayName: 'Priya Raman',
    })
    seedMembership(db, {
      id: 'mem_owner',
      tenantId: 'org_kestrel',
      orgId: 'org_kestrel',
      userId: 'user_owner',
      role: 'owner',
    })
    db.insert('organization_domains', {
      id: 'dom_1',
      tenant_id: 'org_kestrel',
      org_id: 'org_kestrel',
      domain: 'kestrel.test',
      verification_token: 'tok',
      verification_status: 'verified',
      verified_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    })
  })

  it('returns detail with owner, host and sub-organization count', async () => {
    const res = await call('/v1/platform/organizations/org_kestrel')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      id: 'org_kestrel',
      primaryHost: 'kestrel.xid.test',
      subOrganizationCount: 1,
      selfServiceAllowed: true,
      owner: { userId: 'user_owner', name: 'Priya Raman', email: 'priya@kestrel.test' },
      customHostname: null,
      createdBy: null,
    })
  })

  it('returns 404 for an unknown or child organization id', async () => {
    expect((await call('/v1/platform/organizations/org_missing')).status).toBe(404)
    expect((await call('/v1/platform/organizations/org_kestrel_ops')).status).toBe(404)
    expect((await call('/v1/platform/organizations/org_kestrel_ops/members')).status).toBe(404)
  })

  it('lists members and domains of the organization only', async () => {
    seedOrganization(db, { id: 'org_other', tenantId: 'org_other' })
    seedUser(db, { id: 'user_other', tenantId: 'org_other' })
    seedMembership(db, {
      id: 'mem_other',
      tenantId: 'org_other',
      orgId: 'org_other',
      userId: 'user_other',
    })

    const members = (await (
      await call('/v1/platform/organizations/org_kestrel/members')
    ).json()) as {
      data: { user: { userId: string }; role: string }[]
      total: number
    }
    const domains = (await (
      await call('/v1/platform/organizations/org_kestrel/domains')
    ).json()) as {
      data: { domain: string; verified: boolean }[]
    }

    expect(members.data.map((row) => [row.user.userId, row.role])).toEqual([
      ['user_owner', 'owner'],
    ])
    expect(members.total).toBe(1)
    expect(domains.data).toEqual([
      expect.objectContaining({ domain: 'kestrel.test', verified: true }),
    ])
  })

  it('requires confirmSlug to match before deleting', async () => {
    const missing = await call('/v1/platform/organizations/org_kestrel', {
      method: 'PATCH',
      body: { status: 'deleted' },
    })
    const wrong = await call('/v1/platform/organizations/org_kestrel', {
      method: 'PATCH',
      body: { status: 'deleted', confirmSlug: 'kestrel-health' },
    })

    expect(missing.status).toBe(422)
    expect(((await missing.json()) as { meta: { paramName: string } }).meta.paramName).toBe(
      'confirmSlug',
    )
    expect(wrong.status).toBe(422)
    expect(db.rows(`SELECT status FROM organizations WHERE id = 'org_kestrel'`)).toEqual([
      { status: 'active' },
    ])
  })

  it('deletes with the matching slug and reports when sign-in stopped', async () => {
    const res = await call('/v1/platform/organizations/org_kestrel', {
      method: 'PATCH',
      body: { status: 'deleted', confirmSlug: 'kestrel' },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; statusChangedAt: string | null }
    expect(body.status).toBe('deleted')
    expect(body.statusChangedAt).not.toBeNull()
  })

  it('reports the suspension time from the platform audit record', async () => {
    const res = await call('/v1/platform/organizations/org_kestrel', {
      method: 'PATCH',
      body: { status: 'suspended' },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; statusChangedAt: string | null }
    expect(body.status).toBe('suspended')
    expect(body.statusChangedAt).not.toBeNull()
  })
})

describe('GET /v1/platform/users', () => {
  beforeEach(() => {
    insertOrganization({ id: 'org_bluefin', slug: 'bluefin', name: 'Bluefin Maritime' })
    insertOrganization({ id: 'org_bluefin_ops', slug: 'bluefin-ops', parentOrgId: 'org_bluefin' })
    db.database.exec(`UPDATE organizations SET status = 'suspended' WHERE id = 'org_bluefin'`)
    seedUser(db, { id: 'user_hamid', tenantId: 'org_bluefin', primaryEmail: 'hamid@bluefin.test' })
    seedMembership(db, {
      id: 'mem_hamid',
      tenantId: 'org_bluefin',
      orgId: 'org_bluefin_ops',
      userId: 'user_hamid',
    })
    seedUser(db, { id: 'user_never', tenantId: 'org_bluefin', primaryEmail: 'never@bluefin.test' })
    insertSession({
      id: 's_mgr',
      tenantId: 'org_admin',
      userId: 'user_mgr',
      lastActiveAt: NOW + 5_000,
    })
    insertSession({
      id: 's_hamid',
      tenantId: 'org_bluefin',
      userId: 'user_hamid',
      lastActiveAt: NOW + 1_000,
    })
  })

  it('browses every user by most recent sign-in when q is empty', async () => {
    const res = await call('/v1/platform/users')

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { id: string; lastSignInAt: string | null; organizationStatus: string }[]
      total: number
    }
    expect(body.data.map((row) => row.id)).toEqual([
      'user_mgr',
      'user_hamid',
      'user_never',
      'user_plain',
    ])
    expect(body.data[1]).toMatchObject({
      lastSignInAt: new Date(NOW + 1_000).toISOString(),
      organizationStatus: 'suspended',
    })
    expect(body.data[2]?.lastSignInAt).toBeNull()
    expect(body.total).toBe(4)
  })

  it('pages the browse order with a cursor', async () => {
    const first = (await (await call('/v1/platform/users?limit=2')).json()) as {
      data: { id: string }[]
      nextCursor: string
    }
    const second = (await (
      await call(`/v1/platform/users?limit=2&cursor=${first.nextCursor}`)
    ).json()) as {
      data: { id: string }[]
    }

    expect(first.data.map((row) => row.id)).toEqual(['user_mgr', 'user_hamid'])
    expect(second.data.map((row) => row.id)).toEqual(['user_never', 'user_plain'])
  })

  it('filters by organization and lists only same-tenant active memberships', async () => {
    seedMembership(db, {
      id: 'mem_cross',
      tenantId: 'org_admin',
      orgId: 'org_admin',
      userId: 'user_hamid',
    })

    const body = (await (await call('/v1/platform/users?organizationId=org_bluefin')).json()) as {
      data: { id: string; organizations: { id: string }[] }[]
    }

    expect(body.data.map((row) => row.id)).toEqual(['user_hamid', 'user_never'])
    expect(body.data[0]?.organizations.map((organization) => organization.id)).toEqual([
      'org_bluefin_ops',
    ])
  })

  it('filters by status and excludes soft-deleted users', async () => {
    db.database.exec(`UPDATE users SET status = 'banned' WHERE id = 'user_never'`)
    db.database.exec(`UPDATE users SET deleted_at = ${NOW} WHERE id = 'user_plain'`)

    const banned = (await (await call('/v1/platform/users?status=banned')).json()) as {
      data: { id: string; status: string }[]
    }
    const all = (await (await call('/v1/platform/users')).json()) as { data: { id: string }[] }

    expect(banned.data).toEqual([expect.objectContaining({ id: 'user_never', status: 'banned' })])
    expect(all.data.map((row) => row.id)).not.toContain('user_plain')
  })

  it('searches by email, user ID and phone', async () => {
    db.insert('user_phones', {
      id: 'ph_1',
      tenant_id: 'org_bluefin',
      user_id: 'user_never',
      phone: '+15550001111',
      created_at: NOW,
      updated_at: NOW,
    })

    const byEmail = (await (await call('/v1/platform/users?q=hamid@')).json()) as {
      data: { id: string }[]
    }
    const byId = (await (await call('/v1/platform/users?q=user_plain')).json()) as {
      data: { id: string }[]
    }
    const byPhone = (await (await call('/v1/platform/users?q=5550001111')).json()) as {
      data: { id: string }[]
    }

    expect(byEmail.data.map((row) => row.id)).toEqual(['user_hamid'])
    expect(byId.data.map((row) => row.id)).toEqual(['user_plain'])
    expect(byPhone.data.map((row) => row.id)).toEqual(['user_never'])
  })

  it('records every cross-tenant browse in the platform audit', async () => {
    await call('/v1/platform/users?status=active')

    const audits = db.rows(
      `SELECT payload FROM platform_audit_outbox WHERE action = 'platform.users.searched'`,
    )
    expect(audits).toHaveLength(1)
    expect(JSON.parse(String(audits[0]?.['payload']))).toMatchObject({ status: 'active' })
  })
})

describe('instance manager assignments', () => {
  beforeEach(() => {
    seedUser(db, {
      id: 'user_marcus',
      tenantId: 'org_admin',
      primaryEmail: 'marcus@xid.test',
      displayName: 'Marcus Webb',
    })
  })

  it('grants by organization and exact primary email and records granted_by', async () => {
    const res = await call('/v1/platform/manager-assignments', {
      method: 'POST',
      body: { organization_id: 'org_admin', email: 'Marcus@xid.test' },
    })

    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      userId: 'user_marcus',
      grantedBy: { userId: 'user_mgr', displayName: 'Dana Ortiz' },
    })
    expect(
      db.rows(`SELECT granted_by FROM manager_assignments WHERE user_id = 'user_marcus'`),
    ).toEqual([{ granted_by: 'user_mgr' }])
  })

  it('returns 404 when the email does not belong to that organization', async () => {
    seedOrganization(db, { id: 'org_other', tenantId: 'org_other' })

    const res = await call('/v1/platform/manager-assignments', {
      method: 'POST',
      body: { organization_id: 'org_other', email: 'marcus@xid.test' },
    })

    expect(res.status).toBe(404)
  })

  it('lists last activity and the setup grant without a grantor', async () => {
    insertSession({ id: 's_mgr', tenantId: 'org_admin', userId: 'user_mgr', lastActiveAt: NOW })

    const body = (await (await call('/v1/platform/manager-assignments')).json()) as {
      data: { userId: string; grantedBy: unknown; lastActiveAt: string | null }[]
    }

    expect(body.data).toEqual([
      expect.objectContaining({
        userId: 'user_mgr',
        grantedBy: null,
        lastActiveAt: new Date(NOW).toISOString(),
      }),
    ])
  })
})
