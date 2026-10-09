// SWA password vaulting: member-owned downstream credentials in swa_credentials, the launch form
// and the account portal listing, including cross-tenant isolation.

import { Hono } from 'hono'
import type { ErrorHandler } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError, isAppError } from '../../lib/errors'
import type { SessionData, XidHonoEnv } from '../../lib/types'
import { registerSwaRoutes } from '../swa'

type Predicate = { eq: [string, unknown] } | { and: Predicate[] } | { inArray: [string, unknown[]] }
type Row = Record<string, unknown> & { tenantId: string }

const tables: Record<string, Row[]> = {}

function matches(row: Row, predicate: Predicate | undefined): boolean {
  if (!predicate) return true
  if ('and' in predicate) return predicate.and.every((part) => matches(row, part))
  if ('inArray' in predicate) return predicate.inArray[1].includes(row[predicate.inArray[0]])
  return row[predicate.eq[0]] === predicate.eq[1]
}

vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: unknown) => ({ eq: [column, value] }),
  and: (...parts: Predicate[]) => ({ and: parts }),
  inArray: (column: string, values: unknown[]) => ({ inArray: [column, values] }),
}))

vi.mock('@xid-kit/db', () => {
  const columns = (names: string[]) => Object.fromEntries(names.map((name) => [name, name]))
  return {
    createTenantDb: (_db: unknown, tenant: { tenantId: string }) => {
      const scoped = (name: string) =>
        (tables[name] ?? []).filter((row) => row.tenantId === tenant.tenantId)
      const accessor = (name: string) => ({
        findOne: async (where?: Predicate) => scoped(name).find((row) => matches(row, where)),
        findMany: async (where?: Predicate) => scoped(name).filter((row) => matches(row, where)),
        hardDelete: async (where?: Predicate) => {
          tables[name] = (tables[name] ?? []).filter(
            (row) => row.tenantId !== tenant.tenantId || !matches(row, where),
          )
        },
      })
      return {
        ssoConnections: accessor('ssoConnections'),
        swaCredentials: accessor('swaCredentials'),
        memberships: accessor('memberships'),
        organizations: accessor('organizations'),
      }
    },
    resolveTenantContextBySsoConnection: vi.fn(),
    schema: {
      ssoConnections: columns(['id', 'orgId', 'protocol', 'status']),
      swaCredentials: columns(['connectionId', 'userId']),
      memberships: columns(['userId', 'status']),
      organizations: columns(['id']),
    },
  }
})

const mockReadSessionForTenant = vi.fn()
const mockRequireSession = vi.fn()
const mockFindActiveMembership = vi.fn()

vi.mock('../../lib/session', () => ({
  issueSession: vi.fn(),
  readSessionForTenant: (...args: unknown[]) => mockReadSessionForTenant(...args),
}))
vi.mock('../../me/shared', () => ({
  findActiveMembership: (...args: unknown[]) => mockFindActiveMembership(...args),
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}))

const upsertBinds: unknown[][] = []

// Applies the UPSERT the way D1 would, keyed by (tenant_id, connection_id, user_id).
const fakeD1 = {
  prepare: (sql: string) => ({
    bind: (...args: unknown[]) => ({
      run: async () => {
        expect(sql).toContain('ON CONFLICT (tenant_id, connection_id, user_id) DO UPDATE')
        upsertBinds.push(args)
        const [id, tenantId, orgId, connectionId, userId, iv, ciphertext, tag, kekVersion, now] =
          args as [string, string, string, string, string, string, string, string, number, number]
        const rows = (tables['swaCredentials'] ??= [])
        const values = {
          orgId,
          secretIv: iv,
          secretCiphertext: ciphertext,
          secretTag: tag,
          kekVersion,
          updatedAt: new Date(now),
        }
        const existing = rows.find(
          (row) =>
            row.tenantId === tenantId && row.connectionId === connectionId && row.userId === userId,
        )
        if (existing) Object.assign(existing, values)
        else rows.push({ id, tenantId, connectionId, userId, ...values })
        return { success: true }
      },
    }),
  }),
}

