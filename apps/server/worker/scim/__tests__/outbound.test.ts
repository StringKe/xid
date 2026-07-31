// Outbound SCIM sync 门控测试:POST /scim/outbound/:targetId/sync 全量推送(含 deactivation 写下游)
// 只允许 org admin/owner membership 或 org_manager assignment;普通 member -> 403。
// node 池无 Workers binding,用最小 D1 fake(字符串参数全命中行内某列才算匹配,同 v1 isolation 风格)。

import { afterEach, describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { OrganizationMembershipRole, TenantContext } from '@xid-kit/types'
import type { SessionData, XidHonoEnv } from '../../lib/types'
import { isAppError } from '../../lib/errors'
import { executeScimTargetSync, registerOutboundScimRoutes } from '../outbound'

const TENANT: TenantContext = {
  tenantId: 't_1',
  issuer: 'https://acme.xid.dev',
  rpId: 'acme.xid.dev',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

function asUnknown<T>(v: unknown): T {
  return v as T
}

type TableSet = Record<string, Record<string, unknown>[]>

function tableNameForSql(sql: string): string {
  const l = sql.toLowerCase()
  if (l.includes('scim_targets')) return 'scim_targets'
  if (l.includes('scim_target_resources')) return 'scim_target_resources'
  if (l.includes('manager_assignments')) return 'manager_assignments'
  if (l.includes('memberships')) return 'memberships'
  if (l.includes('organizations')) return 'organizations'
  if (l.includes('user_emails')) return 'user_emails'
  if (l.includes('users')) return 'users'
  return 'unknown'
}

// SELECT 投影列(行对象 -> 位置数组;drizzle d1 走 raw() 按位置映射,顺序必须与查询字段一致)。
function projectionColumns(sql: string): string[] {
  const ret = /returning\s+(.+)$/i.exec(sql)
  const head = ret ? ret[1] : /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
  if (!head) return []
  return [...head.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '')
}

// 最小 D1 fake:SELECT 按表名取行,字符串绑定参数全部命中行内某列值才算匹配(模拟 WHERE 收窄)。
function makeFakeD1(
  tables: TableSet,
  runLog?: Array<{ sql: string; params: unknown[] }>,
): D1Database {
  const match = (sql: string, params: unknown[]): Record<string, unknown>[] => {
    const rows = tables[tableNameForSql(sql)] ?? []
    const sp = params.filter((v): v is string => typeof v === 'string')
    const notDeleted = /"status"\s*(?:<>|!=)\s*\?/i.test(sql)
    const equalityParams = notDeleted ? sp.filter((value) => value !== 'deleted') : sp
    if (sp.length === 0) return rows
    return rows.filter(
      (r) =>
        (!notDeleted || r['status'] !== 'deleted') &&
        equalityParams.every((v) => Object.values(r).includes(v)),
    )
  }
  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const stmt = {
      __sql: sql,
      __params: () => [...bound],
      bind: (...p: unknown[]) => {
        bound = p
        return stmt
      },
      all: async () => {
        runLog?.push({ sql, params: [...bound] })
        return { results: match(sql, bound), success: true, meta: {} }
      },
      run: async () => {
        runLog?.push({ sql, params: [...bound] })
        return { results: [], success: true, meta: {} }
      },
      first: async () => match(sql, bound)[0] ?? null,
      raw: async () => {
        runLog?.push({ sql, params: [...bound] })
        return match(sql, bound).map((r) => projectionColumns(sql).map((col) => r[col] ?? null))
      },
    }
    return stmt
  }
  return asUnknown<D1Database>({
    prepare,
    batch: async (statements: Array<{ __sql?: string; __params?: () => unknown[] }>) => {
      for (const statement of statements) {
        if (statement.__sql && statement.__params) {
          runLog?.push({ sql: statement.__sql, params: statement.__params() })
        }
      }
      return statements.map(() => ({ results: [], success: true, meta: {} }))
    },
  })
}

function makeSession(userId: string): SessionData {
  return {
    sessionId: `sess_${userId}`,
    userId,
    status: 'active',
    activeOrgId: 'org_1',
    authenticatedAt: new Date(),
    lastActiveAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    rememberMe: false,
    isImpersonation: false,
    impersonatorUserId: null,
    acr: null,
    amr: null,
    aal: null,
  }
}

function buildApp(session: SessionData | null): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError((err, c) => {
    if (isAppError(err)) return c.json({ code: err.code }, err.httpStatus as 400)
    return c.json({ code: 'server_error' }, 500)
  })
  app.use('*', async (c: Context<XidHonoEnv>, next) => {
    c.set('tenant', TENANT)
    c.set('session', session)
    await next()
  })
  registerOutboundScimRoutes(app)
  return app
}

