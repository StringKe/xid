// SCIM 列表 filter 下推与 keyset 扫描:真 SQLite 验证结果语义、索引命中、扫描次数与目录/租户隔离。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256Hex } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteD1 } from '../../../../../packages/db/src/__tests__/sqlite-d1'
import { buildTestTenant, makeEnv, makeFakeKv } from '../../oidc/__tests__/helpers'
import type { XidHonoEnv } from '../../lib/types'
import { registerScimRoutes } from '../index'

const migrationDir = fileURLToPath(new URL('../../../../../packages/db/drizzle/', import.meta.url))

const TOKEN_DIR_1 = 'scim_list_dir_1'
const TOKEN_DIR_2 = 'scim_list_dir_2'
const TOKEN_T2 = 'scim_list_t2'

type ListBody = {
  totalResults: number
  startIndex: number
  itemsPerPage: number
  Resources: Array<Record<string, unknown>>
}

type Harness = {
  d1: SqliteD1
  statements: string[]
  request: (path: string, options?: { token?: string; tenant?: TenantContext }) => Promise<Response>
  tenantT2: TenantContext
}

let harness: Harness

function applyMigrations(d1: SqliteD1): void {
  d1.database.exec('PRAGMA foreign_keys = OFF')
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    d1.database.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
}

async function insertDirectory(d1: SqliteD1, row: { id: string; tenantId: string; token: string }) {
  const now = Date.now()
  d1.database
    .prepare(
      `INSERT INTO directories (id, tenant_id, org_id, provider, scim_token_hash, sync_status, status, created_at, updated_at)
       VALUES (?, ?, ?, 'okta', ?, 'idle', 'active', ?, ?)`,
    )
    .run(row.id, row.tenantId, row.tenantId, await sha256Hex(row.token), now, now)
}

type UserSeed = {
  id: string
  tenantId?: string
  directoryId?: string
  userName: string
  externalId?: string | null
  title?: string
  status?: string
}

function insertUser(d1: SqliteD1, user: UserSeed): void {
  const now = Date.now()
  d1.database
    .prepare(
      `INSERT INTO directory_users (id, tenant_id, directory_id, user_name, external_id, scim_raw, active, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      user.id,
      user.tenantId ?? 't_1',
      user.directoryId ?? 'dir_1',
      user.userName,
      user.externalId ?? null,
      JSON.stringify({ userName: user.userName, title: user.title ?? 'Engineer' }),
      user.status ?? 'active',
      now,
      now,
    )
}

function insertGroup(
  d1: SqliteD1,
  group: { id: string; displayName: string; directoryId?: string },
) {
  const now = Date.now()
  d1.database
    .prepare(
      `INSERT INTO directory_groups (id, tenant_id, directory_id, display_name, status, created_at, updated_at)
       VALUES (?, 't_1', ?, ?, 'active', ?, ?)`,
    )
    .run(group.id, group.directoryId ?? 'dir_1', group.displayName, now, now)
}

function insertMember(d1: SqliteD1, groupId: string, userId: string): void {
  d1.database
    .prepare(
      `INSERT INTO directory_group_members (id, tenant_id, group_id, directory_user_id, created_at)
       VALUES (?, 't_1', ?, ?, ?)`,
    )
    .run(`m_${groupId}_${userId}`, groupId, userId, Date.now())
}

function pad(n: number): string {
  return String(n).padStart(3, '0')
}

function listQueries(statements: readonly string[], table: string): string[] {
  return statements.filter((sql) => /^select\s/i.test(sql) && sql.includes(`from "${table}"`))
}

function queryPlan(d1: SqliteD1, sql: string): string {
  const rows = d1.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>
  return rows.map((row) => row.detail).join('\n')
}

async function readList(res: Response): Promise<ListBody> {
  expect(res.status).toBe(200)
  return (await res.json()) as ListBody
}

beforeEach(async () => {
  const d1 = new SqliteD1()
  applyMigrations(d1)
  await insertDirectory(d1, { id: 'dir_1', tenantId: 't_1', token: TOKEN_DIR_1 })
  await insertDirectory(d1, { id: 'dir_2', tenantId: 't_1', token: TOKEN_DIR_2 })
  await insertDirectory(d1, { id: 'dir_t2', tenantId: 't_2', token: TOKEN_T2 })
  const statements: string[] = []
  const recordingDb = {
    prepare: (sql: string) => {
      statements.push(sql)
      return d1.prepare(sql)
    },
    batch: (stmts: D1PreparedStatement[]) => d1.batch(stmts),
  } as unknown as D1Database
  const { ctx } = await buildTestTenant()
  const tenantT2: TenantContext = { ...ctx, tenantId: 't_2' }
  const env = makeEnv({ DB: recordingDb, CACHE: makeFakeKv() })
  const request: Harness['request'] = (path, options = {}) => {
    const tenant = options.tenant ?? ctx
    const app = new Hono<XidHonoEnv>()
    app.use('*', async (c, next) => {
      c.set('tenant', tenant)
      c.set('session', null)
      await next()
    })
    registerScimRoutes(app)
    return Promise.resolve(
      app.request(
        `https://acme.xid.dev/scim/v2/organizations/${tenant.tenantId}${path}`,
        { method: 'GET', headers: { Authorization: `Bearer ${options.token ?? TOKEN_DIR_1}` } },
        env,
      ),
    )
  }
  harness = { d1, statements, request, tenantT2 }
})

