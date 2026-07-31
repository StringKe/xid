import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { SessionData, XidHonoEnv } from '../../lib/types'
import { isAppError } from '../../lib/errors'
import { registerPlatformManagerAssignmentRoutes } from '../manager-assignments'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

type Row = Record<string, unknown>
type Store = Record<string, Row[]>

function asUnknown<T>(value: unknown): T {
  return value as T
}

function tableName(sql: string): string {
  return /(?:from|into|delete\s+from)\s+"?([a-z_]+)"?/i.exec(sql)?.[1] ?? 'unknown'
}

function projectionColumns(sql: string): string[] {
  const returned = /returning\s+(.+)$/i.exec(sql)
  const selected = /^select\s+(.+?)\s+from\s/i.exec(sql)
  const head = returned?.[1] ?? selected?.[1]
  if (!head) return []
  return head.split(',').map((part) => {
    const columns = [...part.matchAll(/"([a-z_]+)"/g)]
    return columns.at(-1)?.[1] ?? ''
  })
}

type FakeStatement = D1PreparedStatement & {
  __sql: string
  __execute: () => Row[]
}

function makeD1(store: Store, batchSql: string[][] = []): D1Database {
  const rows = (name: string) => (store[name] ??= [])
  const match = (sql: string, params: unknown[]) => {
    let values = rows(tableName(sql))
    if (/"scope_id"\s+is\s+null/i.test(sql)) {
      values = values.filter((row) => row['scope_id'] == null)
    }
    const required = params.filter((value): value is string => typeof value === 'string')
    return values.filter((row) => required.every((value) => Object.values(row).includes(value)))
  }
  const insert = (sql: string, params: unknown[]) => {
    if (tableName(sql) === 'platform_audit_outbox') {
      const conditionParams = params.slice(9)
      if (/not\s+exists/i.test(sql)) {
        const [tenantId, userId] = conditionParams
        const exists = rows('manager_assignments').some(
          (row) =>
            row['tenant_id'] === tenantId &&
            row['user_id'] === userId &&
            row['manager_role'] === 'instance_manager' &&
            row['scope_type'] === 'instance' &&
            row['scope_id'] == null,
        )
        if (exists) return []
      } else if (/where\s+exists/i.test(sql)) {
        const [id, actorUserId] = conditionParams
        const assignments = rows('manager_assignments').filter(
          (row) =>
            row['manager_role'] === 'instance_manager' &&
            row['scope_type'] === 'instance' &&
            row['scope_id'] == null,
        )
        const target = assignments.find((row) => row['id'] === id)
        if (!target || target['user_id'] === actorUserId || assignments.length <= 1) return []
      }
      const [id, tenantId, orgId, action, actorId, payload, availableAt, createdAt, updatedAt] =
        params
      const row: Row = {
        id,
        tenant_id: tenantId,
        org_id: orgId,
        action,
        actor_id: actorId,
        payload,
        status: 'pending',
        available_at: availableAt,
        attempt_count: 0,
        created_at: createdAt,
        updated_at: updatedAt,
      }
      rows('platform_audit_outbox').push(row)
      return [row]
    }
    if (tableName(sql) === 'manager_assignments' && /\bselect\b/i.test(sql)) {
      const [id, tenantId, userId, createdAt, updatedAt, auditId] = params
      if (!rows('platform_audit_outbox').some((row) => row['id'] === auditId)) return []
      const row: Row = {
        id,
        tenant_id: tenantId,
        user_id: userId,
        manager_role: 'instance_manager',
        scope_type: 'instance',
        scope_id: null,
        created_at: createdAt,
        updated_at: updatedAt,
      }
      rows('manager_assignments').push(row)
      return [row]
    }
    const names = [
      ...(/insert\s+into\s+"?[a-z_]+"?\s*\(([^)]*)\)/i.exec(sql)?.[1]?.matchAll(/"?([a-z_]+)"?/g) ??
        []),
    ].map((item) => item[1]!)
    const tokens =
      /values\s*\(([\s\S]*?)\)\s*(?:returning|$)/i
        .exec(sql)?.[1]
        ?.split(',')
        .map((token) => token.trim()) ?? []
    const row: Row = { created_at: Date.now(), updated_at: Date.now() }
    let parameter = 0
    names.forEach((name, index) => {
      const token = tokens[index]
      if (token === '?') row[name] = params[parameter++] ?? null
      else if (token === undefined || token.toLowerCase() === 'null') row[name] = null
      else row[name] = token.replace(/^'|'$/g, '')
    })
    rows(tableName(sql)).push(row)
    return [row]
  }
  const remove = (sql: string, params: unknown[]) => {
    const name = tableName(sql)
    if (name === 'manager_assignments' && /select\s+count\(\*\)/i.test(sql)) {
      const [id, actorUserId] = params
      const assignments = rows(name).filter(
        (row) =>
          row['manager_role'] === 'instance_manager' &&
          row['scope_type'] === 'instance' &&
          row['scope_id'] == null,
      )
      const target = assignments.find((row) => row['id'] === id)
      const auditId = params.at(-1)
      if (
        !target ||
        target['user_id'] === actorUserId ||
        assignments.length <= 1 ||
        !rows('platform_audit_outbox').some((row) => row['id'] === auditId)
      ) {
        return []
      }
      store[name] = rows(name).filter((row) => row !== target)
      return [{ id: target['id'] }]
    }
    const found = new Set(match(sql, params))
    store[name] = rows(name).filter((row) => !found.has(row))
    return []
  }
  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const execute = () => {
      const lower = sql.trim().toLowerCase()
      if (lower.startsWith('insert')) return insert(sql, bound)
      if (lower.startsWith('delete')) return remove(sql, bound)
      return match(sql, bound)
    }
    const statement = {
      bind: (...params: unknown[]) => {
        bound = params
        return statement
      },
      raw: async () => {
        const result = execute()
        if (/select\s+count\(\*\)/i.test(sql)) return [[result.length]]
        return result.map((row) =>
          projectionColumns(sql).map((column) => {
            const value = row[column]
            if (value instanceof Date) return value.getTime()
            if (Array.isArray(value)) return JSON.stringify(value)
            if (value && typeof value === 'object') return JSON.stringify(value)
            return value ?? null
          }),
        )
      },
      all: async () => ({ results: execute(), success: true, meta: {} }),
      first: async () => execute()[0] ?? null,
      run: async () => {
        const results = execute()
        return { results, success: true, meta: { changes: results.length } }
      },
      __sql: sql,
      __execute: execute,
    }
    return statement
  }
  return asUnknown<D1Database>({
    prepare,
    batch: async (statements: D1PreparedStatement[]) => {
      const fakeStatements = statements as FakeStatement[]
      batchSql.push(fakeStatements.map((statement) => statement.__sql))
      const snapshot = structuredClone(store)
      try {
        return fakeStatements.map((statement) => {
          const results = statement.__execute()
          return { results, success: true, meta: { changes: results.length } }
        })
      } catch (error) {
        for (const key of Object.keys(store)) delete store[key]
        Object.assign(store, snapshot)
        throw error
      }
    },
  })
}

