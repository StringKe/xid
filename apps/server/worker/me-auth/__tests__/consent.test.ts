// GET /auth/consent-params + POST /auth/consent 单测:
// 无 session -> 401;consent-params happy -> client 展示数据 + scope 名;
// consent approved -> UPSERT 持久化 + 决定写回暂存记录 + /authorize 续跑地址;
// denied -> 不持久化,决定写回暂存记录;prompt_id 失效(DO 无记录)-> invalid_request。

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    projects: { id: 'id' },
    organizations: { id: 'id' },
    oauthConsents: { userId: 'userId', clientId: 'clientId' },
    resourceServers: { audience: 'audience' },
  },
}))

vi.mock('../../oidc/shared', () => ({
  findClient: vi.fn(),
}))

vi.mock('../../lib/session', () => ({
  readSession: vi.fn(),
  ACTIVE_SESSION_STATUS: 'active',
  PENDING_MFA_SESSION_STATUS: 'pending_mfa',
  PENDING_MFA_SETUP_SESSION_STATUS: 'pending_mfa_setup',
}))

import { createTenantDb } from '@xid-kit/db'
import { findClient } from '../../oidc/shared'
import { readSession } from '../../lib/session'
import { redirectOriginOf } from '../consent'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeSession } from './helpers'

type StoredRecord = Record<string, unknown>

// OAUTH_STATE DO:consume 返回暂存记录,store 记录写入体并默认返回 201。pending=null 模拟失效。
// consumeBody 传原始串,用于构造 DO 返回坏 body 的场景。
function oauthStateNs(
  pending: Record<string, string> | null,
  options: { storeStatus?: number; consumeStatus?: number; consumeBody?: string } = {},
): { ns: DurableObjectNamespace; stored: StoredRecord[] } {
  const stored: StoredRecord[] = []
  const ns = {
    idFromName: () => ({ toString: () => 'authz-id' }) as DurableObjectId,
    get: () =>
      ({
        fetch: async (input: string | Request, init?: RequestInit) => {
          const rawUrl = typeof input === 'string' ? input : input.url
          const url = new URL(rawUrl)
          if (url.pathname === '/store') {
            stored.push(JSON.parse(String(init?.body)) as StoredRecord)
            return new Response(null, { status: options.storeStatus ?? 201 })
          }
          if (!pending) return new Response('not found', { status: 404 })
          return new Response(
            options.consumeBody ??
              JSON.stringify({
                record: { pendingParams: pending, interactionStartedAt: 1_000, viaPar: true },
              }),
            { status: options.consumeStatus ?? 200 },
          )
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
  return { ns, stored }
}

type PreparedCall = { sql: string; params: unknown[] }

function consentDb(): { db: D1Database; calls: PreparedCall[] } {
  const calls: PreparedCall[] = []
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => {
          calls.push({ sql, params })
          return { success: true, meta: {} }
        },
      }),
    }),
  } as unknown as D1Database
  return { db, calls }
}

const PENDING = {
  client_id: 'client-1',
  redirect_uri: 'https://rp.example.com/callback',
  scope: 'openid email',
  response_type: 'code',
  state: 'rp-state',
  dpop_jkt: 'jkt_consent',
}

const RAR_DETAILS = [
  {
    type: 'resource_access',
    locations: ['https://api.example/v1'],
    actions: ['read'],
  },
]
const RAR_PENDING = {
  ...PENDING,
  scope: 'openid email',
  authorization_details: JSON.stringify(RAR_DETAILS),
}

function clientDb() {
  return {
    projects: { findOne: vi.fn().mockResolvedValue({ name: 'Acme App', orgId: 'org-1' }) },
    organizations: {
      findOne: vi.fn().mockResolvedValue({ logoUrl: 'https://logo', name: 'Acme Corp' }),
    },
    oauthConsents: { findOne: vi.fn().mockResolvedValue({ grantedScopes: ['openid'] }) },
    resourceServers: {
      findOne: vi.fn().mockResolvedValue({
        audience: 'https://api.example/v1',
        scopes: ['read'],
      }),
      findMany: vi.fn().mockResolvedValue([
        {
          audience: 'https://api.example/v1',
          scopes: ['read'],
        },
      ]),
    },
  } as unknown as ReturnType<typeof createTenantDb>
}