const env = {
  DB: fakeD1,
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

function swaConnection(overrides: Partial<Row> = {}): Row {
  return {
    id: 'conn-swa',
    tenantId: 'tenant-1',
    orgId: 'org-1',
    protocol: 'swa',
    status: 'active',
    displayName: 'Acme Portal',
    idpSsoUrl: null,
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

function buildApp(tenantId = 'tenant-1'): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', {
      tenantId,
      issuer: `https://${tenantId}.xid.dev`,
      rpId: `${tenantId}.xid.dev`,
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
    for (const key of Object.keys(tables)) delete tables[key]
    upsertBinds.length = 0
    vi.clearAllMocks()
    tables['ssoConnections'] = [swaConnection()]
    mockReadSessionForTenant.mockResolvedValue(session('user-1'))
    mockRequireSession.mockResolvedValue(session('user-1'))
    mockFindActiveMembership.mockResolvedValue({ id: 'm-1', status: 'active' })
  })

  it('rejects a request without an XID session before validating the body', async () => {
    mockReadSessionForTenant.mockResolvedValue(null)

    const res = await saveCredential('', '')

    expect(res.status).toBe(401)
    expect(upsertBinds).toHaveLength(0)
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
    expect(upsertBinds).toHaveLength(0)
  })

  it('returns 404 for a connection that belongs to another tenant', async () => {
    tables['ssoConnections'] = [swaConnection({ tenantId: 'tenant-2' })]

    const saved = await saveCredential('alice', 'downstream-pass')
    const launched = await launch()

    expect(saved.status).toBe(404)
    expect(launched.status).toBe(404)
    expect(upsertBinds).toHaveLength(0)
  })

  it('binds tenant_id from TenantContext in the upsert and stores no plaintext', async () => {
    const saved = await saveCredential('alice', 'downstream-pass')
    const status = await buildApp().request('/sso/swa/conn-swa/vault', {}, env)

    expect(saved.status).toBe(200)
    expect(upsertBinds[0]?.slice(1, 5)).toEqual(['tenant-1', 'org-1', 'conn-swa', 'user-1'])
    expect(JSON.stringify(tables['swaCredentials'])).not.toContain('downstream-pass')
    expect(await status.json()).toEqual({ stored: true, username: 'alice' })
  })

  it('overwrites the existing row when the member saves again', async () => {
    await saveCredential('alice', 'first-pass')
    await saveCredential('alice2', 'second-pass')

    const html = await (await launch()).text()

    expect(tables['swaCredentials']).toHaveLength(1)
    expect(html).toContain('value="alice2"')
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

  it('ignores retired vault data left in attribute_mapping', async () => {
    tables['ssoConnections'] = [
      swaConnection({
        attributeMapping: {
          _legacy: { swaTargetUrl: TARGET },
          _swaVault: { alice: { username: 'alice', passwordHash: 'abc' } },
          _swaCredentials: { 'user-1': { iv: 'a', ciphertext: 'b', tag: 'c', kekVersion: 1 } },
        },
      }),
    ]

    const res = await launch()

    expect(res.status).toBe(404)
  })

  it('never replays a credential row stored under another tenant', async () => {
    await saveCredential('alice', 'alice-pass')
    for (const row of tables['swaCredentials'] ?? []) row.tenantId = 'tenant-2'

    const res = await launch()

    expect(res.status).toBe(404)
  })

  it('rejects an envelope copied into another member row', async () => {
    await saveCredential('alice', 'alice-pass')
    const original = tables['swaCredentials']![0]!
    tables['swaCredentials']!.push({ ...original, id: 'copy', userId: 'user-2' })
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
    expect(tables['swaCredentials']?.map((row) => row.userId)).toEqual(['user-1'])
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

describe('SWA member app list', () => {
  beforeEach(() => {
    for (const key of Object.keys(tables)) delete tables[key]
    vi.clearAllMocks()
    mockReadSessionForTenant.mockResolvedValue(session('user-1'))
    mockRequireSession.mockResolvedValue(session('user-1'))
    mockFindActiveMembership.mockResolvedValue({ id: 'm-1', status: 'active' })
    tables['memberships'] = [
      { tenantId: 'tenant-1', userId: 'user-1', orgId: 'org-1', status: 'active' },
      { tenantId: 'tenant-1', userId: 'user-1', orgId: 'org-3', status: 'suspended' },
    ]
    tables['organizations'] = [
      { tenantId: 'tenant-1', id: 'org-1', name: 'Acme' },
      { tenantId: 'tenant-1', id: 'org-2', name: 'Other' },
    ]
    tables['ssoConnections'] = [
      swaConnection(),
      swaConnection({ id: 'conn-other-org', orgId: 'org-2' }),
      swaConnection({ id: 'conn-suspended-member', orgId: 'org-3' }),
      swaConnection({ id: 'conn-inactive', status: 'inactive' }),
      swaConnection({ id: 'conn-saml', protocol: 'saml' }),
      swaConnection({
        id: 'conn-placeholder',
        attributeMapping: { _legacy: { swaTargetUrl: 'https://app.example.com/login' } },
      }),
      swaConnection({ id: 'conn-other-tenant', tenantId: 'tenant-2' }),
    ]
  })

  it('lists only active SWA connections of the caller organizations with saved state', async () => {
    await saveCredential('alice', 'alice-pass')

    const res = await buildApp().request('/sso/swa/apps', {}, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: [
        {
          id: 'conn-swa',
          orgId: 'org-1',
          organizationName: 'Acme',
          name: 'Acme Portal',
          targetOrigin: 'https://portal.acme-corp.net',
          stored: true,
          username: 'alice',
        },
      ],
    })
  })

  it('does not report a credential saved in another tenant', async () => {
    await saveCredential('alice', 'alice-pass')
    for (const row of tables['swaCredentials'] ?? []) row.tenantId = 'tenant-2'

    const res = await buildApp().request('/sso/swa/apps', {}, env)
    const body = (await res.json()) as { data: Array<{ stored: boolean }> }

    expect(body.data.map((app) => app.stored)).toEqual([false])
  })

  it('requires an XID session', async () => {
    mockRequireSession.mockRejectedValue(new AppError('unauthorized', { httpStatus: 401 }))

    const res = await buildApp().request('/sso/swa/apps', {}, env)

    expect(res.status).toBe(401)
  })
})
