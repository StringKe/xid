// 账户门户路由测试用 D1:node:sqlite 内存库 + packages/db 全量迁移链,SQL 真实执行。
// 租户隔离用例因此能验证真实的 WHERE tenant_id 收窄,而不是 fake 的字符串匹配。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const migrationDir = fileURLToPath(new URL('../../../../../packages/db/drizzle/', import.meta.url))

function normalizeBinding(value: unknown): unknown {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === undefined) return null
  if (value instanceof Uint8Array) return value
  return value
}

class SqliteD1Statement {
  private bindings: unknown[] = []

  constructor(
    private readonly database: DatabaseSync,
    readonly sql: string,
  ) {}

  bind(...bindings: unknown[]): this {
    this.bindings = bindings.map(normalizeBinding)
    return this
  }

  execute(): D1Result<unknown> {
    const result = this.database.prepare(this.sql).run(...(this.bindings as never[]))
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.execute() as unknown as D1Result<T>
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.database.prepare(this.sql).all(...(this.bindings as never[]))
    return { success: true, results: rows as T[], meta: { changes: 0 } } as unknown as D1Result<T>
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...(this.bindings as never[]))
    return (row as T | undefined) ?? null
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const statement = this.database.prepare(this.sql)
    statement.setReturnArrays(true)
    return statement.all(...(this.bindings as never[])) as T[]
  }
}

export class SqliteD1 {
  readonly database = new DatabaseSync(':memory:')

  constructor() {
    for (const file of readdirSync(migrationDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      this.database.exec(readFileSync(join(migrationDir, file), 'utf8'))
    }
  }

  prepare(sql: string): D1PreparedStatement {
    return new SqliteD1Statement(this.database, sql) as unknown as D1PreparedStatement
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) =>
        (statement as unknown as SqliteD1Statement).execute(),
      )
      this.database.exec('COMMIT')
      return results as D1Result<T>[]
    } catch (cause) {
      this.database.exec('ROLLBACK')
      throw cause
    }
  }

  asD1(): D1Database {
    return this as unknown as D1Database
  }

  insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row)
    const placeholders = columns.map(() => '?').join(', ')
    this.database
      .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
      .run(...(columns.map((column) => normalizeBinding(row[column])) as never[]))
  }

  rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.database.prepare(sql).all(...(params.map(normalizeBinding) as never[])) as Record<
      string,
      unknown
    >[]
  }
}

const NOW = 1_700_000_000_000

// 顶层组织 id 与 tenant_id 相同;迁移里的层级触发器要求顶层组织先于子组织写入。
export function seedOrganization(
  db: SqliteD1,
  input: { id: string; tenantId: string; name?: string; parentOrgId?: string | null },
): void {
  db.insert('organizations', {
    id: input.id,
    tenant_id: input.tenantId,
    instance_id: 'inst_1',
    parent_org_id: input.parentOrgId ?? (input.id === input.tenantId ? null : input.tenantId),
    slug: input.id,
    name: input.name ?? input.id,
    public_metadata: '{}',
    private_metadata: '{}',
    seat_used: 0,
    enrollment_mode: 'invite_required',
    allow_org_self_service: 1,
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
  })
}

export function seedUser(
  db: SqliteD1,
  input: { id: string; tenantId: string; primaryEmail?: string; displayName?: string },
): void {
  const emailId = input.primaryEmail ? `em_${input.id}` : null
  db.insert('users', {
    id: input.id,
    tenant_id: input.tenantId,
    primary_email_id: emailId,
    display_name: input.displayName ?? null,
    public_metadata: '{}',
    private_metadata: '{}',
    unsafe_metadata: '{}',
    custom_attributes: '{}',
    status: 'active',
    password_change_required: 0,
    is_new_user: 0,
    profile_completion_status: 'complete',
    failed_login_count: 0,
    created_at: NOW,
    updated_at: NOW,
  })
  if (input.primaryEmail && emailId) {
    seedEmail(db, {
      id: emailId,
      tenantId: input.tenantId,
      userId: input.id,
      email: input.primaryEmail,
      verified: true,
      isPrimary: true,
    })
  }
}

export function seedEmail(
  db: SqliteD1,
  input: {
    id: string
    tenantId: string
    userId: string
    email: string
    verified: boolean
    isPrimary?: boolean
  },
): void {
  db.insert('user_emails', {
    id: input.id,
    tenant_id: input.tenantId,
    user_id: input.userId,
    email: input.email,
    verified: input.verified ? 1 : 0,
    verification_status: input.verified ? 'verified' : 'unverified',
    is_primary: input.isPrimary ? 1 : 0,
    verified_at: input.verified ? NOW : null,
    created_at: NOW,
    updated_at: NOW,
  })
}

export function seedMembership(
  db: SqliteD1,
  input: { id: string; tenantId: string; orgId: string; userId: string; role?: string },
): void {
  db.insert('memberships', {
    id: input.id,
    tenant_id: input.tenantId,
    org_id: input.orgId,
    user_id: input.userId,
    role: input.role ?? 'member',
    membership_type: 'member',
    status: 'active',
    is_managed: 0,
    joined_at: NOW,
    created_at: NOW,
    updated_at: NOW,
  })
}
