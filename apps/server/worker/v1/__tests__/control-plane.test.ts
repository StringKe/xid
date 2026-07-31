import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { sha256Hex } from '@xid-kit/crypto'
import {
  TENANT_MANAGER_ROLES,
  TENANT_MANAGER_ROLE_SCOPE_CONTRACT,
  TENANT_MANAGER_SCOPE_TYPES,
  type TenantContext,
} from '@xid-kit/types'
import type { SessionData, XidHonoEnv } from '../../lib/types'
import { isAppError } from '../../lib/errors'
import { registerProjects } from '../projects'
import { registerRolePermissions } from '../role-permissions'
import { registerManagerAssignments } from '../manager-assignments'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

type Row = Record<string, unknown>
type Store = Record<string, Row[]>

const TENANT: TenantContext = {
  tenantId: 't_1',
  issuer: 'https://acme.xid.dev',
  rpId: 'acme.xid.dev',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

function asUnknown<T>(value: unknown): T {
  return value as T
}

function tableName(sql: string): string {
  return /(?:from|into|update|delete\s+from)\s+"?([a-z_]+)"?/i.exec(sql)?.[1] ?? 'unknown'
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

function insertColumns(sql: string): string[] {
  const match = /insert\s+into\s+"?[a-z_]+"?\s*\(([^)]*)\)/i.exec(sql)
  return match?.[1] ? [...match[1].matchAll(/"?([a-z_]+)"?/g)].map((item) => item[1]!) : []
}

function insertTokens(sql: string): string[] {
  const match = /values\s*\(([\s\S]*?)\)\s*(?:returning|$)/i.exec(sql)
  return match?.[1]?.split(',').map((token) => token.trim()) ?? []
}

function updateColumns(sql: string): string[] {
  const match = /^update\s+"?[a-z_]+"?\s+set\s+(.+?)\s+where\s/i.exec(sql)
  return match?.[1] ? [...match[1].matchAll(/"?([a-z_]+)"?\s*=/g)].map((item) => item[1]!) : []
}

function rawValue(value: unknown): unknown {
  if (Array.isArray(value)) return JSON.stringify(value)
  if (value && typeof value === 'object' && !(value instanceof Date)) return JSON.stringify(value)
  return value ?? null
}

function defaultsFor(table: string): Row {
  const now = Date.now()
  if (table === 'projects') {
    return { status: 'active', deleted_at: null, created_at: now, updated_at: now }
  }
  if (table === 'manager_assignments') return { created_at: now, updated_at: now }
  if (table === 'role_permissions') return { created_at: now }
  return {}
}

function makeD1(store: Store): D1Database {
  const rows = (name: string) => (store[name] ??= [])

  const selectRows = (sql: string, params: unknown[], skip = 0): Row[] => {
    let candidates = rows(tableName(sql))
    const strings = params.slice(skip).filter((value): value is string => typeof value === 'string')
    const excluded: string[] = []
    for (const match of sql.matchAll(/"([a-z_]+)"\s*<>\s*\?/gi)) {
      const column = match[1]!
      const value = strings.find((item) => ['instance_manager', 'deleted'].includes(item))
      if (value) {
        candidates = candidates.filter((row) => row[column] !== value)
        excluded.push(value)
      }
    }
    if (/"deleted_at"\s+is\s+null/i.test(sql)) {
      candidates = candidates.filter((row) => row['deleted_at'] == null)
    }
    if (/"scope_id"\s+is\s+null/i.test(sql)) {
      candidates = candidates.filter((row) => row['scope_id'] == null)
    }
    const required = strings.filter((value) => !excluded.includes(value))
    return candidates.filter((row) => required.every((value) => Object.values(row).includes(value)))
  }

  const insert = (sql: string, params: unknown[]): Row[] => {
    const name = tableName(sql)
    const columns = insertColumns(sql)
    const tokens = insertTokens(sql)
    const row: Row = { ...defaultsFor(name) }
    let param = 0
    columns.forEach((column, index) => {
      const token = tokens[index]
      if (token === '?') row[column] = params[param++] ?? null
      else if (token === undefined || token.toLowerCase() === 'null') row[column] = null
      else row[column] = token.replace(/^'|'$/g, '')
    })
    rows(name).push(row)
    return [row]
  }

  const update = (sql: string, params: unknown[]): Row[] => {
    const columns = updateColumns(sql)
    const matched = selectRows(sql, params, columns.length)
    for (const row of matched) {
      columns.forEach((column, index) => {
        row[column] = params[index]
      })
      row['updated_at'] = Date.now()
    }
    return matched
  }

  const hardDelete = (sql: string, params: unknown[]): Row[] => {
    const name = tableName(sql)
    const matched = new Set(selectRows(sql, params))
    store[name] = rows(name).filter((row) => !matched.has(row))
    return []
  }

  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const execute = (): Row[] => {
      const lower = sql.trim().toLowerCase()
      if (lower.startsWith('insert')) return insert(sql, bound)
      if (lower.startsWith('update')) return update(sql, bound)
      if (lower.startsWith('delete')) return hardDelete(sql, bound)
      return selectRows(sql, bound)
    }
    const statement = {
      bind: (...params: unknown[]) => {
        bound = params
        return statement
      },
      raw: async () => {
        const result = execute()
        if (/select\s+count\(\*\)/i.test(sql)) return [[result.length]]
        return result.map((row) => projectionColumns(sql).map((column) => rawValue(row[column])))
      },
      all: async () => ({ results: execute(), success: true, meta: {} }),
      first: async () => execute()[0] ?? null,
      run: async () => ({ results: execute(), success: true, meta: {} }),
    }
    return statement
  }
  return asUnknown<D1Database>({ prepare, batch: async () => [] })
}

