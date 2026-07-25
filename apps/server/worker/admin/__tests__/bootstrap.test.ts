// Seed/bootstrap 测试(铁律 8):
//   - 首次 bootstrap 创建 instance/default org/签名密钥/super admin user/ManagerAssignment 并 201。
//   - 二次 bootstrap 命中 instance-existence 门控 -> 409 already_initialized(幂等)。
//   - X-Bootstrap-Token 门控:配置 BOOTSTRAP_TOKEN 时缺失/错误 token -> 401。
//   - 签名密钥信封加密 round-trip:落库密文经 KEK 解密 + importKey 可签名(私钥明文不落库)。
//   - bootstrap 后 resolveTenantContext 按 Host 解析到该租户;discovery / jwks 可用。
// node 池无 Workers binding:用自包含有状态 in-memory D1 fake(解析 drizzle INSERT 列+值,SELECT 按字符串参数过滤)。

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { envelopeDecrypt, loadSigningKey } from '@xid-kit/crypto'
import {
  resolveInstanceLogin,
  resolveTenantContext,
  resolveTenantContextByIssuer,
} from '@xid-kit/db'
import { DEFAULT_HOSTED_AUTH_POLICY, type EnvelopeEncryptedKey } from '@xid-kit/types'
import { registerBootstrapRoute } from '../bootstrap'
import { registerHostedAuthConfigRoutes } from '../../auth/config'
import { registerDiscoveryRoutes } from '../../oidc/discovery'
import { registerJwksRoutes } from '../../oidc/jwks'
import { tenantMiddleware } from '../../middleware/tenant'
import type { XidHonoEnv } from '../../lib/types'
import { makeFakeKv } from '../../oidc/__tests__/helpers'

function asUnknown<T>(v: unknown): T {
  return v as T
}

// 已知 32 字节 KEK 的 base64 标准编码(decodeKek 用 atob)。
function makeKekB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  let s = ''
  for (const b of raw) s += String.fromCharCode(b)
  return btoa(s)
}

// ---- 有状态 in-memory D1 fake ----
// 解析 drizzle-orm/d1 生成的 INSERT(列清单 + ? 占位)实际存行;SELECT 按表名取行 + 字符串参数等值过滤。

type Store = Record<string, Record<string, unknown>[]>

