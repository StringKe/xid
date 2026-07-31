// 有状态 in-memory D1 mock(供 tenant-context resolver 单测)。
// 解析 drizzle INSERT 列/值;SELECT 按表名 + 字符串参数收窄(与 bootstrap.test 同源逻辑)。

export type Store = Record<string, Record<string, unknown>[]>

function asUnknown<T>(v: unknown): T {
  return v as T
}

function tableNameForSql(sql: string): string {
  const m = /(?:from|into|update)\s+(?:"|`)?([a-z_]+)(?:"|`)?/i.exec(sql)
  return m?.[1] ?? 'unknown'
}

function insertColumns(sql: string): string[] {
  const m = /insert\s+into\s+(?:"|`)?[a-z_]+(?:"|`)?\s*\(([^)]*)\)/i.exec(sql)
  if (!m?.[1]) return []
  return [...m[1].matchAll(/(?:"|`)?([a-z_]+)(?:"|`)?/g)].map((x) => x[1] ?? '')
}

function insertValueTokens(sql: string): string[] {
  const m = /values\s*\(([\s\S]*?)\)\s*(?:returning|$)/i.exec(sql)
  if (!m?.[1]) return []
  return m[1].split(',').map((t) => t.trim())
}

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

export function makeStatefulD1(store: Store): D1Database {
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
    if (lower.startsWith('update') || lower.startsWith('delete')) return { rows: [], changes: 0 }
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
    if (hasFrom(lower, 'custom_hostnames')) {
      const hostnames = new Set(
        get('custom_hostnames')
          .map((row) => row['hostname'])
          .filter((value): value is string => typeof value === 'string'),
      )
      const hostname = params.find(
        (value): value is string => typeof value === 'string' && hostnames.has(value),
      )
      const matches = get('custom_hostnames').filter(
        (row) =>
          row['hostname'] === hostname && row['status'] === 'active' && row['deleted_at'] == null,
      )
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
    if (hasFrom(lower, 'sessions')) {
      const hash = params.find((v): v is string => typeof v === 'string' && v.startsWith('hash_'))
      const now = params.find((v): v is Date => v instanceof Date) ?? new Date()
      const matches = get('sessions').filter(
        (row) =>
          row['refresh_token_hash'] === hash &&
          (row['status'] === 'active' ||
            row['status'] === 'pending_mfa' ||
            row['status'] === 'pending_mfa_setup') &&
          row['expires_at'] instanceof Date &&
          row['expires_at'] > now,
      )
      return {
        rows: matches,
        changes: 0,
      }
    }
    if (hasFrom(lower, 'sso_connections')) {
      const connId = params.find((v): v is string => typeof v === 'string' && v.startsWith('conn_'))
      const matches = get('sso_connections').filter(
        (row) => row['id'] === connId && row['status'] === 'active',
      )
      return { rows: matches, changes: 0 }
    }
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
      raw: async () => {
        const rows = run(sql, bound).rows
        if (/select\s+count\(\*\)/i.test(sql)) return [[rows.length]]
        return rows.map((r) => rowToRaw(sql, r))
      },
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

export function seedMultiTenantInstance(store: Store): string {
  const now = Date.now()
  store['instances'] = [
    {
      id: 'inst_1',
      name: 'Test Instance',
      primary_domain: 'xid.test',
      mode: 'multi_tenant',
      default_locale: 'en',
      data_residency: 'us',
      mfa_policy: 'optional',
      password_policy: '{}',
      session_policy: '{}',
      status: 'active',
      created_at: now,
      updated_at: now,
    },
  ]
  store['organizations'] = [
    {
      id: 'org_default',
      tenant_id: 'org_default',
      instance_id: 'inst_1',
      slug: 'default',
      name: 'Default Org',
      public_metadata: '{}',
      private_metadata: '{}',
      status: 'active',
      created_at: now,
      updated_at: now,
    },
    {
      id: 'org_acme',
      tenant_id: 'org_acme',
      instance_id: 'inst_1',
      slug: 'acme',
      name: 'Acme Org',
      public_metadata: '{}',
      private_metadata: '{}',
      status: 'active',
      created_at: now,
      updated_at: now,
    },
  ]
  return 'inst_1'
}