function envWith(pending: Record<string, string> | null): {
  env: Env
  stored: StoredRecord[]
  calls: PreparedCall[]
} {
  const state = oauthStateNs(pending)
  const { db, calls } = consentDb()
  const env = { ...makeEnv({ oauthStateNs: state.ns }), DB: db }
  return { env, stored: state.stored, calls }
}

describe('redirectOriginOf', () => {
  it('returns the origin for https and loopback redirect URIs', () => {
    expect(redirectOriginOf('https://rp.example.com/cb?x=1')).toBe('https://rp.example.com')
    expect(redirectOriginOf('http://127.0.0.1:8080/cb')).toBe('http://127.0.0.1:8080')
  })

  it('returns the scheme and host prefix for native custom schemes', () => {
    expect(redirectOriginOf('com.example.fleet://oauth/callback')).toBe('com.example.fleet://oauth')
    expect(redirectOriginOf('com.example.fleet:/callback')).toBe('com.example.fleet:')
  })

  it('returns null for an unparsable value', () => {
    expect(redirectOriginOf('')).toBeNull()
  })
})

describe('GET /auth/consent-params', () => {
  beforeEach(() => vi.clearAllMocks())

  it('无 session -> 401', async () => {
    vi.mocked(readSession).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, { session: null })
    const res = await app.request(
      '/auth/consent-params?prompt_id=p1',
      { method: 'GET' },
      makeEnv(),
      execCtx,
    )
    expect(res.status).toBe(401)
  })

  it('happy -> client 展示数据 + scope 名(本地化由 SPA 负责)', async () => {
    vi.mocked(findClient).mockResolvedValue({
      clientId: 'client-1',
      projectId: 'project-1',
      firstParty: false,
    } as never)
    vi.mocked(createTenantDb).mockReturnValue(clientDb())
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const { env, stored } = envWith(PENDING)

    const res = await app.request(
      '/auth/consent-params?prompt_id=p1',
      { method: 'GET' },
      env,
      execCtx,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      clientId: string
      clientName: string
      ownerOrganizationName: string
      redirectOrigin: string
      previouslyGrantedScopes: string[]
      scopes: { name: string }[]
      authorizationDetails: typeof RAR_DETAILS
    }
    expect(body.clientId).toBe('client-1')
    expect(body.clientName).toBe('Acme App')
    expect(body.ownerOrganizationName).toBe('Acme Corp')
    expect(body.redirectOrigin).toBe('https://rp.example.com')
    expect(body.previouslyGrantedScopes).toEqual(['openid'])
    expect(body.scopes).toEqual([{ name: 'openid' }, { name: 'email' }])
    expect(body.authorizationDetails).toEqual([])
    expect(stored[0]).toMatchObject({ interactionStartedAt: 1_000, viaPar: true })
  })

  it('happy + RAR -> 返回 authorizationDetails 供 consent 展示', async () => {
    vi.mocked(findClient).mockResolvedValue({
      clientId: 'client-1',
      projectId: 'project-1',
      firstParty: false,
    } as never)
    vi.mocked(createTenantDb).mockReturnValue(clientDb())
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const { env } = envWith(RAR_PENDING)
    const res = await app.request(
      '/auth/consent-params?prompt_id=p1',
      { method: 'GET' },
      env,
      execCtx,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { authorizationDetails: typeof RAR_DETAILS }
    expect(body.authorizationDetails).toEqual(RAR_DETAILS)
  })

  it('pending 参数 re-store 失败 -> server_error(不返回可用的 consent 页)', async () => {
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(PENDING, { storeStatus: 500 }).ns })

    const res = await app.request(
      '/auth/consent-params?prompt_id=p1',
      { method: 'GET' },
      env,
      execCtx,
    )

    expect(res.status).toBe(500)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'server_error' })
  })

  it('pending 参数 consume 返回 malformed body -> server_error(不当作失效放行)', async () => {
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({
      oauthStateNs: oauthStateNs(PENDING, { consumeBody: JSON.stringify({ record: null }) }).ns,
    })

    const res = await app.request(
      '/auth/consent-params?prompt_id=p1',
      { method: 'GET' },
      env,
      execCtx,
    )

    expect(res.status).toBe(500)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'server_error' })
  })

  it('pending 参数 consume 返回非预期状态 -> server_error(区别于 404 失效)', async () => {
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(PENDING, { consumeStatus: 500 }).ns })

    const res = await app.request(
      '/auth/consent-params?prompt_id=p1',
      { method: 'GET' },
      env,
      execCtx,
    )

    expect(res.status).toBe(500)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'server_error' })
  })

  it('prompt_id 失效(DO 无记录)-> invalid_request', async () => {
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(null).ns })
    const res = await app.request(
      '/auth/consent-params?prompt_id=gone',
      { method: 'GET' },
      env,
      execCtx,
    )
    expect(((await res.json()) as { code: string }).code).toBe('invalid_request')
  })
})