function tableNameForSql(sql: string): string {
  const m = /(?:from|into|update)\s+(?:"|`)?([a-z_]+)(?:"|`)?/i.exec(sql)
  return m?.[1] ?? 'unknown'
}

// 从 INSERT 头抽列名(顺序与 values 元组一致)。
function insertColumns(sql: string): string[] {
  const m = /insert\s+into\s+(?:"|`)?[a-z_]+(?:"|`)?\s*\(([^)]*)\)/i.exec(sql)
  if (!m?.[1]) return []
  return [...m[1].matchAll(/(?:"|`)?([a-z_]+)(?:"|`)?/g)].map((x) => x[1] ?? '')
}

// 从 INSERT values 元组抽占位符序列(? / null / 字面量)。drizzle 把缺省/null 内联为 null 字面量,
// 只有 ? 才消费一个绑定参数,故需按 token 类型对齐列与参数(否则位置错位)。
function insertValueTokens(sql: string): string[] {
  const m = /values\s*\(([\s\S]*?)\)\s*(?:returning|$)/i.exec(sql)
  if (!m?.[1]) return []
  return m[1].split(',').map((t) => t.trim())
}

// SELECT / RETURNING 投影列(行对象 -> 位置数组,供 .raw())。
function projectionColumns(sql: string): string[] {
  const ret = /returning\s+(.+)$/i.exec(sql)
  const head = ret ? ret[1] : /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
  if (!head) return []
  return head.split(',').map((expr) => {
    const quoted = [...expr.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '')
    return quoted[quoted.length - 1] ?? ''
  })
}

function rowToRaw(sql: string, row: Record<string, unknown>): unknown[] {
  return projectionColumns(sql).map((c) => row[c] ?? null)
}

function makeStatefulD1(store: Store): D1Database {
  const get = (t: string): Record<string, unknown>[] => (store[t] ??= [])
  const hasFrom = (sqlText: string, table: string): boolean =>
    sqlText.includes(`from "${table}"`) ||
    sqlText.includes(`from \`${table}\``) ||
    sqlText.includes(`from ${table}`)
  const hasColumn = (sqlText: string, table: string, column: string): boolean =>
    sqlText.includes(`"${table}"."${column}"`) ||
    sqlText.includes(`\`${table}\`.\`${column}\``) ||
    sqlText.includes(column)

  const run = (
    sql: string,
    params: unknown[],
  ): { rows: Record<string, unknown>[]; changes: number } => {
    const lower = sql.trim().toLowerCase()
    const table = tableNameForSql(sql)
    if (lower.startsWith('insert')) {
      const cols = insertColumns(sql)
      const tokens = insertValueTokens(sql)
      const row: Record<string, unknown> = {}
      let p = 0
      cols.forEach((c, i) => {
        const tok = tokens[i]
        if (tok === '?') row[c] = params[p++] ?? null
        else if (tok === undefined || tok.toLowerCase() === 'null') row[c] = null
        else row[c] = tok.replace(/^'|'$/g, '')
      })
      get(table).push(row)
      return { rows: [row], changes: 1 }
    }
    if (
      lower.startsWith('update users') &&
      lower.includes('set primary_email_id') &&
      lower.includes('from user_emails')
    ) {
      let changes = 0
      const emails = get('user_emails')
      for (const user of get('users')) {
        if (user['primary_email_id'] !== null && user['primary_email_id'] !== undefined) continue
        const primary = emails
          .filter(
            (email) =>
              email['tenant_id'] === user['tenant_id'] &&
              email['user_id'] === user['id'] &&
              (email['is_primary'] === true || email['is_primary'] === 1),
          )
          .sort((a, b) => Number(a['created_at'] ?? 0) - Number(b['created_at'] ?? 0))[0]
        if (!primary?.['id']) continue
        user['primary_email_id'] = primary['id']
        user['updated_at'] = params[0] ?? user['updated_at']
        changes++
      }
      return { rows: [], changes }
    }
    if (lower.startsWith('update') || lower.startsWith('delete')) return { rows: [], changes: 0 }
    if (
      lower.includes('from instances') &&
      lower.includes('not exists') &&
      lower.includes('instance_signing_keys')
    ) {
      const keys = get('instance_signing_keys')
      const missing = get('instances')
        .filter((instance) => {
          if (instance['status'] !== 'active') return false
          return !keys.some(
            (key) =>
              key['instance_id'] === instance['id'] &&
              ['active', 'next', 'retiring'].includes(String(key['status'])),
          )
        })
        .map((instance) => ({ instance_id: instance['id'] }))
      return { rows: missing, changes: 0 }
    }
    if (
      table === 'instance_signing_keys' &&
      lower.includes('"instance_signing_keys"."status" in')
    ) {
      const instanceIds = new Set(
        get('instance_signing_keys')
          .map((row) => row['instance_id'])
          .filter((value): value is string => typeof value === 'string'),
      )
      const instanceId = params.find(
        (value): value is string => typeof value === 'string' && instanceIds.has(value),
      )
      const validStatuses = new Set(['active', 'next', 'retiring'])
      return {
        rows: get('instance_signing_keys').filter(
          (row) => row['instance_id'] === instanceId && validStatuses.has(String(row['status'])),
        ),
        changes: 0,
      }
    }
    if (hasFrom(lower, 'user_emails') && lower.includes('join') && lower.includes('users')) {
      const email = params.find((v): v is string => typeof v === 'string' && v.includes('@'))
      const users = get('users')
      const matches = get('user_emails')
        .filter((row) => row['email'] === email)
        .filter((row) =>
          users.some(
            (user) =>
              user['id'] === row['user_id'] &&
              user['status'] === 'active' &&
              user['deleted_at'] == null,
          ),
        )
        .map((row) => ({ tenant_id: row['tenant_id'], tenantId: row['tenant_id'] }))
      return { rows: matches, changes: 0 }
    }
    if (hasFrom(lower, 'user_phones') && lower.includes('join') && lower.includes('users')) {
      const phone = params.find((v): v is string => typeof v === 'string' && v.startsWith('+'))
      const users = get('users')
      const matches = get('user_phones')
        .filter((row) => row['phone'] === phone)
        .filter((row) =>
          users.some(
            (user) =>
              user['id'] === row['user_id'] &&
              user['status'] === 'active' &&
              user['deleted_at'] == null,
          ),
        )
        .map((row) => ({ tenant_id: row['tenant_id'], tenantId: row['tenant_id'] }))
      return { rows: matches, changes: 0 }
    }
    if (
      hasFrom(lower, 'users') &&
      (hasColumn(lower, 'users', 'username') || hasColumn(lower, 'users', 'external_id'))
    ) {
      const value = params.find((v): v is string => typeof v === 'string' && v !== 'active')
      const field = hasColumn(lower, 'users', 'external_id') ? 'external_id' : 'username'
      const matches = get('users')
        .filter(
          (row) => row[field] === value && row['status'] === 'active' && row['deleted_at'] == null,
        )
        .map((row) => ({ tenant_id: row['tenant_id'], tenantId: row['tenant_id'] }))
      return { rows: matches, changes: 0 }
    }
    if (hasFrom(lower, 'organization_domains')) {
      const domain = params.find((v): v is string => typeof v === 'string' && v.includes('.'))
      const wantsWildcard = lower.includes('is_wildcard')
      const matches = get('organization_domains')
        .filter(
          (row) =>
            row['domain'] === domain &&
            row['verification_status'] === 'verified' &&
            row['status'] === 'active' &&
            row['deleted_at'] == null &&
            (!wantsWildcard || row['is_wildcard'] === true || row['is_wildcard'] === 1),
        )
        .map((row) => ({ tenant_id: row['tenant_id'], tenantId: row['tenant_id'] }))
      return { rows: matches, changes: 0 }
    }
    if (lower.includes('from "organizations"')) {
      const rows = get('organizations')
      if (lower.includes('"organizations"."id"')) {
        const ids = new Set(
          rows.map((row) => row['id']).filter((v): v is string => typeof v === 'string'),
        )
        const orgIds = new Set(
          params.filter((v): v is string => typeof v === 'string' && ids.has(v)),
        )
        if (orgIds.size > 0) {
          return {
            rows: rows.filter((row) => typeof row['id'] === 'string' && orgIds.has(row['id'])),
            changes: 0,
          }
        }
      }
      if (lower.includes('"organizations"."slug"')) {
        const slugs = new Set(
          rows.map((row) => row['slug']).filter((v): v is string => typeof v === 'string'),
        )
        const slug = params.find((v): v is string => typeof v === 'string' && slugs.has(v))
        if (slug) return { rows: rows.filter((row) => row['slug'] === slug), changes: 0 }
      }
    }
    // SELECT:字符串参数全部命中行内某列才算匹配(模拟 WHERE 收窄);无字符串参数返回全表。
    const rows = get(table)
    const sp = params.filter((v): v is string => typeof v === 'string')
    if (sp.length === 0) return { rows, changes: 0 }
    return { rows: rows.filter((r) => sp.every((v) => Object.values(r).includes(v))), changes: 0 }
  }

  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const stmt = {
      bind: (...p: unknown[]) => {
        bound = p
        return stmt
      },
      raw: async () => run(sql, bound).rows.map((r) => rowToRaw(sql, r)),
      all: async () => ({ results: run(sql, bound).rows, success: true, meta: {} }),
      run: async () => {
        const result = run(sql, bound)
        return { results: result.rows, success: true, meta: { changes: result.changes } }
      },
      first: async () => run(sql, bound).rows[0] ?? null,
    }
    return stmt
  }
  return asUnknown<D1Database>({ prepare, batch: async () => [] })
}

function makeEnv(over: {
  DB: D1Database
  KEK: string
  CACHE?: KVNamespace
  BOOTSTRAP_TOKEN?: string
  ENVIRONMENT?: string
}): Env {
  return asUnknown<Env>({
    DB: over.DB,
    KEK: over.KEK,
    CACHE: over.CACHE ?? makeFakeKv(),
    BOOTSTRAP_TOKEN: over.BOOTSTRAP_TOKEN,
    ENVIRONMENT: over.ENVIRONMENT ?? 'development',
  })
}

async function insertTestOrg(
  store: Store,
  input: { instanceId: string; id: string; slug: string; name: string },
): Promise<void> {
  ;(store['organizations'] ??= []).push({
    id: input.id,
    tenant_id: input.id,
    instance_id: input.instanceId,
    parent_org_id: null,
    slug: input.slug,
    name: input.name,
    private_metadata: JSON.stringify({ hostedAuth: DEFAULT_HOSTED_AUTH_POLICY }),
    public_metadata: JSON.stringify({}),
    seat_limit: null,
    seat_used: 0,
    enrollment_mode: 'invite_required',
    allow_org_self_service: 1,
    status: 'active',
    deleted_at: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  })
}

function makeBootstrapApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  registerBootstrapRoute(app)
  return app
}

type BootstrapResult = {
  instanceId: string
  defaultOrgId: string
  orgId: string
  tenantId: string
  issuer: string
  kid: string
}

type BootstrapRepairResult = {
  repaired: Array<{ instanceId: string; kid: string }>
  repairedPrimaryEmailUsers: number
}

const HOST = 'default.xid.test'
const ADMIN_EMAIL = 'admin@example.test'

// adminEmail 是必填字段(bootstrap 无内置默认地址),用例除非显式覆盖否则补上占位地址。
async function callBootstrap(
  app: Hono<XidHonoEnv>,
  env: Env,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(
    `https://${HOST}/admin/bootstrap`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: HOST, ...headers },
      body: JSON.stringify({ adminEmail: ADMIN_EMAIL, ...body }),
    },
    env,
  )
}

