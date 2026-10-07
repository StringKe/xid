// POST /v1/me/organizations/:orgId/leave:真实 SQLite 验证 owner 保护、active org 清空与租户隔离。

import { describe, expect, it, vi } from 'vitest'
import { registerMeOrganizationsRoutes } from '../organizations'
import { buildApp, makeSession } from './harness'
import { seedMembership, seedOrganization, seedUser, SqliteD1 } from './sqlite-d1'

const NOW = Date.now()

function seed(): SqliteD1 {
  const db = new SqliteD1()
  seedOrganization(db, { id: 't_1', tenantId: 't_1' })
  seedOrganization(db, { id: 'org_field', tenantId: 't_1', name: 'Field crews' })
  seedOrganization(db, { id: 't_2', tenantId: 't_2' })
  seedUser(db, { id: 'u_1', tenantId: 't_1' })
  seedUser(db, { id: 'u_2', tenantId: 't_1' })
  seedUser(db, { id: 'u_9', tenantId: 't_2' })
  db.insert('sessions', {
    id: 's_current',
    tenant_id: 't_1',
    user_id: 'u_1',
    refresh_token_hash: 'session_hash',
    active_org_id: 'org_field',
    status: 'active',
    remember_me: 0,
    is_impersonation: 0,
    authenticated_at: NOW,
    last_active_at: NOW,
    expires_at: NOW + 86_400_000,
    created_at: NOW,
  })
  return db
}

function makeEnv(db: SqliteD1): { env: Env; webhooks: ReturnType<typeof vi.fn> } {
  const webhooks = vi.fn().mockResolvedValue(undefined)
  const env = {
    DB: db.asD1(),
    AUDIT_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    WEBHOOK_QUEUE: { send: webhooks },
    SCIM_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Env
  return { env, webhooks }
}

async function leave(db: SqliteD1, orgId: string, userId = 'u_1'): Promise<Response> {
  const { env } = makeEnv(db)
  const app = buildApp({
    register: registerMeOrganizationsRoutes,
    session: makeSession({ userId, activeOrgId: 'org_field' }),
  })
  return app.request(
    `https://acme.xid.dev/v1/me/organizations/${orgId}/leave`,
    { method: 'POST' },
    env,
  )
}

function membershipStatus(db: SqliteD1, id: string): unknown {
  return db.rows('SELECT status FROM memberships WHERE id = ?', id)[0]?.['status']
}

describe('POST /v1/me/organizations/:orgId/leave', () => {
  it('deactivates the membership and clears the active organization of the session', async () => {
    const db = seed()
    seedMembership(db, { id: 'm_1', tenantId: 't_1', orgId: 'org_field', userId: 'u_1' })

    const res = await leave(db, 'org_field')

    expect(res.status).toBe(204)
    expect(membershipStatus(db, 'm_1')).toBe('inactive')
    expect(db.rows("SELECT active_org_id FROM sessions WHERE id = 's_current'")).toEqual([
      { active_org_id: null },
    ])
  })

  it('refuses to let the only owner leave', async () => {
    const db = seed()
    seedMembership(db, {
      id: 'm_1',
      tenantId: 't_1',
      orgId: 'org_field',
      userId: 'u_1',
      role: 'owner',
    })
    seedMembership(db, { id: 'm_2', tenantId: 't_1', orgId: 'org_field', userId: 'u_2' })

    const res = await leave(db, 'org_field')

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'last_owner' })
    expect(membershipStatus(db, 'm_1')).toBe('active')
  })

  it('lets an owner leave when another active owner remains', async () => {
    const db = seed()
    seedMembership(db, {
      id: 'm_1',
      tenantId: 't_1',
      orgId: 'org_field',
      userId: 'u_1',
      role: 'owner',
    })
    seedMembership(db, {
      id: 'm_2',
      tenantId: 't_1',
      orgId: 'org_field',
      userId: 'u_2',
      role: 'owner',
    })

    const res = await leave(db, 'org_field')

    expect(res.status).toBe(204)
    expect(membershipStatus(db, 'm_1')).toBe('inactive')
  })

  it('returns 404 for an organization in another tenant', async () => {
    const db = seed()
    seedMembership(db, { id: 'm_9', tenantId: 't_2', orgId: 't_2', userId: 'u_9' })

    const res = await leave(db, 't_2', 'u_9')

    expect(res.status).toBe(404)
    expect(membershipStatus(db, 'm_9')).toBe('active')
  })

  it('returns 404 when the user is not a member', async () => {
    const db = seed()
    seedMembership(db, { id: 'm_2', tenantId: 't_1', orgId: 'org_field', userId: 'u_2' })

    const res = await leave(db, 'org_field')

    expect(res.status).toBe(404)
    expect(membershipStatus(db, 'm_2')).toBe('active')
  })
})
