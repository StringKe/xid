// /v1/me/authorized-apps:只列本人本租户的同意记录;撤销只影响该应用的 token,浏览器会话不动。

import { describe, expect, it, vi } from 'vitest'
import { registerAuthorizedAppsRoutes } from '../authorized-apps'
import { buildApp, makeSession, TENANT, TEST_PEPPER } from './harness'
import { seedOrganization, seedUser, SqliteD1 } from './sqlite-d1'

const NOW = Date.now()

function seed(): SqliteD1 {
  const db = new SqliteD1()
  seedOrganization(db, { id: 't_1', tenantId: 't_1', name: 'Northwind Logistics' })
  seedOrganization(db, { id: 't_2', tenantId: 't_2', name: 'Globex' })
  seedUser(db, { id: 'u_1', tenantId: 't_1' })
  seedUser(db, { id: 'u_2', tenantId: 't_1' })
  seedUser(db, { id: 'u_9', tenantId: 't_2' })
  db.insert('projects', {
    id: 'proj_route',
    tenant_id: 't_1',
    org_id: 't_1',
    name: 'Routewise Analytics',
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
  })
  for (const [clientId, tenantId] of [
    ['client_route', 't_1'],
    ['client_shift', 't_1'],
    ['client_globex', 't_2'],
  ] as const) {
    db.insert('applications', {
      id: `app_${clientId}`,
      tenant_id: tenantId,
      project_id: clientId === 'client_route' ? 'proj_route' : null,
      client_id: clientId,
      redirect_uris: JSON.stringify(['http://127.0.0.1/cb', `https://${clientId}.example/cb`]),
      created_at: NOW,
      updated_at: NOW,
    })
  }
  const consent = (id: string, tenantId: string, userId: string, clientId: string) =>
    db.insert('oauth_consents', {
      id,
      tenant_id: tenantId,
      user_id: userId,
      client_id: clientId,
      granted_scopes: JSON.stringify(['openid', 'email']),
      created_at: NOW,
      updated_at: NOW,
    })
  consent('c_1', 't_1', 'u_1', 'client_route')
  consent('c_2', 't_1', 'u_1', 'client_shift')
  consent('c_3', 't_1', 'u_2', 'client_route')
  consent('c_4', 't_2', 'u_9', 'client_globex')
  const refresh = (id: string, userId: string, clientId: string) =>
    db.insert('refresh_tokens', {
      id,
      tenant_id: 't_1',
      token_hash: `hash_${id}`,
      family_id: `fam_${id}`,
      user_id: userId,
      client_id: clientId,
      scope: 'openid',
      expires_at: NOW + 86_400_000,
      absolute_expires_at: NOW + 86_400_000,
      created_at: NOW,
    })
  refresh('rt_route', 'u_1', 'client_route')
  refresh('rt_shift', 'u_1', 'client_shift')
  refresh('rt_other_user', 'u_2', 'client_route')
  db.insert('access_token_issuances', {
    id: 'ati_1',
    tenant_id: 't_1',
    jti: 'jti_route',
    client_id: 'client_route',
    subject: 'u_1',
    expires_at: NOW + 3_600_000,
    created_at: NOW,
  })
  db.insert('sessions', {
    id: 's_current',
    tenant_id: 't_1',
    user_id: 'u_1',
    refresh_token_hash: 'session_hash',
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

function makeEnv(db: SqliteD1): { env: Env; audit: ReturnType<typeof vi.fn> } {
  const audit = vi.fn().mockResolvedValue(undefined)
  const env = { DB: db.asD1(), PEPPER: TEST_PEPPER, AUDIT_QUEUE: { send: audit } } as unknown as Env
  return { env, audit }
}

describe('GET /v1/me/authorized-apps', () => {
  it('lists only the current user consents in the current tenant with display data', async () => {
    const db = seed()
    const { env } = makeEnv(db)
    const app = buildApp({ register: registerAuthorizedAppsRoutes, session: makeSession() })

    const res = await app.request('https://acme.xid.dev/v1/me/authorized-apps', {}, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>[]
    expect(body.map((item) => item['clientId']).sort()).toEqual(['client_route', 'client_shift'])
    expect(body.find((item) => item['clientId'] === 'client_route')).toMatchObject({
      name: 'Routewise Analytics',
      redirectOrigin: 'https://client_route.example',
      grantedScopes: ['openid', 'email'],
    })
    expect(body.find((item) => item['clientId'] === 'client_shift')).toMatchObject({
      name: 'client_shift',
    })
  })
})

describe('DELETE /v1/me/authorized-apps/:clientId', () => {
  it('removes the consent and revokes only that application tokens', async () => {
    const db = seed()
    const { env, audit } = makeEnv(db)
    const app = buildApp({ register: registerAuthorizedAppsRoutes, session: makeSession() })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/authorized-apps/client_route',
      { method: 'DELETE' },
      env,
    )

    expect(res.status).toBe(204)
    expect(db.rows('SELECT id FROM oauth_consents ORDER BY id').map((r) => r['id'])).toEqual([
      'c_2',
      'c_3',
      'c_4',
    ])
    const revoked = db.rows(
      'SELECT id FROM refresh_tokens WHERE family_revoked_at IS NOT NULL ORDER BY id',
    )
    expect(revoked.map((r) => r['id'])).toEqual(['rt_route'])
    expect(db.rows('SELECT jti FROM access_token_revocations')).toEqual([{ jti: 'jti_route' }])
    expect(db.rows("SELECT status FROM sessions WHERE id = 's_current'")).toEqual([
      { status: 'active' },
    ])
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'consent.revoked', actorId: 'u_1' }),
    )
  })

  it('returns 404 for another user consent in the same tenant', async () => {
    const db = seed()
    const { env } = makeEnv(db)
    const app = buildApp({
      register: registerAuthorizedAppsRoutes,
      session: makeSession({ userId: 'u_2' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/authorized-apps/client_shift',
      { method: 'DELETE' },
      env,
    )

    expect(res.status).toBe(404)
    expect(db.rows("SELECT id FROM oauth_consents WHERE id = 'c_2'")).toHaveLength(1)
  })

  it('returns 404 for a consent that belongs to another tenant', async () => {
    const db = seed()
    const { env } = makeEnv(db)
    const app = buildApp({
      register: registerAuthorizedAppsRoutes,
      session: makeSession({ userId: 'u_9' }),
      tenant: TENANT,
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/authorized-apps/client_globex',
      { method: 'DELETE' },
      env,
    )

    expect(res.status).toBe(404)
    expect(db.rows("SELECT id FROM oauth_consents WHERE id = 'c_4'")).toHaveLength(1)
  })
})