afterEach(() => {
  harness.d1.close()
})

describe('SCIM Users filter 下推', () => {
  it('userName eq 大小写不敏感匹配且只发 count 与 find 两条 SQL', async () => {
    insertUser(harness.d1, { id: 'u_1', userName: 'bjensen@example.com', externalId: 'ext-1' })
    insertUser(harness.d1, { id: 'u_2', userName: 'alice@example.com', externalId: 'ext-2' })
    harness.statements.length = 0

    const body = await readList(
      await harness.request(
        '/Users?filter=' + encodeURIComponent('userName eq "BJensen@Example.com"'),
      ),
    )

    expect(body.totalResults).toBe(1)
    expect(body.Resources.map((r) => r['id'])).toEqual(['u_1'])
    const queries = listQueries(harness.statements, 'directory_users')
    expect(queries).toHaveLength(2)
    expect(queries.every((sql) => sql.includes('lower("directory_users"."user_name")'))).toBe(true)
  })

  it('externalId eq 按 caseExact 精确匹配并命中唯一索引', async () => {
    insertUser(harness.d1, { id: 'u_1', userName: 'bjensen@example.com', externalId: 'Ext-1' })
    harness.statements.length = 0

    const exact = await readList(
      await harness.request('/Users?filter=' + encodeURIComponent('externalId eq "Ext-1"')),
    )
    const findSql = listQueries(harness.statements, 'directory_users').find(
      (sql) => !/count\(\*\)/i.test(sql),
    )
    const wrongCase = await readList(
      await harness.request('/Users?filter=' + encodeURIComponent('externalId eq "ext-1"')),
    )

    expect(exact.totalResults).toBe(1)
    expect(wrongCase.totalResults).toBe(0)
    expect(queryPlan(harness.d1, findSql!)).toContain('directory_users_dir_external_unq')
  })

  it('id eq 下推到主键查询', async () => {
    insertUser(harness.d1, { id: 'u_1', userName: 'bjensen@example.com' })
    insertUser(harness.d1, { id: 'u_2', userName: 'alice@example.com' })

    const body = await readList(
      await harness.request('/Users?filter=' + encodeURIComponent('id eq "u_2"')),
    )

    expect(body.Resources.map((r) => r['id'])).toEqual(['u_2'])
  })

  it('or 组合的可下推条件与 JS 求值结果一致', async () => {
    insertUser(harness.d1, { id: 'u_1', userName: 'bjensen@example.com', externalId: 'ext-1' })
    insertUser(harness.d1, { id: 'u_2', userName: 'alice@example.com', externalId: 'ext-2' })
    insertUser(harness.d1, { id: 'u_3', userName: 'carol@example.com', externalId: null })

    const body = await readList(
      await harness.request(
        '/Users?filter=' +
          encodeURIComponent('userName eq "ALICE@example.com" or externalId eq "ext-1"'),
      ),
    )

    expect(body.totalResults).toBe(2)
    expect(body.Resources.map((r) => r['id'])).toEqual(['u_1', 'u_2'])
  })

  it('只返回当前 token 所属 directory 的用户,同租户其他 directory 与其他租户不可见', async () => {
    insertUser(harness.d1, { id: 'u_dir1', userName: 'shared@example.com' })
    insertUser(harness.d1, { id: 'u_dir2', directoryId: 'dir_2', userName: 'shared@example.com' })
    insertUser(harness.d1, {
      id: 'u_t2',
      tenantId: 't_2',
      directoryId: 'dir_t2',
      userName: 'shared@example.com',
    })
    const filter = '/Users?filter=' + encodeURIComponent('userName eq "shared@example.com"')

    const dir1 = await readList(await harness.request(filter))
    const dir2 = await readList(await harness.request(filter, { token: TOKEN_DIR_2 }))
    const crossTenant = await harness.request(filter, {
      token: TOKEN_DIR_1,
      tenant: harness.tenantT2,
    })

    expect(dir1.Resources.map((r) => r['id'])).toEqual(['u_dir1'])
    expect(dir2.Resources.map((r) => r['id'])).toEqual(['u_dir2'])
    expect(crossTenant.status).toBe(401)
  })

  it('已删除用户不参与 filter 结果', async () => {
    insertUser(harness.d1, { id: 'u_1', userName: 'gone@example.com', status: 'deleted' })

    const body = await readList(
      await harness.request(
        '/Users?filter=' + encodeURIComponent('userName eq "gone@example.com"'),
      ),
    )

    expect(body.totalResults).toBe(0)
  })
})