function post(app: ReturnType<typeof makeApp>, env: Env, body: unknown) {
  return app.request(
    '/auth/consent',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
    execCtx,
  )
}

// handleConsent 批准路径复核 client 现状(TOCTOU):mock 一个 active client。
function mockActiveClient(allowedScopes: string[] = ['openid', 'email', 'read']) {
  vi.mocked(findClient).mockResolvedValue({ clientId: 'client-1', allowedScopes } as never)
}

describe('POST /auth/consent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('approved=true -> 租户绑定 UPSERT 持久化 + 决定写回暂存记录 + /authorize 续跑地址', async () => {
    vi.mocked(createTenantDb).mockReturnValue(clientDb())
    mockActiveClient()
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const { env, stored, calls } = envWith(PENDING)

    const res = await post(app, env, { promptId: 'p1', approved: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      redirectUrl: '/authorize?authz_request_id=p1&client_id=client-1',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sql).toContain('ON CONFLICT(tenant_id, user_id, client_id)')
    expect(calls[0]?.params[1]).toBe('tenant-1')
    expect(calls[0]?.params[4]).toBe(JSON.stringify(['openid', 'email']))
    expect(stored[0]).toMatchObject({
      state: 'p1',
      pendingParams: PENDING,
      interactionStartedAt: 1_000,
      viaPar: true,
      consentDecision: { decision: 'approved', userId: 'user-1', sessionId: 'sess-1' },
    })
  })

  it('approved=true + RAR -> 持久化合并后的 action scope', async () => {
    vi.mocked(createTenantDb).mockReturnValue(clientDb())
    mockActiveClient()
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const { env, calls } = envWith(RAR_PENDING)

    const res = await post(app, env, { promptId: 'p1', approved: true })

    expect(res.status).toBe(200)
    expect(calls[0]?.params[4]).toBe(JSON.stringify(['openid', 'email', 'read']))
  })

  it('approved=false -> 不持久化,denied 决定写回暂存记录', async () => {
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const { env, stored, calls } = envWith(PENDING)

    const res = await post(app, env, { promptId: 'p1', approved: false })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { redirectUrl: string }).redirectUrl).toBe(
      '/authorize?authz_request_id=p1&client_id=client-1',
    )
    expect(calls).toHaveLength(0)
    expect(stored[0]).toMatchObject({
      consentDecision: { decision: 'denied', userId: 'user-1', sessionId: 'sess-1' },
    })
  })

  it('无 session -> 401', async () => {
    vi.mocked(readSession).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, { session: null })
    const res = await post(app, makeEnv(), { promptId: 'p1', approved: true })
    expect(res.status).toBe(401)
  })

  it('pending_mfa session -> 401(MFA 未完成不算已认证)', async () => {
    vi.mocked(readSession).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, {
      session: { ...makeSession(), status: 'pending_mfa' },
    })
    const res = await post(app, makeEnv(), { promptId: 'p1', approved: true })
    expect(res.status).toBe(401)
  })

  it('approved=true 但 client 已被禁用 -> invalid_client,不持久化不写回决定(TOCTOU)', async () => {
    vi.mocked(findClient).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const { env, stored, calls } = envWith(PENDING)

    const res = await post(app, env, { promptId: 'p1', approved: true })

    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_client')
    expect(calls).toHaveLength(0)
    expect(stored).toHaveLength(0)
  })

  it('approved=true 但 scope 已被收窄 -> invalid_scope,不持久化不写回决定(TOCTOU)', async () => {
    vi.mocked(createTenantDb).mockReturnValue(clientDb())
    mockActiveClient(['openid'])
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const { env, stored, calls } = envWith(PENDING)

    const res = await post(app, env, { promptId: 'p1', approved: true })

    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_scope')
    expect(calls).toHaveLength(0)
    expect(stored).toHaveLength(0)
  })
})
