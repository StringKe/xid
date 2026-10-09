import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'

type SqliteRow = Record<string, unknown>

const migrationDir = fileURLToPath(new URL('../../../../../packages/db/drizzle/', import.meta.url))

class SqliteD1Statement {
  private bindings: unknown[] = []

  constructor(
    private readonly owner: SqliteD1,
    readonly sql: string,
  ) {}

  bind(...bindings: unknown[]): this {
    this.bindings = bindings
    return this
  }

  execute(): D1Result<unknown> {
    this.owner.maybeFail(this.sql)
    const statement = this.owner.database.prepare(this.sql)
    const result = statement.run(...(this.bindings as never[]))
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.execute() as D1Result<T>
  }

  async all<T = SqliteRow>(): Promise<D1Result<T>> {
    this.owner.maybeFail(this.sql)
    const statement = this.owner.database.prepare(this.sql)
    return {
      success: true,
      results: statement.all(...(this.bindings as never[])) as T[],
      meta: { changes: 0 },
    } as unknown as D1Result<T>
  }

  async first<T = SqliteRow>(): Promise<T | null> {
    this.owner.maybeFail(this.sql)
    const statement = this.owner.database.prepare(this.sql)
    return (statement.get(...(this.bindings as never[])) as T | undefined) ?? null
  }
}

export class SqliteD1 {
  readonly database = new DatabaseSync(':memory:')
  private failPattern: RegExp | null = null

  prepare(sql: string): D1PreparedStatement {
    return new SqliteD1Statement(this, sql) as unknown as D1PreparedStatement
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

  failNext(pattern: RegExp): void {
    this.failPattern = pattern
  }

  maybeFail(sql: string): void {
    if (!this.failPattern?.test(sql)) return
    this.failPattern = null
    throw new Error('injected_d1_failure')
  }

  close(): void {
    this.database.close()
  }
}

function applyMigrations(db: DatabaseSync): void {
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
}

function seedTenant(db: DatabaseSync, tenantId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO instances (
       id, name, primary_domain, mode, default_locale, data_residency, mfa_policy,
       password_policy, session_policy, status, created_at, updated_at
     ) VALUES (
       'inst_1', 'XID', 'xid.test', 'multi_tenant', 'en', 'us', 'optional',
       '{}', '{}', 'active', 1000, 1000
     )`,
  ).run()
  db.prepare(
    `INSERT INTO organizations (
       id, tenant_id, instance_id, parent_org_id, slug, name, public_metadata,
       private_metadata, seat_limit, seat_used, enrollment_mode, allow_org_self_service,
       status, created_at, updated_at
     ) VALUES (?, ?, 'inst_1', NULL, ?, ?, '{}', '{}', NULL, 0, 'invite_required', 1, 'active', 1000, 1000)`,
  ).run(tenantId, tenantId, tenantId.replace('_', '-'), tenantId)
}

export function createBillingDatabase(tenantIds: readonly string[] = ['org_1']): SqliteD1 {
  const d1 = new SqliteD1()
  applyMigrations(d1.database)
  for (const tenantId of tenantIds) seedTenant(d1.database, tenantId)
  return d1
}

export function seedBillingAccount(
  d1: SqliteD1,
  input: { tenantId?: string; customerId?: string; status?: string } = {},
): void {
  d1.database
    .prepare(
      `INSERT INTO organization_plans (
         tenant_id, status, source, external_customer_id,
         effective_at, created_at, updated_at
       ) VALUES (?, ?, 'stripe', ?, 1000, 1000, 1000)`,
    )
    .run(input.tenantId ?? 'org_1', input.status ?? 'active', input.customerId ?? 'cus_1')
}

export function seedMonthlyUsage(
  d1: SqliteD1,
  input: { tenantId?: string; period: string; mau: number },
): void {
  d1.database
    .prepare(
      `INSERT INTO usage_monthly (tenant_id, year_month, mau, archived_at)
       VALUES (?, ?, ?, '2026-07-28T00:00:00.000Z')
       ON CONFLICT (tenant_id, year_month) DO UPDATE SET mau = excluded.mau`,
    )
    .run(input.tenantId ?? 'org_1', input.period, input.mau)
}

export function makeBillingEnv(d1: SqliteD1): Env {
  return {
    DB: d1 as unknown as D1Database,
    AUDIT_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    METERING_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    },
    STRIPE_SECRET_KEY: 'sk_test_local',
    STRIPE_WEBHOOK_SECRET: 'whsec_local',
    STRIPE_METER_EVENT_NAME: 'xid_mau',
  } as unknown as Env
}