describe('bootstrap idempotency + gating', () => {
  it('首次 201 创建全部实体;二次 409 already_initialized', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()

    const first = await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })
    expect(first.status).toBe(201)
    const result = (await first.json()) as BootstrapResult
    expect(result.instanceId.startsWith('inst_')).toBe(true)
    expect(result.orgId.startsWith('org_')).toBe(true)
    expect(result.defaultOrgId).toBe(result.orgId)
    expect(result.tenantId).toBe(result.orgId)
    expect(result.issuer).toBe('https://xid.test')
    expect(result.kid.startsWith('key_')).toBe(true)

    // 实体落库:1 instance、1 org(default)、1 instance signing key、1 user、1 email、1 membership、1 manager assignment。
    expect(store['instances']).toHaveLength(1)
    expect(store['organizations']).toHaveLength(1)
    expect(store['instance_signing_keys']).toHaveLength(1)
    expect(store['users']).toHaveLength(1)
    expect(store['user_emails']).toHaveLength(1)
    expect(store['memberships']).toHaveLength(1)
    expect(store['manager_assignments']).toHaveLength(1)
    expect(store['user_emails']?.[0]?.['email']).toBe(ADMIN_EMAIL)
    expect(store['users']?.[0]?.['primary_email_id']).toBe(store['user_emails']?.[0]?.['id'])

    const membership = store['memberships']?.[0] as Record<string, unknown>
    expect(membership['tenant_id']).toBe(result.defaultOrgId)
    expect(membership['org_id']).toBe(result.defaultOrgId)
    expect(membership['user_id']).toBe(store['users']?.[0]?.['id'])
    expect(membership['role']).toBe('owner')
    expect(membership['status']).toBe('active')

    // ManagerAssignment = instance_manager / scope=instance / scope_id=null(平台层,不进业务 token)。
    const mgr = store['manager_assignments']?.[0] as Record<string, unknown>
    expect(mgr['manager_role']).toBe('instance_manager')
    expect(mgr['scope_type']).toBe('instance')
    expect(mgr['scope_id']).toBeNull()

    // 顶层 org tenant_id = 自身 id(租户隔离根)。
    const tenantOrg = (store['organizations'] ?? []).find(
      (o) => o['id'] === result.orgId,
    ) as Record<string, unknown>
    expect(tenantOrg['tenant_id']).toBe(result.orgId)
    const privateMetadata =
      typeof tenantOrg['private_metadata'] === 'string'
        ? JSON.parse(tenantOrg['private_metadata'])
        : tenantOrg['private_metadata']
    expect(privateMetadata).toEqual(
      expect.objectContaining({
        hostedAuth: expect.objectContaining({
          password: expect.objectContaining({ enabled: false }),
          magicLink: expect.objectContaining({
            enabled: true,
            allowLogin: true,
            allowUserCreation: true,
          }),
          emailOtp: expect.objectContaining({
            enabled: true,
            allowLogin: true,
            allowUserCreation: true,
          }),
        }),
      }),
    )

    // 二次调用:instance 已存在 -> 409,不重复创建。
    const second = await callBootstrap(app, env, { primaryDomain: 'xid.test' })
    expect(second.status).toBe(409)
    expect(((await second.json()) as { code: string }).code).toBe('already_initialized')
    expect(store['instances']).toHaveLength(1)
    expect(store['organizations']).toHaveLength(1)
  })

  it('配置 BOOTSTRAP_TOKEN 时:缺失 token 401,错误 token 401,正确 token 201', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64(), BOOTSTRAP_TOKEN: 's3cret' })
    const app = makeBootstrapApp()

    const missing = await callBootstrap(app, env, { primaryDomain: 'xid.test' })
    expect(missing.status).toBe(401)

    const wrong = await callBootstrap(
      app,
      env,
      { primaryDomain: 'xid.test' },
      { 'x-bootstrap-token': 'nope' },
    )
    expect(wrong.status).toBe(401)
    expect(store['instances'] ?? []).toHaveLength(0)

    const ok = await callBootstrap(
      app,
      env,
      { primaryDomain: 'xid.test' },
      { 'x-bootstrap-token': 's3cret' },
    )
    expect(ok.status).toBe(201)
    expect(store['instances']).toHaveLength(1)
  })

  it('production/staging 未配置 BOOTSTRAP_TOKEN -> 503 bootstrap_token_required(不裸奔)', async () => {
    const app = makeBootstrapApp()
    for (const environment of ['production', 'staging']) {
      const store: Store = {}
      const env = makeEnv({
        DB: makeStatefulD1(store),
        KEK: makeKekB64(),
        ENVIRONMENT: environment,
      })

      const res = await callBootstrap(app, env, { primaryDomain: 'xid.test' })

      expect(res.status).toBe(503)
      expect(((await res.json()) as { code: string }).code).toBe('bootstrap_token_required')
      expect(store['instances'] ?? []).toHaveLength(0)
    }
  })

  it('production 配置 BOOTSTRAP_TOKEN 且 token 正确 -> 201', async () => {
    const store: Store = {}
    const env = makeEnv({
      DB: makeStatefulD1(store),
      KEK: makeKekB64(),
      BOOTSTRAP_TOKEN: 's3cret',
      ENVIRONMENT: 'production',
    })
    const app = makeBootstrapApp()

    const res = await callBootstrap(
      app,
      env,
      { primaryDomain: 'xid.test' },
      { 'x-bootstrap-token': 's3cret' },
    )

    expect(res.status).toBe(201)
    expect(store['instances']).toHaveLength(1)
  })

  it('缺失 adminEmail -> 400 validation_failed,不创建任何实体', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()

    const res = await app.request(
      `https://${HOST}/admin/bootstrap`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: HOST },
        body: JSON.stringify({ primaryDomain: 'xid.test' }),
      },
      env,
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('validation_failed')
    expect(body.message).toContain('adminEmail')
    expect(store['instances'] ?? []).toHaveLength(0)
    expect(store['users'] ?? []).toHaveLength(0)
  })

  it('adminEmail 不是合法邮箱 -> 400 validation_failed', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()

    const res = await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      adminEmail: 'not-an-email',
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('validation_failed')
    expect(store['instances'] ?? []).toHaveLength(0)
  })
})

