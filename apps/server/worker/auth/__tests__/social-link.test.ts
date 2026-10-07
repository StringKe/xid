// 账户门户绑定社交账号:发起需要会话(和 step-up),回调只关联到发起的用户,不签发会话、不切换账号。

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../social-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../social-providers')>()
  return {
    ...actual,
    exchangeCode: vi.fn().mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: null,
      idToken: 'id-token',
    }),
  }
})

vi.mock('../social-profile', () => ({ resolveProfile: vi.fn() }))

import type { TenantContext } from '@xid-kit/types'
import { Hono } from 'hono'
import { isAppError } from '../../lib/errors'
import type { SessionData, XidHonoEnv } from '../../lib/types'
import { registerSocialConnectionsRoutes } from '../../me/social-connections'
import { makeSession } from '../../me/__tests__/harness'
import { seedOrganization, seedUser, SqliteD1 } from '../../me/__tests__/sqlite-d1'
import { resolveProfile } from '../social-profile'
import { registerSocialRoutes } from '../social'

const TENANT = {
  tenantId: 't_1',
  issuer: 'https://northwind.xid.dev',
  rpId: 'northwind.xid.dev',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {
    socialProviders: {
      github: {
        authorizationEndpoint: 'https://github.com/login/oauth/authorize',
        tokenEndpoint: 'https://github.com/login/oauth/access_token',
        clientId: 'github-client',
        clientSecretRef: 'GITHUB_CLIENT_SECRET',
        scopes: ['read:user', 'user:email'],
        usesPkce: true,
        enabled: true,
        allowLogin: true,
        allowUserCreation: false,
        requireVerifiedEmail: true,
        allowedEmailDomains: [],
        blockedEmailDomains: [],
      },
    },
  },
} as unknown as TenantContext

function oauthStateNs(): DurableObjectNamespace {
  const records = new Map<string, Record<string, unknown>>()
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        const state = String(body['state'])
        if (url.endsWith('/store')) {
          records.set(state, body)
          return new Response(null, { status: 201 })
        }
        const record = records.get(state)
        records.delete(state)
        return record ? Response.json({ record }) : new Response(null, { status: 404 })
      },
    }),
  } as unknown as DurableObjectNamespace
}

function seed(): SqliteD1 {
  const db = new SqliteD1()
  seedOrganization(db, { id: 't_1', tenantId: 't_1' })
  seedUser(db, { id: 'u_1', tenantId: 't_1', primaryEmail: 'amara@northwind.test' })
  seedUser(db, { id: 'u_2', tenantId: 't_1', primaryEmail: 'lena@northwind.test' })
  return db
}

function makeApp(session: SessionData | null): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError((err, c) =>
    isAppError(err)
      ? c.json({ code: err.code }, err.httpStatus as 400)
      : c.json({ code: 'server_error' }, 500),
  )
  app.use('*', async (c, next) => {
    c.set('tenant', TENANT)
    c.set('session', session)
    await next()
  })
  registerSocialConnectionsRoutes(app)
  registerSocialRoutes(app)
  return app
}

function makeEnv(db: SqliteD1): Env {
  return {
    DB: db.asD1(),
    OAUTH_STATE: oauthStateNs(),
    AUDIT_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    KEK: btoa('A'.repeat(32)),
    GITHUB_CLIENT_SECRET: 'secret-1',
    PEPPER: 'v1:3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d',
  } as unknown as Env
}

async function startLink(app: Hono<XidHonoEnv>, env: Env): Promise<string> {
  const res = await app.request(
    'https://northwind.xid.dev/v1/me/social-connections/github/link',
    { method: 'POST' },
    env,
  )
  expect(res.status).toBe(200)
  const { url } = (await res.json()) as { url: string }
  return new URL(url).searchParams.get('state') ?? ''
}

function callback(app: Hono<XidHonoEnv>, env: Env, state: string): Promise<Response> {
  return app.request(
    `https://northwind.xid.dev/auth/github/callback?code=abc&state=${state}`,
    { headers: { accept: 'text/html' } },
    env,
  )
}

beforeEach(() => {
  vi.mocked(resolveProfile).mockResolvedValue({
    idpUserId: 'gh-42',
    email: 'amara@personal.test',
    emailVerified: true,
    name: 'Amara',
    profileRaw: { email: 'amara@personal.test' },
  })
})

describe('linking a social account from the account portal', () => {
  it('links the provider account to the signed-in user without issuing a new session', async () => {
    const db = seed()
    const env = makeEnv(db)
    const app = makeApp(makeSession({ userId: 'u_1' }))

    const state = await startLink(app, env)
    const res = await callback(app, env, state)

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/account/security?connected=github')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(db.rows('SELECT user_id, provider, provider_user_id FROM user_identities')).toEqual([
      { user_id: 'u_1', provider: 'github', provider_user_id: 'gh-42' },
    ])
  })

  it('returns already_linked and changes nothing when another user owns the provider account', async () => {
    const db = seed()
    db.insert('user_identities', {
      id: 'idn_other',
      tenant_id: 't_1',
      user_id: 'u_2',
      identity_type: 'oauth',
      provider: 'github',
      provider_user_id: 'gh-42',
      created_at: 1,
      updated_at: 1,
    })
    const env = makeEnv(db)
    const app = makeApp(makeSession({ userId: 'u_1' }))

    const state = await startLink(app, env)
    const res = await callback(app, env, state)

    expect(res.headers.get('location')).toBe(
      '/account/security?connect_error=already_linked&provider=github',
    )
    expect(db.rows('SELECT user_id FROM user_identities')).toEqual([{ user_id: 'u_2' }])
  })

  it('refuses to finish the link in a different browser session', async () => {
    const db = seed()
    const env = makeEnv(db)
    const state = await startLink(makeApp(makeSession({ userId: 'u_1' })), env)

    const res = await callback(
      makeApp(makeSession({ userId: 'u_2', sessionId: 's_other' })),
      env,
      state,
    )

    expect(res.headers.get('location')).toBe(
      '/account/security?connect_error=failed&provider=github',
    )
    expect(db.rows('SELECT id FROM user_identities')).toEqual([])
  })

  it('requires a signed-in session to start linking', async () => {
    const db = seed()

    const res = await makeApp(null).request(
      'https://northwind.xid.dev/v1/me/social-connections/github/link',
      { method: 'POST' },
      makeEnv(db),
    )

    expect(res.status).toBe(401)
  })
})