function makeUniqueFailingD1(store: Store): D1Database {
  const base = makeD1(store)
  return asUnknown<D1Database>({
    prepare: (sql: string) => {
      if (!/^insert\s+into\s+"?manager_assignments"?/i.test(sql.trim())) {
        return base.prepare(sql)
      }
      const fail = async () => {
        throw new Error('UNIQUE constraint failed: manager_assignments.tenant_id')
      }
      const statement = {
        bind: () => statement,
        raw: fail,
        all: fail,
        first: fail,
        run: fail,
        __sql: sql,
        __execute: () => {
          throw new Error('UNIQUE constraint failed: manager_assignments.tenant_id')
        },
      }
      return statement
    },
    batch: async (statements: D1PreparedStatement[]) => {
      const snapshot = structuredClone(store)
      try {
        return (statements as FakeStatement[]).map((statement) => {
          const results = statement.__execute()
          return { results, success: true, meta: { changes: results.length } }
        })
      } catch (error) {
        for (const key of Object.keys(store)) delete store[key]
        Object.assign(store, snapshot)
        throw error
      }
    },
  })
}

function manager(id: string, userId: string, tenantId = 't_1'): Row {
  return {
    id,
    tenant_id: tenantId,
    user_id: userId,
    manager_role: 'instance_manager',
    scope_type: 'instance',
    scope_id: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

function activeUser(id: string, tenantId: string): Row {
  return {
    id,
    tenant_id: tenantId,
    status: 'active',
    deleted_at: null,
    public_metadata: {},
    private_metadata: {},
    unsafe_metadata: {},
    custom_attributes: {},
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

function appFor(session: SessionData) {
  const app = new Hono<XidHonoEnv>()
  app.onError((error, c) => {
    if (isAppError(error)) return c.json({ code: error.code }, error.httpStatus as 400)
    return c.json({ code: 'server_error' }, 500)
  })
  app.use('*', async (c, next) => {
    c.set('session', session)
    await next()
  })
  registerPlatformManagerAssignmentRoutes(app)
  return app
}

describe('platform ManagerAssignment control plane', () => {
  it('provisions and revokes instance_manager only on the isolated platform path', async () => {
    const session = asUnknown<SessionData>({ userId: 'user_current' })
    const store: Store = {
      users: [activeUser('user_current', 't_1'), activeUser('user_target', 't_2')],
      manager_assignments: [manager('mgr_current', 'user_current')],
    }
    const app = appFor(session)
    const batchSql: string[][] = []
    const auditSend = vi.fn(async () => undefined)
    const env = asUnknown<Env>({
      DB: makeD1(store, batchSql),
      AUDIT_QUEUE: { send: auditSend },
    })
    const created = await app.request(
      'https://xid.dev/v1/platform/manager-assignments',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: 'user_target' }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const body = (await created.json()) as { id: string; tenantId: string }
    expect(body.tenantId).toBe('t_2')
    expect(batchSql[0]).toEqual([
      expect.stringContaining('INSERT INTO platform_audit_outbox'),
      expect.stringContaining('INSERT INTO manager_assignments'),
    ])
    expect(store.platform_audit_outbox).toEqual([
      expect.objectContaining({ action: 'platform.instance_manager.granted' }),
    ])
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.instance_manager.granted',
        payload: expect.objectContaining({
          targetType: 'manager_assignment',
          targetId: body.id,
          userId: 'user_target',
        }),
      }),
    )
    const listed = await app.request(
      'https://xid.dev/v1/platform/manager-assignments',
      undefined,
      env,
    )
    expect(listed.status).toBe(200)
    expect(
      ((await listed.json()) as { data: Array<{ id: string }> }).data.map((row) => row.id),
    ).toEqual(['mgr_current', body.id])

    const removed = await app.request(
      `https://xid.dev/v1/platform/manager-assignments/${body.id}`,
      { method: 'DELETE' },
      env,
    )
    expect(removed.status).toBe(204)
    expect(store.manager_assignments).toEqual([expect.objectContaining({ id: 'mgr_current' })])
    expect(batchSql[1]).toEqual([
      expect.stringContaining('INSERT INTO platform_audit_outbox'),
      expect.stringContaining('DELETE FROM manager_assignments'),
    ])
    expect(store.platform_audit_outbox).toEqual([
      expect.objectContaining({ action: 'platform.instance_manager.granted' }),
      expect.objectContaining({ action: 'platform.instance_manager.revoked' }),
    ])
  })

  it('rejects self-provision and non-managers', async () => {
    const session = asUnknown<SessionData>({ userId: 'user_current' })
    const selfStore: Store = {
      users: [activeUser('user_current', 't_1')],
      manager_assignments: [manager('mgr_current', 'user_current')],
    }
    const selfResponse = await appFor(session).request(
      'https://xid.dev/v1/platform/manager-assignments',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: 'user_current' }),
      },
      asUnknown<Env>({ DB: makeD1(selfStore) }),
    )
    expect(selfResponse.status).toBe(403)

    const denied = await appFor(session).request(
      'https://xid.dev/v1/platform/manager-assignments',
      undefined,
      asUnknown<Env>({ DB: makeD1({ manager_assignments: [] }) }),
    )
    expect(denied.status).toBe(403)
  })

  it('maps a concurrent unique insert race to already_exists', async () => {
    const session = asUnknown<SessionData>({ userId: 'user_current' })
    const store: Store = {
      users: [activeUser('user_current', 't_1'), activeUser('user_target', 't_2')],
      manager_assignments: [manager('mgr_current', 'user_current')],
    }
    const response = await appFor(session).request(
      'https://xid.dev/v1/platform/manager-assignments',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: 'user_target' }),
      },
      asUnknown<Env>({ DB: makeUniqueFailingD1(store) }),
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: 'already_exists' })
  })

  it('atomically prevents two managers from concurrently removing each other', async () => {
    const store: Store = {
      users: [activeUser('user_a', 't_1'), activeUser('user_b', 't_2')],
      manager_assignments: [manager('mgr_a', 'user_a'), manager('mgr_b', 'user_b', 't_2')],
    }
    const env = asUnknown<Env>({
      DB: makeD1(store),
      AUDIT_QUEUE: { send: vi.fn(async () => undefined) },
    })
    const [removeB, removeA] = await Promise.all([
      appFor(asUnknown<SessionData>({ userId: 'user_a' })).request(
        'https://xid.dev/v1/platform/manager-assignments/mgr_b',
        { method: 'DELETE' },
        env,
      ),
      appFor(asUnknown<SessionData>({ userId: 'user_b' })).request(
        'https://xid.dev/v1/platform/manager-assignments/mgr_a',
        { method: 'DELETE' },
        env,
      ),
    ])
    expect([removeB.status, removeA.status].sort()).toEqual([204, 409])
    expect(store.manager_assignments).toHaveLength(1)
  })
})