describe('bootstrap repair', () => {
  it('必须配置并提供 bootstrap token', async () => {
    const app = makeBootstrapApp()
    const noSecret = makeEnv({ DB: makeStatefulD1({}), KEK: makeKekB64() })

    const missingSecret = await app.request(
      `https://${HOST}/admin/bootstrap/repair`,
      { method: 'POST', headers: { host: HOST } },
      noSecret,
    )
    expect(missingSecret.status).toBe(401)
    expect(((await missingSecret.json()) as { code: string }).code).toBe('bootstrap_token_required')

    const withSecret = makeEnv({
      DB: makeStatefulD1({}),
      KEK: makeKekB64(),
      BOOTSTRAP_TOKEN: 's3cret',
    })
    const wrong = await app.request(
      `https://${HOST}/admin/bootstrap/repair`,
      { method: 'POST', headers: { host: HOST, 'x-bootstrap-token': 'nope' } },
      withSecret,
    )
    expect(wrong.status).toBe(401)
    expect(((await wrong.json()) as { code: string }).code).toBe('unauthorized')
  })

  it('只为缺失 active signing key 的 instance 补齐 key', async () => {
    const store: Store = {
      instances: [
        { id: 'inst_missing', status: 'active' },
        { id: 'inst_ready', status: 'active' },
      ],
      organizations: [
        {
          id: 'org_admin',
          tenant_id: 'org_admin',
          instance_id: 'inst_missing',
          parent_org_id: null,
          status: 'active',
        },
        {
          id: 'org_app',
          tenant_id: 'org_app',
          instance_id: 'inst_ready',
          parent_org_id: null,
          status: 'active',
        },
      ],
      instance_signing_keys: [
        {
          id: 'sk_existing',
          instance_id: 'inst_ready',
          kid: 'key_existing',
          status: 'active',
        },
      ],
    }
    const env = makeEnv({
      DB: makeStatefulD1(store),
      KEK: makeKekB64(),
      BOOTSTRAP_TOKEN: 's3cret',
    })
    const app = makeBootstrapApp()

    const res = await app.request(
      `https://${HOST}/admin/bootstrap/repair`,
      { method: 'POST', headers: { host: HOST, 'x-bootstrap-token': 's3cret' } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      repaired: Array<{ instanceId: string; kid: string }>
    }
    expect(body.repaired).toHaveLength(1)
    expect(body.repaired[0]?.instanceId).toBe('inst_missing')
    expect(body.repaired[0]?.kid.startsWith('key_')).toBe(true)
    const missingKeys = store['instance_signing_keys']?.filter(
      (row) => row['instance_id'] === 'inst_missing',
    )
    expect(missingKeys).toHaveLength(1)
    expect(
      store['instance_signing_keys']?.filter((row) => row['instance_id'] === 'inst_ready'),
    ).toHaveLength(1)
  })

  it('回填历史用户缺失的 primary_email_id', async () => {
    const store: Store = {
      instances: [{ id: 'inst_ready', status: 'active' }],
      instance_signing_keys: [
        {
          id: 'sk_existing',
          instance_id: 'inst_ready',
          kid: 'key_existing',
          status: 'active',
        },
      ],
      users: [
        {
          id: 'user_admin',
          tenant_id: 'org_admin',
          primary_email_id: null,
          status: 'active',
          updated_at: 1,
        },
      ],
      user_emails: [
        {
          id: 'email_admin',
          tenant_id: 'org_admin',
          user_id: 'user_admin',
          email: ADMIN_EMAIL,
          is_primary: true,
          created_at: 1,
        },
      ],
    }
    const env = makeEnv({
      DB: makeStatefulD1(store),
      KEK: makeKekB64(),
      BOOTSTRAP_TOKEN: 's3cret',
    })
    const app = makeBootstrapApp()

    const res = await app.request(
      `https://${HOST}/admin/bootstrap/repair`,
      { method: 'POST', headers: { host: HOST, 'x-bootstrap-token': 's3cret' } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as BootstrapRepairResult
    expect(body.repaired).toEqual([])
    expect(body.repairedPrimaryEmailUsers).toBe(1)
    expect(store['users']?.[0]?.['primary_email_id']).toBe('email_admin')
  })
})

describe('signing key envelope encryption round-trip', () => {
  it('落库密文经 KEK 解密 + importKey 可签名(私钥明文不落库)', async () => {
    const store: Store = {}
    const kekB64 = makeKekB64()
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: kekB64 })
    const app = makeBootstrapApp()
    const res = await callBootstrap(app, env, { primaryDomain: 'xid.test', mode: 'single_tenant' })
    expect(res.status).toBe(201)

    const keyRow = store['instance_signing_keys']?.[0] as Record<string, unknown>
    // 三 blob 落库且非空;无任何私钥明文字段(只存 iv/ciphertext/tag)。
    expect(keyRow['private_key_ciphertext']).toBeDefined()
    expect(Object.keys(keyRow)).not.toContain('private_key')
    expect(Object.keys(keyRow)).not.toContain('private_key_pkcs8')

    const kekRaw = base64ToBytes(kekB64)
    const enc: EnvelopeEncryptedKey = {
      iv: toBytes(keyRow['private_key_iv']),
      ciphertext: toBytes(keyRow['private_key_ciphertext']),
      tag: toBytes(keyRow['private_key_tag']),
      kekVersion: Number(keyRow['kek_version']),
      kid: String(keyRow['kid']),
      alg: 'ES256',
    }
    // KEK 解密得到 PKCS8 明文(非空),且可载入为不可导出签名 key。
    const pkcs8 = await envelopeDecrypt(enc, kekRaw)
    expect(pkcs8.byteLength).toBeGreaterThan(0)
    const signingKey = await loadSigningKey(enc, kekRaw)
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      new TextEncoder().encode('payload'),
    )
    expect(sig.byteLength).toBeGreaterThan(0)
  })
})

