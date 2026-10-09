// SWA password vaulting: member-owned downstream credentials, KEK envelopes, and the launch form.

import { Hono } from 'hono'
import type { ErrorHandler } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isAppError } from '../../lib/errors'
import type { SessionData, XidHonoEnv } from '../../lib/types'
import { registerSwaRoutes } from '../swa'

type Predicate = { eq: [string, unknown] } | { and: Predicate[] }
type Row = Record<string, unknown> & {
  id: string
  tenantId: string
  updatedAt: Date
  attributeMapping: Record<string, unknown>
}

const rows: Row[] = []
let beforeUpdate: (() => void) | null = null

function matches(row: Row, predicate: Predicate): boolean {
  if ('and' in predicate) return predicate.and.every((part) => matches(row, part))
  const [column, value] = predicate.eq
  const actual = row[column]
  return actual instanceof Date && value instanceof Date
    ? actual.getTime() === value.getTime()
    : actual === value
}

vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: unknown) => ({ eq: [column, value] }),
  and: (...parts: Predicate[]) => ({ and: parts }),
}))

vi.mock('@xid-kit/db', () => ({
  createTenantDb: (_db: unknown, tenant: { tenantId: string }) => {
    const scoped = () => rows.filter((row) => row.tenantId === tenant.tenantId)
    return {
      ssoConnections: {
        findOne: async (where: Predicate) => {
          const row = scoped().find((candidate) => matches(candidate, where))
          return row ? structuredClone(row) : undefined
        },
        update: async (values: Partial<Row>, where: Predicate) => {
          beforeUpdate?.()
          beforeUpdate = null
          const hit = scoped().filter((row) => matches(row, where))
          for (const row of hit) Object.assign(row, structuredClone(values))
          return hit
        },
      },
    }
  },
  resolveTenantContextBySsoConnection: vi.fn(),
  schema: { ssoConnections: { id: 'id', updatedAt: 'updatedAt' } },
}))

const mockReadSessionForTenant = vi.fn()
const mockFindActiveMembership = vi.fn()

vi.mock('../../lib/session', () => ({
  issueSession: vi.fn(),
  readSessionForTenant: (...args: unknown[]) => mockReadSessionForTenant(...args),
}))
vi.mock('../../me/shared', () => ({
  findActiveMembership: (...args: unknown[]) => mockFindActiveMembership(...args),
}))

const env = {
  DB: {},
  ENVIRONMENT: 'production',
  KEK: btoa(String.fromCharCode(...new Uint8Array(32).fill(0x44))),
} as unknown as Env

const TARGET = 'https://portal.acme-corp.net/login'

function session(userId: string, overrides: Partial<SessionData> = {}): SessionData {
  return {
    sessionId: `s-${userId}`,
    userId,
    status: 'active',
    isImpersonation: false,
    ...overrides,
  } as SessionData
}

function swaRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'conn-swa',
    tenantId: 'tenant-1',
    orgId: 'org-1',
    protocol: 'swa',
    status: 'active',
    idpSsoUrl: null,
    updatedAt: new Date(1_000),
    attributeMapping: {
      _legacy: { swaTargetUrl: TARGET, swaUsernameField: 'login', swaPasswordField: 'secret' },
    },
    ...overrides,
  }
}

const errorHandler: ErrorHandler<XidHonoEnv> = (err, c) =>
  isAppError(err)
    ? c.json({ code: err.code }, err.httpStatus as Parameters<typeof c.json>[1])
    : c.json({ code: 'server_error' }, 500)

function buildApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', {
      tenantId: 'tenant-1',
      issuer: 'https://tenant-1.xid.dev',
      rpId: 'tenant-1.xid.dev',
    } as never)
    await next()
  })
  registerSwaRoutes(app)
  return app
}

function saveCredential(username: string, password: string): Promise<Response> {
  return Promise.resolve(
    buildApp().request(
      '/sso/swa/conn-swa/vault',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      },
      env,
    ),
  )
}

function launch(): Promise<Response> {
  return Promise.resolve(buildApp().request('/sso/swa/conn-swa/launch', {}, env))
}