function targetRow(
  options: { tokenSecretRef?: string; userFilter?: string } = {},
): Record<string, unknown> {
  return {
    id: 'st_1',
    tenant_id: 't_1',
    org_id: 'org_1',
    provider: 'okta',
    base_url: 'https://downstream.example.com/scim',
    token_secret_ref: options.tokenSecretRef ?? 'MISSING_SCIM_SECRET',
    user_filter: options.userFilter ?? '{}',
    status: 'active',
  }
}

// organizations 的 public/private_metadata 是 text-json 列,drizzle 映射时 JSON.parse,缺省 undefined 会炸。
function orgRow(): Record<string, unknown> {
  return {
    id: 'org_1',
    tenant_id: 't_1',
    status: 'active',
    public_metadata: '{}',
    private_metadata: '{}',
  }
}

function membershipRow(role: OrganizationMembershipRole): Record<string, unknown> {
  return {
    id: 'mem_1',
    tenant_id: 't_1',
    org_id: 'org_1',
    user_id: 'user_1',
    role,
    status: 'active',
  }
}

function userRow(userId: string, emailId: string, status = 'active'): Record<string, unknown> {
  return {
    id: userId,
    tenant_id: 't_1',
    primary_email_id: emailId,
    status,
    deleted_at: null,
  }
}

function userEmailRow(emailId: string, userId: string, email: string): Record<string, unknown> {
  return {
    id: emailId,
    tenant_id: 't_1',
    user_id: userId,
    email,
    verified: 1,
    verification_status: 'verified',
    is_primary: 1,
  }
}

function verifiedUserTables(): TableSet {
  return {
    users: [userRow('user_1', 'email_1')],
    user_emails: [userEmailRow('email_1', 'user_1', 'manager@example.test')],
  }
}

function makeEnv(
  tables: TableSet,
  extra: Record<string, unknown> = {},
  runLog?: Array<{ sql: string; params: unknown[] }>,
): Env {
  return asUnknown<Env>({ DB: makeFakeD1(tables, runLog), ...extra })
}

function postSync(app: Hono<XidHonoEnv>, env: Env): Promise<Response> {
  return app.request('https://acme.xid.dev/scim/outbound/st_1/sync', { method: 'POST' }, env)
}