describe('SCIM Users 复杂 filter keyset 扫描', () => {
  beforeEach(() => {
    for (let i = 1; i <= 250; i++) {
      insertUser(harness.d1, {
        id: `u_${pad(i)}`,
        userName: `user${pad(i)}@example.com`,
        externalId: i % 3 === 0 ? null : `ext-${pad(251 - i)}`,
        title: i % 2 === 0 ? 'Manager' : 'Engineer',
      })
    }
  })

  it('每行只读一次且不使用 OFFSET,分页语义保持不变', async () => {
    harness.statements.length = 0

    const body = await readList(
      await harness.request(
        '/Users?startIndex=51&count=5&filter=' + encodeURIComponent('title eq "Manager"'),
      ),
    )

    expect(body.totalResults).toBe(125)
    expect(body.startIndex).toBe(51)
    expect(body.itemsPerPage).toBe(5)
    expect(body.Resources.map((r) => r['id'])).toEqual([
      'u_102',
      'u_104',
      'u_106',
      'u_108',
      'u_110',
    ])
    const queries = listQueries(harness.statements, 'directory_users')
    expect(queries).toHaveLength(3)
    expect(queries.some((sql) => /\boffset\b/i.test(sql))).toBe(false)
  })

  it('可下推的 and 分支先在 SQL 过滤,剩余条件在 JS 求值', async () => {
    harness.statements.length = 0

    const body = await readList(
      await harness.request(
        '/Users?filter=' +
          encodeURIComponent('userName eq "user010@example.com" and title eq "Manager"'),
      ),
    )

    expect(body.Resources.map((r) => r['id'])).toEqual(['u_010'])
    const queries = listQueries(harness.statements, 'directory_users')
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('lower("directory_users"."user_name")')
  })

  it('按可空列降序排序时 keyset 跨页不重不漏', async () => {
    const expected: string[] = []
    for (let i = 1; i <= 250; i++) {
      if (i % 2 === 0 && i % 3 !== 0) expected.push(`u_${pad(i)}`)
    }
    for (let i = 1; i <= 250; i++) {
      if (i % 2 === 0 && i % 3 === 0) expected.push(`u_${pad(i)}`)
    }

    const ids: string[] = []
    for (let start = 1; start <= expected.length; start += 40) {
      const page = await readList(
        await harness.request(
          `/Users?sortBy=externalId&sortOrder=descending&startIndex=${start}&count=40&filter=` +
            encodeURIComponent('title eq "Manager"'),
        ),
      )
      ids.push(...page.Resources.map((r) => String(r['id'])))
    }

    expect(ids).toEqual(expected)
  })

  it('按可空列升序排序时 NULL 排在最前', async () => {
    const body = await readList(
      await harness.request(
        '/Users?sortBy=externalId&count=3&filter=' +
          encodeURIComponent('not (title eq "Engineer")'),
      ),
    )

    expect(body.totalResults).toBe(125)
    expect(body.Resources.map((r) => r['id'])).toEqual(['u_006', 'u_012', 'u_018'])
  })
})

describe('SCIM Groups filter 下推与扫描', () => {
  beforeEach(() => {
    insertUser(harness.d1, { id: 'u_1', userName: 'member@example.com' })
    for (let i = 1; i <= 150; i++) {
      insertGroup(harness.d1, { id: `g_${pad(i)}`, displayName: `Group ${pad(i)}` })
    }
    insertGroup(harness.d1, { id: 'g_dir2', directoryId: 'dir_2', displayName: 'Group 001' })
    insertMember(harness.d1, 'g_120', 'u_1')
    insertMember(harness.d1, 'g_140', 'u_1')
  })

  it('displayName eq 大小写不敏感且只查当前 directory', async () => {
    harness.statements.length = 0

    const body = await readList(
      await harness.request('/Groups?filter=' + encodeURIComponent('displayName eq "group 001"')),
    )

    expect(body.Resources.map((r) => r['id'])).toEqual(['g_001'])
    const queries = listQueries(harness.statements, 'directory_groups')
    expect(queries.every((sql) => sql.includes('lower("directory_groups"."display_name")'))).toBe(
      true,
    )
  })

  it('members.value eq 通过 keyset 扫描跨页匹配', async () => {
    harness.statements.length = 0

    const body = await readList(
      await harness.request('/Groups?filter=' + encodeURIComponent('members.value eq "u_1"')),
    )

    expect(body.totalResults).toBe(2)
    expect(body.Resources.map((r) => r['id'])).toEqual(['g_120', 'g_140'])
    const queries = listQueries(harness.statements, 'directory_groups')
    expect(queries).toHaveLength(2)
    expect(queries.some((sql) => /\boffset\b/i.test(sql))).toBe(false)
  })
})