describe('SWA password vault', () => {
  beforeEach(() => {
    rows.length = 0
    beforeUpdate = null
    vi.clearAllMocks()
    rows.push(swaRow())
    mockReadSessionForTenant.mockResolvedValue(session('user-1'))
    mockFindActiveMembership.mockResolvedValue({ id: 'm-1', status: 'active' })
  })

  it('rejects a request without an XID session before validating the body', async () => {
    mockReadSessionForTenant.mockResolvedValue(null)

    const res = await saveCredential('', '')

    expect(res.status).toBe(401)
    expect(rows[0]?.attributeMapping).not.toHaveProperty('_swaCredentials')
  })

  it('refuses to store or replay credentials during impersonation', async () => {
    mockReadSessionForTenant.mockResolvedValue(session('user-1', { isImpersonation: true }))

    const saved = await saveCredential('alice', 'downstream-pass')
    const launched = await launch()

    expect(saved.status).toBe(403)
    expect(launched.status).toBe(403)
  })

  it('hides the connection from users who are not members of its organization', async () => {
    mockFindActiveMembership.mockResolvedValue(undefined)

    const res = await saveCredential('alice', 'downstream-pass')

    expect(res.status).toBe(404)
    expect(rows[0]?.attributeMapping).not.toHaveProperty('_swaCredentials')
  })

  it('returns 404 for a connection that belongs to another tenant', async () => {
    rows.length = 0
    rows.push(swaRow({ tenantId: 'tenant-2' }))

    const res = await saveCredential('alice', 'downstream-pass')

    expect(res.status).toBe(404)
    expect(rows[0]?.attributeMapping).not.toHaveProperty('_swaCredentials')
  })

  it('stores credentials encrypted and reports only the username', async () => {
    const saved = await saveCredential('alice', 'downstream-pass')
    const status = await buildApp().request('/sso/swa/conn-swa/vault', {}, env)

    expect(saved.status).toBe(200)
    expect(JSON.stringify(rows[0]?.attributeMapping)).not.toContain('downstream-pass')
    expect(await status.json()).toEqual({ stored: true, username: 'alice' })
  })

  it('launches an auto-submitting form to the configured target with strict headers', async () => {
    await saveCredential('alice"<b>', 'p&ss<word>')

    const res = await launch()
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('form-action https://portal.acme-corp.net')
    expect(csp).toContain("frame-ancestors 'none'")
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1]
    expect(html).toContain(`<script nonce="${nonce}">`)
    expect(html).toContain(`<form method="post" action="${TARGET}">`)
    expect(html).toContain('name="login" value="alice&quot;&lt;b&gt;"')
    expect(html).toContain('name="secret" value="p&amp;ss&lt;word&gt;"')
  })

  it('returns 404 from launch when the member has not stored credentials', async () => {
    const res = await launch()

    expect(res.status).toBe(404)
  })

  it('ignores the retired shared vault format and removes it on the next save', async () => {
    rows[0]!.attributeMapping = {
      ...rows[0]!.attributeMapping,
      _swaVault: { alice: { username: 'alice', passwordHash: 'abc' } },
    }

    const before = await launch()
    await saveCredential('alice', 'downstream-pass')

    expect(before.status).toBe(404)
    expect(rows[0]?.attributeMapping).not.toHaveProperty('_swaVault')
  })

  it('keeps each member separate and never replays another member credential', async () => {
    await saveCredential('alice', 'alice-pass')
    mockReadSessionForTenant.mockResolvedValue(session('user-2'))
    await saveCredential('bob', 'bob-pass')

    const bobLaunch = await (await launch()).text()

    expect(bobLaunch).toContain('value="bob"')
    expect(bobLaunch).not.toContain('alice')
  })

  it('rejects an envelope copied into another member slot', async () => {
    await saveCredential('alice', 'alice-pass')
    const credentials = rows[0]!.attributeMapping['_swaCredentials'] as Record<string, unknown>
    credentials['user-2'] = credentials['user-1']
    mockReadSessionForTenant.mockResolvedValue(session('user-2'))

    const res = await launch()

    expect(res.status).toBe(500)
  })

  it('deletes only the caller credential', async () => {
    await saveCredential('alice', 'alice-pass')
    mockReadSessionForTenant.mockResolvedValue(session('user-2'))
    await saveCredential('bob', 'bob-pass')

    const res = await buildApp().request('/sso/swa/conn-swa/vault', { method: 'DELETE' }, env)

    expect(res.status).toBe(204)
    expect(Object.keys(rows[0]!.attributeMapping['_swaCredentials'] as object)).toEqual(['user-1'])
  })

  it('retries when another write lands between read and update, keeping both entries', async () => {
    await saveCredential('alice', 'alice-pass')
    mockReadSessionForTenant.mockResolvedValue(session('user-2'))
    beforeUpdate = () => {
      rows[0]!.updatedAt = new Date(rows[0]!.updatedAt.getTime() + 5)
    }

    const res = await saveCredential('bob', 'bob-pass')

    expect(res.status).toBe(200)
    expect(Object.keys(rows[0]!.attributeMapping['_swaCredentials'] as object).sort()).toEqual([
      'user-1',
      'user-2',
    ])
  })

  it.each([
    ['an empty username', { username: ' ', password: 'x' }],
    ['a missing password', { username: 'alice' }],
  ])('rejects %s with validation_failed', async (_label, body) => {
    const res = await buildApp().request(
      '/sso/swa/conn-swa/vault',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env,
    )

    expect(res.status).toBe(422)
  })
})