describe('post-bootstrap tenant resolution', () => {
  it('resolveTenantContext maps single tenant root host to instance rpId', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    const boot = await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'single_tenant',
      defaultOrgSlug: 'default',
    })
    const result = (await boot.json()) as BootstrapResult

    const req = new Request('https://xid.test/auth/config', { headers: { host: 'xid.test' } })
    const resolved = await resolveTenantContext(req, { DB: env.DB })

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error('resolve failed')
    expect(resolved.value.tenantId).toBe(result.tenantId)
    expect(resolved.value.issuer).toBe('https://xid.test')
    expect(resolved.value.rpId).toBe('xid.test')
  })

  it('resolveTenantContext maps localhost single tenant issuer to request origin', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    const boot = await callBootstrap(app, env, {
      primaryDomain: 'localhost',
      mode: 'single_tenant',
      defaultOrgSlug: 'default',
    })
    const result = (await boot.json()) as BootstrapResult

    const req = new Request('http://localhost:5173/auth/config', {
      headers: { host: 'localhost:5173' },
    })
    const resolved = await resolveTenantContext(req, { DB: env.DB })

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error('resolve failed')
    expect(resolved.value.tenantId).toBe(result.tenantId)
    expect(resolved.value.issuer).toBe('http://localhost:5173')
    expect(resolved.value.rpId).toBe('localhost')
  })

  it('resolveTenantContext 按 Host 解析到租户;discovery / jwks 可用', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    const boot = await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })
    const result = (await boot.json()) as BootstrapResult

    // resolveTenantContext:按 Host(default.xid.test)解析到租户 org + 加载 active 签名密钥。
    const req = new Request(`https://${HOST}/`, { headers: { host: HOST } })
    const resolved = await resolveTenantContext(req, { DB: env.DB })
    if (!resolved.ok) throw new Error(`resolve failed ${JSON.stringify(resolved.error)}`)
    expect(resolved.ok).toBe(true)
    expect(resolved.value.tenantId).toBe(result.tenantId)
    expect(resolved.value.issuer).toBe('https://xid.test')
    expect(resolved.value.rpId).toBe('default.xid.test')
    const instanceKid = store['instance_signing_keys']?.[0]?.['kid']
    expect(resolved.value.signingKeys.activeKid).toBe(instanceKid)
    expect(resolved.value.signingKeys.keys).toHaveLength(1)

    // discovery:基于解析出的 issuer 输出端点。
    const discApp = makeApp(resolved.value, registerDiscoveryRoutes)
    const disc = await discApp.request(`https://${HOST}/.well-known/openid-configuration`, {}, env)
    expect(disc.status).toBe(200)
    const meta = (await disc.json()) as Record<string, unknown>
    expect(meta['issuer']).toBe('https://xid.test')
    expect(meta['jwks_uri']).toBe('https://xid.test/jwks')

    // jwks:输出 active kid 公钥(不含私钥参数 d)。
    const jwksApp = makeApp(resolved.value, registerJwksRoutes)
    const jwksRes = await jwksApp.request(`https://${HOST}/jwks`, {}, env)
    expect(jwksRes.status).toBe(200)
    const jwks = (await jwksRes.json()) as { keys: Record<string, unknown>[] }
    expect(jwks.keys).toHaveLength(1)
    expect(jwks.keys[0]?.['kid']).toBe(result.kid)
    expect(jwks.keys[0]?.['d']).toBeUndefined()
  })

  it('resolveTenantContext maps root domain to instance entry context, not fixed default tenant', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })

    const req = new Request('https://xid.test/auth/config', { headers: { host: 'xid.test' } })
    const resolved = await resolveTenantContext(req, { DB: env.DB })

    if (!resolved.ok) throw new Error(`resolve failed ${JSON.stringify(resolved.error)}`)
    expect(resolved.ok).toBe(true)
    const defaultOrg = store['organizations']?.find((row) => row['slug'] === 'default')
    expect(resolved.value.tenantId).toBe(defaultOrg?.['id'])
    expect(resolved.value.issuer).toBe('https://xid.test')
    expect(resolved.value.rpId).toBe('xid.test')
    expect(resolved.value.hostedAuthOrigin).toBe('https://xid.test')
    expect(resolved.value.resolution).toEqual({
      kind: 'instance_entry',
      primaryDomain: 'xid.test',
      unresolvedRoot: true,
    })
  })

  it('resolveTenantContext treats local loopback hosts as the same instance entry', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    await callBootstrap(app, env, {
      primaryDomain: 'localhost',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })

    const req = new Request('http://127.0.0.1:5174/auth/config', {
      headers: { host: '127.0.0.1:5174' },
    })
    const resolved = await resolveTenantContext(req, { DB: env.DB })

    if (!resolved.ok) throw new Error(`resolve failed ${JSON.stringify(resolved.error)}`)
    const defaultOrg = store['organizations']?.find((row) => row['slug'] === 'default')
    expect(resolved.value.tenantId).toBe(defaultOrg?.['id'])
    expect(resolved.value.issuer).toBe('http://127.0.0.1:5174')
    expect(resolved.value.rpId).toBe('localhost')
    expect(resolved.value.hostedAuthOrigin).toBe('http://127.0.0.1:5174')
    expect(resolved.value.resolution).toEqual({
      kind: 'instance_entry',
      primaryDomain: 'localhost',
      unresolvedRoot: true,
    })
  })

  it('resolveInstanceLogin maps default admin email to instance default org', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })

    const req = new Request('https://xid.test/auth/magic-link/send', {
      headers: { host: 'xid.test' },
    })
    const resolved = await resolveInstanceLogin(
      req,
      { DB: env.DB },
      {
        kind: 'email',
        value: ADMIN_EMAIL,
      },
    )

    if (!resolved.ok) throw new Error(`resolve failed ${JSON.stringify(resolved.error)}`)
    expect(resolved.ok).toBe(true)
    expect(resolved.value.status).toBe('resolved')
    if (resolved.value.status !== 'resolved') throw new Error('not resolved')
    const defaultOrg = store['organizations']?.find((row) => row['slug'] === 'default')
    expect(resolved.value.tenant.tenantId).toBe(defaultOrg?.['id'])
    expect(resolved.value.tenant.issuer).toBe('https://xid.test')
    expect(resolved.value.tenant.rpId).toBe('xid.test')
    expect(resolved.value.tenant.hostedAuthOrigin).toBe('https://xid.test')
    expect(resolved.value.tenant.signingKeys.activeKid).toBe(
      store['instance_signing_keys']?.[0]?.['kid'],
    )
  })

  it('resolveInstanceLogin maps business user email to default org', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })
    const defaultOrg = store['organizations']?.find((row) => row['slug'] === 'default')
    if (!defaultOrg?.['id']) throw new Error('missing default org')
    store['users']?.push({
      id: 'user_business',
      tenant_id: defaultOrg['id'],
      status: 'active',
      deleted_at: null,
    })
    store['user_emails']?.push({
      id: 'email_business',
      tenant_id: defaultOrg['id'],
      user_id: 'user_business',
      email: 'user@example.com',
      verified: 1,
      verification_status: 'verified',
      is_primary: 1,
    })

    const req = new Request('https://xid.test/auth/magic-link/send', {
      headers: { host: 'xid.test' },
    })
    const resolved = await resolveInstanceLogin(
      req,
      { DB: env.DB },
      {
        kind: 'email',
        value: 'user@example.com',
      },
    )

    if (!resolved.ok) throw new Error(`resolve failed ${JSON.stringify(resolved.error)}`)
    expect(resolved.ok).toBe(true)
    expect(resolved.value.status).toBe('resolved')
    if (resolved.value.status !== 'resolved') throw new Error('not resolved')
    expect(resolved.value.tenant.tenantId).toBe(defaultOrg['id'])
    expect(resolved.value.tenant.issuer).toBe('https://xid.test')
    expect(resolved.value.tenant.rpId).toBe('xid.test')
    expect(resolved.value.tenant.hostedAuthOrigin).toBe('https://xid.test')
  })

  it('resolveInstanceLogin maps business username, phone, and external_id to default org', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })
    const defaultOrg = store['organizations']?.find((row) => row['slug'] === 'default')
    if (!defaultOrg?.['id']) throw new Error('missing default org')
    store['users']?.push({
      id: 'user_business',
      tenant_id: defaultOrg['id'],
      status: 'active',
      deleted_at: null,
      username: 'alice',
      external_id: 'ext_alice',
    })
    ;(store['user_phones'] ??= []).push({
      id: 'phone_business',
      tenant_id: defaultOrg['id'],
      user_id: 'user_business',
      phone: '+15551234567',
      verified: 1,
      verification_status: 'verified',
      is_primary: 1,
    })

    const req = new Request('https://xid.test/auth/password/sign-in', {
      headers: { host: 'xid.test' },
    })
    for (const identifier of [
      { kind: 'username' as const, value: 'alice' },
      { kind: 'phone' as const, value: '+15551234567' },
      { kind: 'external_id' as const, value: 'ext_alice' },
    ]) {
      const resolved = await resolveInstanceLogin(req, { DB: env.DB }, identifier)
      if (!resolved.ok) throw new Error(`resolve failed ${JSON.stringify(resolved.error)}`)
      expect(resolved.value.status).toBe('resolved')
      if (resolved.value.status !== 'resolved') throw new Error('not resolved')
      expect(resolved.value.tenant.tenantId).toBe(defaultOrg['id'])
      expect(resolved.value.tenant.issuer).toBe('https://xid.test')
      expect(resolved.value.tenant.rpId).toBe('xid.test')
      expect(resolved.value.tenant.hostedAuthOrigin).toBe('https://xid.test')
      expect(resolved.value.matchedBy).toBe(identifier.kind)
    }
  })

  it('resolveInstanceLogin returns ambiguous when the same identifier exists in multiple orgs', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })
    const defaultOrg = store['organizations']?.find((row) => row['slug'] === 'default')
    if (!defaultOrg?.['id']) throw new Error('missing default org')
    const teamOrgId = `org_${crypto.randomUUID()}`
    await insertTestOrg(store, {
      instanceId: 'inst_1',
      id: teamOrgId,
      slug: 'team',
      name: 'Team Tenant',
    })
    store['users']?.push(
      {
        id: 'user_default_dup',
        tenant_id: defaultOrg['id'],
        status: 'active',
        deleted_at: null,
        username: 'shared',
      },
      {
        id: 'user_team_dup',
        tenant_id: teamOrgId,
        status: 'active',
        deleted_at: null,
        username: 'shared',
      },
    )

    const req = new Request('https://xid.test/auth/password/sign-in', {
      headers: { host: 'xid.test' },
    })
    const resolved = await resolveInstanceLogin(
      req,
      { DB: env.DB },
      {
        kind: 'username',
        value: 'shared',
      },
    )

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error('resolve failed')
    expect(resolved.value.status).toBe('ambiguous')
    if (resolved.value.status !== 'ambiguous') throw new Error('not ambiguous')
    expect(new Set(resolved.value.matches.map((match) => match.tenantId))).toEqual(
      new Set([defaultOrg['id'], teamOrgId]),
    )
    expect(resolved.value.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenantId: defaultOrg['id'],
          slug: 'default',
          name: 'Default Organization',
          issuer: 'https://xid.test',
        }),
        expect.objectContaining({
          tenantId: teamOrgId,
          slug: 'team',
          name: 'Team Tenant',
          issuer: 'https://xid.test',
        }),
      ]),
    )
    expect(resolved.value.matchedBy).toBe('username')
  })

  it('resolveInstanceLogin maps unknown email to default org for creation policy', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })

    const req = new Request('https://xid.test/auth/otp/email/send', {
      headers: { host: 'xid.test' },
    })
    const resolved = await resolveInstanceLogin(
      req,
      { DB: env.DB },
      {
        kind: 'email',
        value: 'new@example.com',
      },
    )

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error('resolve failed')
    expect(resolved.value.status).toBe('new_user')
    if (resolved.value.status !== 'new_user') throw new Error('not new_user')
    const defaultOrg = store['organizations']?.find((row) => row['slug'] === 'default')
    expect(resolved.value.tenant.tenantId).toBe(defaultOrg?.['id'])
    expect(resolved.value.tenant.issuer).toBe('https://xid.test')
    expect(resolved.value.tenant.rpId).toBe('xid.test')
    expect(resolved.value.tenant.hostedAuthOrigin).toBe('https://xid.test')
  })

  it('resolveInstanceLogin maps unknown email to verified organization domain tenant', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })
    const defaultOrg = store['organizations']?.find((row) => row['slug'] === 'default')
    if (!defaultOrg?.['id']) throw new Error('missing default org')
    ;(store['organization_domains'] ??= []).push({
      id: 'dom_admin',
      tenant_id: defaultOrg['id'],
      org_id: defaultOrg['id'],
      domain: 'corp.example.com',
      verification_status: 'verified',
      status: 'active',
      deleted_at: null,
      is_wildcard: 0,
    })

    const req = new Request('https://xid.test/auth/otp/email/send', {
      headers: { host: 'xid.test' },
    })
    const resolved = await resolveInstanceLogin(
      req,
      { DB: env.DB },
      {
        kind: 'email',
        value: 'new@corp.example.com',
      },
    )

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error('resolve failed')
    expect(resolved.value.status).toBe('new_user')
    if (resolved.value.status !== 'new_user') throw new Error('not new_user')
    expect(resolved.value.tenant.tenantId).toBe(defaultOrg['id'])
    expect(resolved.value.tenant.issuer).toBe('https://xid.test')
    expect(resolved.value.tenant.rpId).toBe('xid.test')
    expect(resolved.value.tenant.hostedAuthOrigin).toBe('https://xid.test')
  })

  it('resolveInstanceLogin ignores pending organization domain and falls back to default org', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })
    const defaultOrg = store['organizations']?.find((row) => row['slug'] === 'default')
    if (!defaultOrg?.['id']) throw new Error('missing default org')
    ;(store['organization_domains'] ??= []).push({
      id: 'dom_pending',
      tenant_id: defaultOrg['id'],
      org_id: defaultOrg['id'],
      domain: 'pending.example.com',
      verification_status: 'pending',
      status: 'active',
      deleted_at: null,
      is_wildcard: 0,
    })

    const req = new Request('https://xid.test/auth/otp/email/send', {
      headers: { host: 'xid.test' },
    })
    const resolved = await resolveInstanceLogin(
      req,
      { DB: env.DB },
      {
        kind: 'email',
        value: 'new@pending.example.com',
      },
    )

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error('resolve failed')
    expect(resolved.value.status).toBe('new_user')
    if (resolved.value.status !== 'new_user') throw new Error('not new_user')
    expect(resolved.value.tenant.tenantId).toBe(defaultOrg['id'])
    expect(resolved.value.tenant.issuer).toBe('https://xid.test')
  })

  it('resolveTenantContextByIssuer rejects root issuer without tenant hint', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })

    const req = new Request('https://xid.test/auth/magic-link/verify', {
      headers: { host: 'xid.test' },
    })
    const resolved = await resolveTenantContextByIssuer(req, { DB: env.DB }, 'https://xid.test')

    expect(resolved.ok).toBe(false)
  })

  it('resolveTenantContextByIssuer rejects legacy per-org issuer without tenant hint', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })

    const req = new Request('https://xid.test/auth/magic-link/verify', {
      headers: { host: 'xid.test' },
    })
    const resolved = await resolveTenantContextByIssuer(
      req,
      { DB: env.DB },
      'https://admin.xid.test',
    )

    expect(resolved.ok).toBe(false)
  })

  it('resolveTenantContextByIssuer rejects legacy per-org issuer with tenant hint', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })

    const defaultOrg = store['organizations']?.find((row) => row['slug'] === 'default')
    const req = new Request('https://xid.test/auth/magic-link/verify', {
      headers: { host: 'xid.test' },
    })
    const resolved = await resolveTenantContextByIssuer(
      req,
      { DB: env.DB },
      'https://admin.xid.test',
      { tenantId: String(defaultOrg?.['id'] ?? '') },
    )

    expect(resolved.ok).toBe(false)
  })

  it('resolveTenantContextByIssuer maps root issuer + tenant hint to resolved tenant', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })

    const defaultOrg = store['organizations']?.find((row) => row['slug'] === 'default')
    const req = new Request('https://xid.test/auth/magic-link/verify', {
      headers: { host: 'xid.test' },
    })
    const resolved = await resolveTenantContextByIssuer(req, { DB: env.DB }, 'https://xid.test', {
      tenantId: String(defaultOrg?.['id'] ?? ''),
    })

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error('resolve failed')
    expect(resolved.value.status).toBe('resolved')
    expect(resolved.value.tenant.tenantId).toBe(defaultOrg?.['id'])
    expect(resolved.value.tenant.issuer).toBe('https://xid.test')
    expect(resolved.value.tenant.rpId).toBe('xid.test')
    expect(resolved.value.tenant.hostedAuthOrigin).toBe('https://xid.test')
  })

  it('resolveTenantContext keeps default subdomain mapped to default tenant', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    const boot = await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })
    const result = (await boot.json()) as BootstrapResult

    const req = new Request('https://default.xid.test/auth/config', {
      headers: { host: 'default.xid.test' },
    })
    const resolved = await resolveTenantContext(req, { DB: env.DB })

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error('resolve failed')
    expect(resolved.value.tenantId).toBe(result.tenantId)
    expect(resolved.value.issuer).toBe('https://xid.test')
    expect(resolved.value.rpId).toBe('default.xid.test')
    expect(resolved.value.hostedAuthOrigin).toBeUndefined()
  })

  it('bootstrap 后默认 Hosted Auth config 只启用 Magic Link 和 Email OTP', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })

    const req = new Request(`https://${HOST}/auth/config`, { headers: { host: HOST } })
    const resolved = await resolveTenantContext(req, { DB: env.DB })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error('resolve failed')

    const configApp = makeApp(resolved.value, registerHostedAuthConfigRoutes)
    const res = await configApp.request(
      `https://${HOST}/auth/config`,
      { headers: { host: HOST } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      methods: {
        password: { enabled: boolean }
        magicLink: { enabled: boolean; allowUserCreation: boolean }
        emailOtp: { enabled: boolean; allowUserCreation: boolean }
        whatsappOtp: { enabled: boolean }
        smsOtp: { enabled: boolean }
        passkey: { enabled: boolean }
        enterpriseSso: { enabled: boolean }
      }
      socialProviders: unknown[]
    }
    expect(body.methods.magicLink.enabled).toBe(true)
    expect(body.methods.magicLink.allowUserCreation).toBe(true)
    expect(body.methods.emailOtp.enabled).toBe(true)
    expect(body.methods.emailOtp.allowUserCreation).toBe(true)
    expect(body.methods.password.enabled).toBe(false)
    expect(body.methods.whatsappOtp.enabled).toBe(false)
    expect(body.methods.smsOtp.enabled).toBe(false)
    expect(body.methods.passkey.enabled).toBe(false)
    expect(body.methods.enterpriseSso.enabled).toBe(false)
    expect(body.socialProviders).toEqual([])
  })

  it('tenantMiddleware 在 bootstrap 后命中租户(命中 protocol 路由)', async () => {
    const store: Store = {}
    const env = makeEnv({ DB: makeStatefulD1(store), KEK: makeKekB64() })
    const app = makeBootstrapApp()
    await callBootstrap(app, env, {
      primaryDomain: 'xid.test',
      mode: 'multi_tenant',
      defaultOrgSlug: 'default',
    })

    const probe = new Hono<XidHonoEnv>()
    probe.use('*', tenantMiddleware)
    probe.get('/_probe', (c) => c.json({ tenantId: c.get('tenant').tenantId }))
    const res = await probe.request(`https://${HOST}/_probe`, { headers: { host: HOST } }, env)
    expect(res.status).toBe(200)
    const probed = (await res.json()) as { tenantId: string }
    expect(probed.tenantId.startsWith('org_')).toBe(true)
  })
})

// 在 Hono app 挂 tenant 中间件(直接 set 已解析 ctx)后执行 register 函数。
function makeApp(
  ctx: import('@xid-kit/types').TenantContext,
  register: (app: Hono<XidHonoEnv>) => void,
): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.use('*', async (c, next) => {
    c.set('tenant', ctx)
    c.set('session', null)
    await next()
  })
  register(app)
  return app
}

// D1 blob 回读为 ArrayBuffer/Uint8Array,统一转 Uint8Array。
function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  throw new Error('expected blob bytes')
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