async function apiKey(tenantId = 't_1') {
  const token = 'sk_live_control_plane'
  return {
    token,
    row: {
      id: 'ak_control',
      tenant_id: tenantId,
      key_hash: await sha256Hex(token),
      scopes: ['*'],
      revoked_at: null,
      expires_at: null,
      created_at: Date.now(),
    },
  }
}

function project(id: string, tenantId: string, orgId: string): Row {
  return {
    id,
    tenant_id: tenantId,
    org_id: orgId,
    name: id,
    description: null,
    status: 'active',
    deleted_at: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

function organization(id: string, tenantId: string): Row {
  return {
    id,
    tenant_id: tenantId,
    instance_id: 'inst_1',
    parent_org_id: id === tenantId ? null : tenantId,
    slug: id,
    name: id,
    public_metadata: {},
    private_metadata: {},
    status: 'active',
    deleted_at: null,
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
    password_change_required: false,
    is_new_user: false,
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

function buildApp(register: (app: Hono<XidHonoEnv>) => void, session: SessionData | null = null) {
  const app = new Hono<XidHonoEnv>()
  app.onError((error, c) => {
    if (isAppError(error)) return c.json({ code: error.code }, error.httpStatus as 400)
    return c.json({ code: 'server_error' }, 500)
  })
  app.use('*', async (c, next) => {
    c.set('tenant', TENANT)
    c.set('session', session)
    await next()
  })
  register(app)
  return app
}

describe('Project control plane', () => {
  it('API key CRUD is tenant-scoped and delete is reversible', async () => {
    const key = await apiKey()
    const store: Store = {
      api_keys: [key.row],
      organizations: [organization('t_1', 't_1')],
      projects: [project('proj_foreign', 't_2', 't_2')],
    }
    const app = buildApp(registerProjects)
    const env = asUnknown<Env>({ DB: makeD1(store) })
    const headers = {
      Authorization: `Bearer ${key.token}`,
      'content-type': 'application/json',
    }

    const foreign = await app.request(
      'https://acme.xid.dev/v1/projects/proj_foreign',
      { headers },
      env,
    )
    expect(foreign.status).toBe(404)

    const created = await app.request(
      'https://acme.xid.dev/v1/projects',
      { method: 'POST', headers, body: JSON.stringify({ org_id: 't_1', name: 'Control' }) },
      env,
    )
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as { id: string }
    const removed = await app.request(
      `https://acme.xid.dev/v1/projects/${createdBody.id}`,
      { method: 'DELETE', headers },
      env,
    )
    expect(removed.status).toBe(204)
    expect(store.projects?.find((row) => row['id'] === createdBody.id)?.['status']).toBe('deleted')

    const deletedList = await app.request(
      'https://acme.xid.dev/v1/projects?org_id=t_1&status=deleted',
      { headers },
      env,
    )
    expect(deletedList.status).toBe(200)
    expect(
      ((await deletedList.json()) as { data: Array<{ id: string }> }).data.map((row) => row.id),
    ).toEqual([createdBody.id])
    const allList = await app.request(
      'https://acme.xid.dev/v1/projects?org_id=t_1&status=all',
      { headers },
      env,
    )
    expect(allList.status).toBe(200)
    expect(
      ((await allList.json()) as { data: Array<{ id: string }> }).data.map((row) => row.id),
    ).toContain(createdBody.id)

    const restore = await app.request(
      `https://acme.xid.dev/v1/projects/${createdBody.id}/restore`,
      { method: 'POST', headers },
      env,
    )
    expect(restore.status).toBe(200)
    expect(store.projects?.find((row) => row['id'] === createdBody.id)?.['status']).toBe('active')
  })

  it('exact project_manager can mutate only its assigned active Project', async () => {
    const session = asUnknown<SessionData>({ userId: 'user_manager' })
    const store: Store = {
      projects: [project('proj_allowed', 't_1', 't_1'), project('proj_denied', 't_1', 't_1')],
      manager_assignments: [
        {
          id: 'mgr_1',
          tenant_id: 't_1',
          user_id: 'user_manager',
          manager_role: 'project_manager',
          scope_type: 'project',
          scope_id: 'proj_allowed',
        },
      ],
      memberships: [],
    }
    const app = buildApp(registerProjects, session)
    const env = asUnknown<Env>({ DB: makeD1(store) })
    const headers = { 'content-type': 'application/json' }
    const allowed = await app.request(
      'https://acme.xid.dev/v1/projects/proj_allowed',
      { method: 'PATCH', headers, body: JSON.stringify({ name: 'Allowed' }) },
      env,
    )
    expect(allowed.status).toBe(200)
    const denied = await app.request(
      'https://acme.xid.dev/v1/projects/proj_denied',
      { method: 'PATCH', headers, body: JSON.stringify({ name: 'Denied' }) },
      env,
    )
    expect(denied.status).toBe(403)
  })

  it('project_grant_manager can discover only the exact active Grant Project', async () => {
    const session = asUnknown<SessionData>({ userId: 'user_grant_manager' })
    const store: Store = {
      projects: [
        project('proj_allowed', 't_1', 'org_owner'),
        project('proj_other', 't_1', 'org_other'),
      ],
      project_grants: [
        {
          id: 'grant_active',
          tenant_id: 't_1',
          granted_project_id: 'proj_allowed',
          granted_by_org_id: 'org_owner',
          granted_to_org_id: 'org_recipient',
          status: 'active',
        },
        {
          id: 'grant_foreign',
          tenant_id: 't_1',
          granted_project_id: 'proj_other',
          granted_by_org_id: 'org_other',
          granted_to_org_id: 'org_recipient',
          status: 'active',
        },
        {
          id: 'grant_revoked',
          tenant_id: 't_1',
          granted_project_id: 'proj_allowed',
          granted_by_org_id: 'org_owner',
          granted_to_org_id: 'org_recipient',
          status: 'revoked',
        },
      ],
      manager_assignments: [
        {
          id: 'mgr_grant',
          tenant_id: 't_1',
          user_id: 'user_grant_manager',
          manager_role: 'project_grant_manager',
          scope_type: 'grant',
          scope_id: 'grant_active',
        },
      ],
      memberships: [],
    }
    const app = buildApp(registerProjects, session)
    const env = asUnknown<Env>({ DB: makeD1(store) })

    const allowed = await app.request(
      'https://acme.xid.dev/v1/projects?project_id=proj_allowed&grant_id=grant_active',
      undefined,
      env,
    )
    expect(allowed.status).toBe(200)
    expect(((await allowed.json()) as { data: Array<{ id: string }> }).data).toEqual([
      expect.objectContaining({ id: 'proj_allowed' }),
    ])

    const foreign = await app.request(
      'https://acme.xid.dev/v1/projects?project_id=proj_allowed&grant_id=grant_foreign',
      undefined,
      env,
    )
    expect(foreign.status).toBe(404)

    const revoked = await app.request(
      'https://acme.xid.dev/v1/projects?project_id=proj_allowed&grant_id=grant_revoked',
      undefined,
      env,
    )
    expect(revoked.status).toBe(404)
  })
})

describe('RolePermission control plane', () => {
  it('rejects malformed ABAC and cross-Project or cross-Tenant mappings', async () => {
    const key = await apiKey()
    const store: Store = {
      api_keys: [key.row],
      projects: [project('proj_1', 't_1', 't_1')],
      roles: [
        { id: 'role_1', tenant_id: 't_1', project_id: 'proj_1', status: 'active' },
        { id: 'role_foreign', tenant_id: 't_2', project_id: 'proj_foreign', status: 'active' },
      ],
      permissions: [
        { id: 'perm_1', tenant_id: 't_1', project_id: 'proj_1', status: 'active' },
        { id: 'perm_2', tenant_id: 't_1', project_id: 'proj_2', status: 'active' },
      ],
      role_permissions: [],
    }
    const app = buildApp(registerRolePermissions)
    const auditSend = vi.fn(async () => undefined)
    const env = asUnknown<Env>({
      DB: makeD1(store),
      AUDIT_QUEUE: { send: auditSend },
    })
    const headers = {
      Authorization: `Bearer ${key.token}`,
      'content-type': 'application/json',
    }
    const request = (body: unknown) =>
      app.request(
        'https://acme.xid.dev/v1/role-permissions',
        { method: 'POST', headers, body: JSON.stringify(body) },
        env,
      )
    expect(
      (
        await request({
          role_id: 'role_1',
          permission_id: 'perm_1',
          condition_expression: { op: 'gt', var: 'org.id', value: 1 },
        })
      ).status,
    ).toBe(422)
    expect((await request({ role_id: 'role_1', permission_id: 'perm_2' })).status).toBe(404)
    expect((await request({ role_id: 'role_foreign', permission_id: 'perm_1' })).status).toBe(404)

    const created = await request({
      role_id: 'role_1',
      permission_id: 'perm_1',
      condition_expression: { op: 'eq', var: 'org.id', value: 't_1' },
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as { id: string }
    const patched = await app.request(
      `https://acme.xid.dev/v1/role-permissions/${body.id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ condition_expression: null }),
      },
      env,
    )
    expect(patched.status).toBe(200)
    const listed = await app.request(
      'https://acme.xid.dev/v1/role-permissions?role_id=role_1',
      { headers },
      env,
    )
    expect(listed.status).toBe(200)
    expect(
      ((await listed.json()) as { data: Array<{ id: string }> }).data.map((row) => row.id),
    ).toEqual([body.id])
    const removed = await app.request(
      `https://acme.xid.dev/v1/role-permissions/${body.id}`,
      { method: 'DELETE', headers },
      env,
    )
    expect(removed.status).toBe(204)
    expect(store.role_permissions).toHaveLength(0)
    expect(auditSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'management.role_permission.deleted',
        payload: {
          targetType: 'role_permission',
          targetId: body.id,
          roleId: 'role_1',
          permissionId: 'perm_1',
        },
      }),
    )
  })
})

describe('tenant ManagerAssignment control plane', () => {
  it('enforces role-scope pairs and current-tenant targets', async () => {
    const key = await apiKey()
    const store: Store = {
      api_keys: [key.row],
      users: [activeUser('user_target', 't_1'), activeUser('user_foreign', 't_2')],
      organizations: [organization('t_1', 't_1')],
      projects: [project('proj_1', 't_1', 't_1')],
      manager_assignments: [],
    }
    const app = buildApp(registerManagerAssignments)
    const auditSend = vi.fn(async () => undefined)
    const env = asUnknown<Env>({
      DB: makeD1(store),
      AUDIT_QUEUE: { send: auditSend },
    })
    const headers = {
      Authorization: `Bearer ${key.token}`,
      'content-type': 'application/json',
    }
    const request = (body: unknown) =>
      app.request(
        'https://acme.xid.dev/v1/manager-assignments',
        { method: 'POST', headers, body: JSON.stringify(body) },
        env,
      )
    for (const managerRole of TENANT_MANAGER_ROLES) {
      for (const scopeType of TENANT_MANAGER_SCOPE_TYPES) {
        const matchesContract = TENANT_MANAGER_ROLE_SCOPE_CONTRACT.some(
          (contract) => contract.managerRole === managerRole && contract.scopeType === scopeType,
        )
        if (matchesContract) continue
        expect(
          (
            await request({
              user_id: 'user_target',
              manager_role: managerRole,
              scope_type: scopeType,
              scope_id: 'unused_for_invalid_pair',
            })
          ).status,
        ).toBe(422)
      }
    }
    expect(
      (
        await request({
          user_id: 'user_foreign',
          manager_role: 'project_manager',
          scope_type: 'project',
          scope_id: 'proj_1',
        })
      ).status,
    ).toBe(404)
    const created = await request({
      user_id: 'user_target',
      manager_role: 'project_manager',
      scope_type: 'project',
      scope_id: 'proj_1',
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as { id: string }
    expect(store.manager_assignments?.[0]?.['tenant_id']).toBe('t_1')
    const listed = await app.request(
      'https://acme.xid.dev/v1/manager-assignments?scope_type=project&scope_id=proj_1',
      { headers },
      env,
    )
    expect(listed.status).toBe(200)
    expect(
      ((await listed.json()) as { data: Array<{ id: string }> }).data.map((row) => row.id),
    ).toEqual([body.id])
    const removed = await app.request(
      `https://acme.xid.dev/v1/manager-assignments/${body.id}`,
      { method: 'DELETE', headers },
      env,
    )
    expect(removed.status).toBe(204)
    expect(store.manager_assignments).toHaveLength(0)
    expect(auditSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'management.manager_assignment.revoked',
        payload: {
          targetType: 'manager_assignment',
          targetId: body.id,
          targetUserId: 'user_target',
          managerRole: 'project_manager',
          scopeType: 'project',
          scopeId: 'proj_1',
        },
      }),
    )
  })

  it('accepts every role-scope pair from the shared tenant manager contract', async () => {
    const key = await apiKey()
    const store: Store = {
      api_keys: [key.row],
      users: [activeUser('user_target', 't_1')],
      organizations: [organization('t_1', 't_1')],
      projects: [project('proj_1', 't_1', 't_1')],
      project_grants: [
        {
          id: 'grant_1',
          tenant_id: 't_1',
          granted_project_id: 'proj_1',
          granted_by_org_id: 't_1',
          granted_to_org_id: 't_1',
          status: 'active',
        },
      ],
      manager_assignments: [],
    }
    const app = buildApp(registerManagerAssignments)
    const env = asUnknown<Env>({
      DB: makeD1(store),
      AUDIT_QUEUE: { send: vi.fn(async () => undefined) },
    })
    const scopeIds = {
      org: 't_1',
      project: 'proj_1',
      grant: 'grant_1',
    } as const

    for (const contract of TENANT_MANAGER_ROLE_SCOPE_CONTRACT) {
      const response = await app.request(
        'https://acme.xid.dev/v1/manager-assignments',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            user_id: 'user_target',
            manager_role: contract.managerRole,
            scope_type: contract.scopeType,
            scope_id: scopeIds[contract.scopeType],
          }),
        },
        env,
      )
      expect(response.status).toBe(201)
    }

    expect(
      store.manager_assignments?.map((row) => ({
        managerRole: row['manager_role'],
        scopeType: row['scope_type'],
      })),
    ).toEqual(TENANT_MANAGER_ROLE_SCOPE_CONTRACT)
  })

  it('session principals cannot assign themselves', async () => {
    const session = asUnknown<SessionData>({ userId: 'user_admin' })
    const store: Store = {
      users: [activeUser('user_admin', 't_1')],
      organizations: [organization('t_1', 't_1')],
      memberships: [
        {
          id: 'mem_1',
          tenant_id: 't_1',
          org_id: 't_1',
          user_id: 'user_admin',
          role: 'owner',
          status: 'active',
        },
      ],
      manager_assignments: [],
    }
    const app = buildApp(registerManagerAssignments, session)
    const env = asUnknown<Env>({ DB: makeD1(store) })
    const response = await app.request(
      'https://acme.xid.dev/v1/manager-assignments',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          user_id: 'user_admin',
          manager_role: 'org_manager',
          scope_type: 'org',
          scope_id: 't_1',
        }),
      },
      env,
    )
    expect(response.status).toBe(403)
  })
})