describe('outbound SCIM sync 门控', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('无 session -> 401', async () => {
    const env = makeEnv({ scim_targets: [targetRow()] })
    const res = await postSync(buildApp(null), env)
    expect(res.status).toBe(401)
  })

  it('普通 member 触发全量推送 -> 403 forbidden', async () => {
    const env = makeEnv({
      scim_targets: [targetRow()],
      organizations: [orgRow()],
      memberships: [membershipRow('member')],
      manager_assignments: [],
    })
    const res = await postSync(buildApp(makeSession('user_1')), env)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('forbidden')
  })

  it('org admin 通过门控(进入同步流程,缺下游 token secret -> 422 而非 403)', async () => {
    const env = makeEnv({
      ...verifiedUserTables(),
      scim_targets: [targetRow()],
      organizations: [orgRow()],
      memberships: [membershipRow('admin')],
      manager_assignments: [],
    })
    const res = await postSync(buildApp(makeSession('user_1')), env)
    expect(res.status).toBe(422)
  })

  it('org_manager assignment(无 membership)通过门控 -> 422 而非 403', async () => {
    const env = makeEnv({
      ...verifiedUserTables(),
      scim_targets: [targetRow()],
      organizations: [orgRow()],
      memberships: [],
      manager_assignments: [
        {
          id: 'ma_1',
          tenant_id: 't_1',
          user_id: 'user_1',
          manager_role: 'org_manager',
          scope_type: 'org',
          scope_id: 'org_1',
        },
      ],
    })
    const res = await postSync(buildApp(makeSession('user_1')), env)
    expect(res.status).toBe(422)
  })

  it.each([
    ['default gate', '{}'],
    [
      'restricted gate',
      JSON.stringify({
        _xidAssignmentGate: {
          mode: 'restricted',
          allowed_user_ids: ['user_1', 'user_2'],
          allowed_roles: [],
        },
      }),
    ],
  ])('%s 只把目标 org Membership 用户写入下游 payload', async (_label, userFilter) => {
    const payloads: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'GET') {
          return new Response(
            JSON.stringify({
              schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
              totalResults: 0,
              Resources: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/scim+json' } },
          )
        }
        if (typeof init?.body === 'string')
          payloads.push(JSON.parse(init.body) as Record<string, unknown>)
        const payload = payloads.at(-1)
        const suffix =
          payload?.schemas?.[0] === 'urn:ietf:params:scim:schemas:core:2.0:User'
            ? String(payload.externalId)
            : String(payload?.externalId).replace(':', '_')
        return new Response(JSON.stringify({ id: `downstream_${suffix}` }), {
          status: 201,
          headers: { 'Content-Type': 'application/scim+json' },
        })
      }),
    )
    const env = makeEnv(
      {
        users: [userRow('user_1', 'email_1'), userRow('user_2', 'email_2')],
        user_emails: [
          userEmailRow('email_1', 'user_1', 'manager@example.test'),
          userEmailRow('email_2', 'user_2', 'other-org@example.test'),
        ],
        scim_targets: [
          targetRow({
            tokenSecretRef: 'SCIM_TARGET_TOKEN_st_1',
            userFilter,
          }),
        ],
        organizations: [orgRow()],
        memberships: [
          membershipRow('admin'),
          {
            id: 'mem_2',
            tenant_id: 't_1',
            org_id: 'org_2',
            user_id: 'user_2',
            role: 'member',
            status: 'active',
          },
        ],
        manager_assignments: [],
      },
      { SCIM_TARGET_TOKEN_st_1: 'secret' },
    )

    const result = await executeScimTargetSync({
      env,
      tenant: TENANT,
      target: {
        id: 'st_1',
        tenantId: 't_1',
        orgId: 'org_1',
        provider: 'okta',
        baseUrl: 'https://downstream.example.com/scim',
        tokenSecretRef: 'SCIM_TARGET_TOKEN_st_1',
        userFilter: JSON.parse(userFilter) as Record<string, unknown>,
        status: 'active',
        lastSyncAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })
    expect(result).toMatchObject({ users: 1, groups: 1 })

    const userPayloads = payloads.filter(
      (payload) => payload.schemas?.[0] === 'urn:ietf:params:scim:schemas:core:2.0:User',
    )
    expect(userPayloads.map((payload) => payload.externalId)).toEqual(['user_1'])
    expect(JSON.stringify(payloads)).not.toContain('user_2')
    const group = payloads.find(
      (payload) => payload.schemas?.[0] === 'urn:ietf:params:scim:schemas:core:2.0:Group',
    )
    expect(group?.members).toEqual([{ value: 'downstream_user_1', display: 'user_1' }])
  })

  it('授权触发只入队并返回 202,请求链路不调用下游 SaaS', async () => {
    const queueSend = vi.fn().mockResolvedValue(undefined)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const env = makeEnv(
      {
        ...verifiedUserTables(),
        scim_targets: [targetRow({ tokenSecretRef: 'SCIM_TARGET_TOKEN_st_1' })],
        organizations: [orgRow()],
        memberships: [membershipRow('admin')],
        manager_assignments: [],
      },
      {
        SCIM_TARGET_TOKEN_st_1: 'secret',
        SCIM_QUEUE: { send: queueSend },
        AUDIT_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
      },
    )

    const res = await postSync(buildApp(makeSession('user_1')), env)
    expect(res.status).toBe(202)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ targetId: 'st_1', status: 'queued' })
    expect(body.runId).toEqual(expect.any(String))
    expect(queueSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't_1',
        orgId: 'org_1',
        targetId: 'st_1',
        issuer: 'https://acme.xid.dev',
        actorId: 'user_1',
        runId: body.runId,
      }),
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('mapped User 用 PUT 幂等更新,本轮完整 upsert 后才 PATCH 旧 mapping active=false', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          body:
            typeof init?.body === 'string'
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : undefined,
        })
        if (init?.method === 'GET') {
          return new Response(
            JSON.stringify({
              schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
              totalResults: 0,
              Resources: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/scim+json' } },
          )
        }
        return new Response(JSON.stringify({ id: 'ignored' }), {
          status: 200,
          headers: { 'Content-Type': 'application/scim+json' },
        })
      }),
    )
    const env = makeEnv(
      {
        users: [userRow('user_1', 'email_1')],
        user_emails: [userEmailRow('email_1', 'user_1', 'manager@example.test')],
        memberships: [membershipRow('admin')],
        scim_target_resources: [
          {
            id: 'map_user_1',
            tenant_id: 't_1',
            org_id: 'org_1',
            target_id: 'st_1',
            resource_type: 'User',
            local_resource_id: 'user_1',
            external_id: 'user_1',
            downstream_id: 'down_user_1',
            status: 'active',
            last_synced_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
          },
          {
            id: 'map_user_2',
            tenant_id: 't_1',
            org_id: 'org_1',
            target_id: 'st_1',
            resource_type: 'User',
            local_resource_id: 'user_2',
            external_id: 'user_2',
            downstream_id: 'down_user_2',
            status: 'active',
            last_synced_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      },
      { SCIM_TARGET_TOKEN_st_1: 'secret' },
    )

    const result = await executeScimTargetSync({
      env,
      tenant: TENANT,
      target: {
        id: 'st_1',
        tenantId: 't_1',
        orgId: 'org_1',
        provider: 'okta',
        baseUrl: 'https://downstream.example.com/scim',
        tokenSecretRef: 'SCIM_TARGET_TOKEN_st_1',
        userFilter: {},
        status: 'active',
        lastSyncAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/Users'))).toBe(false)
    expect(calls[0]).toMatchObject({
      url: 'https://downstream.example.com/scim/Users/down_user_1',
      method: 'PUT',
    })
    expect(calls.at(-1)).toMatchObject({
      url: 'https://downstream.example.com/scim/Users/down_user_2',
      method: 'PATCH',
      body: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      },
    })
    expect(result.deactivations).toBe(1)
  })

  it('mapping 写入前中断后的 retry 先按 externalId discovery,不重复 POST', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const created = new Map<string, string>()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        calls.push({ url, method })
        const type = url.includes('/Users') ? 'User' : 'Group'
        if (method === 'GET') {
          const id = created.get(type)
          return new Response(
            JSON.stringify({
              schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
              totalResults: id ? 1 : 0,
              Resources: id ? [{ id }] : [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/scim+json' } },
          )
        }
        if (method === 'POST') {
          const id = type === 'User' ? 'down_user_1' : 'down_group_admin'
          created.set(type, id)
          return new Response(JSON.stringify({ id }), {
            status: 201,
            headers: { 'Content-Type': 'application/scim+json' },
          })
        }
        return new Response(null, { status: 204 })
      }),
    )
    const env = makeEnv(
      {
        users: [userRow('user_1', 'email_1')],
        user_emails: [userEmailRow('email_1', 'user_1', 'manager@example.test')],
        memberships: [membershipRow('admin')],
        scim_target_resources: [],
      },
      { SCIM_TARGET_TOKEN_st_1: 'secret' },
    )
    const target = {
      id: 'st_1',
      tenantId: 't_1',
      orgId: 'org_1',
      provider: 'okta',
      baseUrl: 'https://downstream.example.com/scim',
      tokenSecretRef: 'SCIM_TARGET_TOKEN_st_1',
      userFilter: {},
      status: 'active',
      lastSyncAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as const

    await executeScimTargetSync({ env, tenant: TENANT, target })
    await executeScimTargetSync({ env, tenant: TENANT, target })

    expect(
      calls.filter((call) => call.method === 'POST' && call.url.endsWith('/Users')),
    ).toHaveLength(1)
    expect(
      calls.filter((call) => call.method === 'POST' && call.url.endsWith('/Groups')),
    ).toHaveLength(1)
    expect(calls).toContainEqual({
      url: 'https://downstream.example.com/scim/Users/down_user_1',
      method: 'PUT',
    })
    expect(calls).toContainEqual({
      url: 'https://downstream.example.com/scim/Groups/down_group_admin',
      method: 'PUT',
    })
  })

  it('POST 409 后 discovery 到既有 User -> PUT 完整 desired body 后才持久化 mapping', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    const runLog: Array<{ sql: string; params: unknown[] }> = []
    let userDiscoveryCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        calls.push({
          url,
          method,
          body:
            typeof init?.body === 'string'
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : undefined,
        })
        if (method === 'GET' && url.includes('/Users?filter=')) {
          userDiscoveryCount += 1
          const id = userDiscoveryCount === 1 ? undefined : 'down_user_1'
          return new Response(
            JSON.stringify({
              schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
              totalResults: id ? 1 : 0,
              Resources: id ? [{ id }] : [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/scim+json' } },
          )
        }
        if (method === 'POST' && url.endsWith('/Users')) {
          return new Response(null, { status: 409 })
        }
        if (method === 'PUT' && url.endsWith('/Users/down_user_1')) {
          return new Response(null, { status: 204 })
        }
        if (method === 'GET' && url.includes('/Groups?filter=')) {
          return new Response(
            JSON.stringify({
              schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
              totalResults: 0,
              Resources: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/scim+json' } },
          )
        }
        if (method === 'POST' && url.endsWith('/Groups')) {
          return new Response(JSON.stringify({ id: 'down_group_admin' }), {
            status: 201,
            headers: { 'Content-Type': 'application/scim+json' },
          })
        }
        throw new Error(`unexpected SCIM request: ${method} ${url}`)
      }),
    )
    const env = makeEnv(
      {
        users: [userRow('user_1', 'email_1')],
        user_emails: [userEmailRow('email_1', 'user_1', 'manager@example.test')],
        memberships: [membershipRow('admin')],
        scim_target_resources: [],
      },
      { SCIM_TARGET_TOKEN_st_1: 'secret' },
      runLog,
    )

    const result = await executeScimTargetSync({
      env,
      tenant: TENANT,
      target: {
        id: 'st_1',
        tenantId: 't_1',
        orgId: 'org_1',
        provider: 'okta',
        baseUrl: 'https://downstream.example.com/scim',
        tokenSecretRef: 'SCIM_TARGET_TOKEN_st_1',
        userFilter: {},
        status: 'active',
        lastSyncAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    const userCalls = calls.filter((call) => call.url.includes('/Users'))
    expect(userCalls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET', 'PUT'])
    expect(userCalls.at(-1)).toEqual({
      url: 'https://downstream.example.com/scim/Users/down_user_1',
      method: 'PUT',
      body: {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        externalId: 'user_1',
        userName: 'manager@example.test',
        active: true,
        name: { givenName: '', familyName: '', formatted: '' },
        emails: [{ value: 'manager@example.test', primary: true }],
      },
    })
    expect(
      runLog.filter(
        (entry) =>
          /^insert into "scim_target_resources"/i.test(entry.sql) &&
          entry.params.includes('down_user_1'),
      ),
    ).toHaveLength(1)
    expect(result).toMatchObject({ users: 1, groups: 1 })
  })

  it.each([
    { putStatus: 404, expectedStatusCode: 502 },
    { putStatus: 503, expectedStatusCode: 503 },
  ])(
    'POST 409 后 discovery 到既有 User,PUT $putStatus 失败 -> 不持久化 mapping',
    async ({ putStatus, expectedStatusCode }) => {
      const calls: Array<{ url: string; method: string }> = []
      const runLog: Array<{ sql: string; params: unknown[] }> = []
      let userDiscoveryCount = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          const method = init?.method ?? 'GET'
          calls.push({ url, method })
          if (method === 'GET' && url.includes('/Users?filter=')) {
            userDiscoveryCount += 1
            const id = userDiscoveryCount === 1 ? undefined : 'down_user_1'
            return new Response(
              JSON.stringify({
                schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
                totalResults: id ? 1 : 0,
                Resources: id ? [{ id }] : [],
              }),
              { status: 200, headers: { 'Content-Type': 'application/scim+json' } },
            )
          }
          if (method === 'POST' && url.endsWith('/Users')) {
            return new Response(null, { status: 409 })
          }
          if (method === 'PUT' && url.endsWith('/Users/down_user_1')) {
            return new Response(null, { status: putStatus })
          }
          if (method === 'GET' && url.includes('/Groups?filter=')) {
            return new Response(
              JSON.stringify({
                schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
                totalResults: 0,
                Resources: [],
              }),
              { status: 200, headers: { 'Content-Type': 'application/scim+json' } },
            )
          }
          if (method === 'POST' && url.endsWith('/Groups')) {
            return new Response(JSON.stringify({ id: 'down_group_admin' }), {
              status: 201,
              headers: { 'Content-Type': 'application/scim+json' },
            })
          }
          throw new Error(`unexpected SCIM request: ${method} ${url}`)
        }),
      )
      const env = makeEnv(
        {
          users: [userRow('user_1', 'email_1')],
          user_emails: [userEmailRow('email_1', 'user_1', 'manager@example.test')],
          memberships: [membershipRow('admin')],
          scim_target_resources: [],
        },
        { SCIM_TARGET_TOKEN_st_1: 'secret' },
        runLog,
      )

      await expect(
        executeScimTargetSync({
          env,
          tenant: TENANT,
          target: {
            id: 'st_1',
            tenantId: 't_1',
            orgId: 'org_1',
            provider: 'okta',
            baseUrl: 'https://downstream.example.com/scim',
            tokenSecretRef: 'SCIM_TARGET_TOKEN_st_1',
            userFilter: {},
            status: 'active',
            lastSyncAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        }),
      ).rejects.toMatchObject({ statusCode: expectedStatusCode, retryable: true })
      expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET', 'PUT'])
      expect(calls.some((call) => call.url.includes('/Groups'))).toBe(false)
      expect(
        runLog.filter((entry) =>
          /^(?:insert into|update) "scim_target_resources"/i.test(entry.sql),
        ),
      ).toHaveLength(0)
    },
  )

  it('当前资源 upsert 失败时不进入旧 mapping deprovision 阶段', async () => {
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' })
        return new Response('', { status: 503 })
      }),
    )
    const env = makeEnv(
      {
        users: [userRow('user_1', 'email_1')],
        user_emails: [userEmailRow('email_1', 'user_1', 'manager@example.test')],
        memberships: [membershipRow('admin')],
        scim_target_resources: [
          {
            id: 'map_user_2',
            tenant_id: 't_1',
            org_id: 'org_1',
            target_id: 'st_1',
            resource_type: 'User',
            local_resource_id: 'user_2',
            external_id: 'user_2',
            downstream_id: 'down_user_2',
            status: 'active',
            last_synced_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      },
      { SCIM_TARGET_TOKEN_st_1: 'secret' },
    )

    await expect(
      executeScimTargetSync({
        env,
        tenant: TENANT,
        target: {
          id: 'st_1',
          tenantId: 't_1',
          orgId: 'org_1',
          provider: 'okta',
          baseUrl: 'https://downstream.example.com/scim',
          tokenSecretRef: 'SCIM_TARGET_TOKEN_st_1',
          userFilter: {},
          status: 'active',
          lastSyncAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    ).rejects.toMatchObject({ statusCode: 503, retryable: true })
    expect(calls.some((call) => call.url.endsWith('/Users/down_user_2'))).toBe(false)
  })

  it('旧 mapping 的下游资源已是 404 -> 视为完成并把本地 mapping 标记 deprovisioned', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const runLog: Array<{ sql: string; params: unknown[] }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' })
        return new Response(null, { status: 404 })
      }),
    )
    const env = makeEnv(
      {
        users: [],
        user_emails: [],
        memberships: [],
        scim_target_resources: [
          {
            id: 'map_user_stale',
            tenant_id: 't_1',
            org_id: 'org_1',
            target_id: 'st_1',
            resource_type: 'User',
            local_resource_id: 'user_stale',
            external_id: 'user_stale',
            downstream_id: 'down_user_stale',
            status: 'active',
            last_synced_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
          },
          {
            id: 'map_group_stale',
            tenant_id: 't_1',
            org_id: 'org_1',
            target_id: 'st_1',
            resource_type: 'Group',
            local_resource_id: 'role:member',
            external_id: 'role:member',
            downstream_id: 'down_group_stale',
            status: 'active',
            last_synced_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      },
      { SCIM_TARGET_TOKEN_st_1: 'secret' },
      runLog,
    )

    const result = await executeScimTargetSync({
      env,
      tenant: TENANT,
      target: {
        id: 'st_1',
        tenantId: 't_1',
        orgId: 'org_1',
        provider: 'okta',
        baseUrl: 'https://downstream.example.com/scim',
        tokenSecretRef: 'SCIM_TARGET_TOKEN_st_1',
        userFilter: {},
        status: 'active',
        lastSyncAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    expect(result).toMatchObject({ users: 0, groups: 0, deactivations: 1 })
    expect(calls).toEqual([
      {
        url: 'https://downstream.example.com/scim/Users/down_user_stale',
        method: 'PATCH',
      },
      {
        url: 'https://downstream.example.com/scim/Groups/down_group_stale',
        method: 'PUT',
      },
    ])
    const mappingUpdates = runLog.filter((entry) => entry.params.includes('deprovisioned'))
    expect(mappingUpdates).toHaveLength(2)
    expect(mappingUpdates.map((entry) => entry.params.at(-1))).toEqual([
      'map_user_stale',
      'map_group_stale',
    ])
  })
})
