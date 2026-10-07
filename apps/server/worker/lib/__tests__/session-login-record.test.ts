// issueSession / recordSessionActivated 记录最后登录时间与按 IP 估算的位置。
// 用户列表的「最后登录」与账户 Devices 页的位置都读这两列。

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { TenantContext } from '@xid-kit/types'
import { describe, expect, it } from 'vitest'
import { issueSession, recordSessionActivated } from '../session'
import type { SessionData, XidHonoEnv } from '../types'

const TENANT: TenantContext = {
  tenantId: 't_1',
  issuer: 'https://acme.example.test',
  rpId: 'acme.example.test',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

type Statement = { sql: string; params: unknown[] }

function sessionRow(status: string, isImpersonation: boolean): Record<string, unknown> {
  const now = Date.now()
  return {
    id: 's_1',
    tenant_id: 't_1',
    user_id: 'u_1',
    refresh_token_hash: 'hash',
    active_org_id: null,
    device_fingerprint_hash: null,
    device_name: null,
    user_agent: null,
    ip: null,
    location: null,
    status,
    remember_me: 0,
    is_impersonation: isImpersonation ? 1 : 0,
    impersonator_user_id: isImpersonation ? 'u_admin' : null,
    authenticated_at: now,
    last_active_at: now,
    expires_at: now + 3_600_000,
    created_at: now,
  }
}

function projection(sql: string): string[] {
  const ret = /returning\s+(.+)$/i.exec(sql)
  const head = ret ? ret[1] : /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
  return head ? [...head.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '') : []
}

function makeDb(session: Record<string, unknown>, statements: Statement[]): D1Database {
  const user = { id: 'u_1', tenant_id: 't_1', status: 'active', deleted_at: null }
  const prepare = (sql: string) => {
    let params: unknown[] = []
    const rowFor = (): Record<string, unknown> | null => {
      const lower = sql.toLowerCase()
      if (lower.startsWith('insert into "sessions"')) return session
      if (lower.startsWith('select') && lower.includes('from "users"')) return user
      return null
    }
    const stmt = {
      bind: (...values: unknown[]) => {
        params = values
        return stmt
      },
      raw: async () => {
        statements.push({ sql, params })
        const row = rowFor()
        return row ? [projection(sql).map((column) => row[column] ?? null)] : []
      },
      all: async () => ({ results: [], success: true, meta: {} }),
      run: async () => {
        statements.push({ sql, params })
        return { results: [], success: true, meta: {} }
      },
    }
    return stmt
  }
  return { prepare, batch: async () => [] } as unknown as D1Database
}

function sessionNs(): DurableObjectNamespace {
  const stub = {
    fetch: async (url: string) => {
      const action = new URL(url).pathname.slice(1)
      if (action === 'generation') return Response.json({ generation: 0 })
      if (action === 'add') return Response.json({ ok: true, value: { accepted: true } })
      return Response.json({ ok: true, value: undefined })
    },
  }
  return {
    idFromName: (name: string) => name,
    get: () => stub,
  } as unknown as DurableObjectNamespace
}

async function run(
  env: Env,
  handler: (c: Context<XidHonoEnv>) => Promise<void> | void,
  cf?: Record<string, string>,
): Promise<void> {
  const app = new Hono<XidHonoEnv>()
  app.get('/', async (c) => {
    c.set('tenant', TENANT)
    await handler(c)
    return c.json({ ok: true })
  })
  const request = new Request('https://acme.example.test/')
  if (cf) Object.defineProperty(request, 'cf', { value: cf })
  await app.request(request, undefined, env)
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function lastLoginUpdates(statements: Statement[]): Statement[] {
  return statements.filter(
    (statement) =>
      statement.sql.toLowerCase().startsWith('update "users"') &&
      statement.sql.includes('"last_login_at"'),
  )
}

function insertParams(statements: Statement[]): unknown[] {
  return (
    statements.find((s) => s.sql.toLowerCase().startsWith('insert into "sessions"'))?.params ?? []
  )
}

const issueInput = {
  sessionId: 's_1',
  userId: 'u_1',
  activeOrgId: null,
  authenticatedAt: new Date(),
}

describe('issueSession sign-in record', () => {
  it('records last_login_at and the estimated location for an active session', async () => {
    const statements: Statement[] = []
    const env = {
      DB: makeDb(sessionRow('active', false), statements),
      SESSION_REVOCATION: sessionNs(),
    } as unknown as Env

    await run(env, async (c) => void (await issueSession(c, issueInput)), {
      city: 'Lisbon',
      country: 'PT',
    })

    expect(insertParams(statements)).toContain('Lisbon, PT')
    expect(lastLoginUpdates(statements)).toHaveLength(1)
  })

  it('stores a null location when the request carries no Cloudflare metadata', async () => {
    const statements: Statement[] = []
    const env = {
      DB: makeDb(sessionRow('active', false), statements),
      SESSION_REVOCATION: sessionNs(),
    } as unknown as Env

    await run(env, async (c) => void (await issueSession(c, issueInput)))

    expect(insertParams(statements)).not.toContain('Lisbon, PT')
    expect(lastLoginUpdates(statements)).toHaveLength(1)
  })

  it('does not record a sign-in while MFA is still pending', async () => {
    const statements: Statement[] = []
    const env = {
      DB: makeDb(sessionRow('pending_mfa', false), statements),
      SESSION_REVOCATION: sessionNs(),
    } as unknown as Env

    await run(
      env,
      async (c) => void (await issueSession(c, { ...issueInput, status: 'pending_mfa' })),
    )

    expect(lastLoginUpdates(statements)).toHaveLength(0)
  })

  it('does not record an impersonation session as the user signing in', async () => {
    const statements: Statement[] = []
    const env = {
      DB: makeDb(sessionRow('active', true), statements),
      SESSION_REVOCATION: sessionNs(),
    } as unknown as Env

    await run(
      env,
      async (c) =>
        void (await issueSession(c, {
          ...issueInput,
          isImpersonation: true,
          impersonatorUserId: 'u_admin',
        })),
    )

    expect(lastLoginUpdates(statements)).toHaveLength(0)
  })

  it('records the sign-in when a pending MFA session becomes active', async () => {
    const statements: Statement[] = []
    const env = {
      DB: makeDb(sessionRow('active', false), statements),
      SESSION_REVOCATION: sessionNs(),
      METERING_QUEUE: { send: async () => undefined },
    } as unknown as Env
    const pending = { userId: 'u_1', status: 'pending_mfa', isImpersonation: false }

    await run(env, (c) => recordSessionActivated(c, pending as SessionData))

    expect(lastLoginUpdates(statements)).toHaveLength(1)
  })
})
