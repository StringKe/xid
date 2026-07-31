import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareConditionalPlatformAuditOutboxInsert } from '../audit-outbox'

class SqliteD1Statement {
  private bindings: unknown[] = []

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...bindings: unknown[]): this {
    this.bindings = bindings
    return this
  }

  execute(): D1Result<unknown> {
    const result = this.database.prepare(this.sql).run(...this.bindings)
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as D1Result<unknown>
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.execute() as D1Result<T>
  }
}

class SqliteD1 {
  readonly database = new DatabaseSync(':memory:')

  constructor() {
    this.database.exec(`
      CREATE TABLE resources (
        id TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE TABLE platform_audit_outbox (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        org_id TEXT,
        action TEXT NOT NULL,
        actor_id TEXT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        available_at INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
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

  close(): void {
    this.database.close()
  }
}

const databases: SqliteD1[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function makeD1(): SqliteD1 {
  const database = new SqliteD1()
  databases.push(database)
  return database
}

function prepareAudit(d1: SqliteD1, version: number) {
  return prepareConditionalPlatformAuditOutboxInsert(
    { DB: d1 as unknown as D1Database } as Env,
    {
      id: `paud_version_${version}`,
      tenantId: 'tenant_1',
      action: 'resource.updated',
      actorId: 'user_1',
      payload: { targetId: 'resource_1', version },
    },
    {
      sql: `EXISTS (SELECT 1 FROM resources WHERE id = ? AND version = ?)`,
      bindings: ['resource_1', version],
    },
    1_000 + version,
  )
}

describe('conditional platform audit outbox atomicity', () => {
  it('persists neither mutation nor audit when the optimistic condition changed', async () => {
    const d1 = makeD1()
    d1.database
      .prepare(`INSERT INTO resources (id, value, version) VALUES ('resource_1', 'newer', 2)`)
      .run()
    const audit = prepareAudit(d1, 1)

    const [auditResult, mutationResult] = await d1.batch([
      audit.statement,
      d1
        .prepare(
          `UPDATE resources
              SET value = 'stale', version = 2
            WHERE id = ? AND version = ? AND ${audit.mutationGate.sql}`,
        )
        .bind('resource_1', 1, ...audit.mutationGate.bindings),
    ])

    expect(auditResult?.meta.changes).toBe(0)
    expect(mutationResult?.meta.changes).toBe(0)
    expect(
      d1.database.prepare(`SELECT value FROM resources WHERE id = 'resource_1'`).get(),
    ).toEqual({
      value: 'newer',
    })
    expect(
      d1.database.prepare('SELECT COUNT(*) AS value FROM platform_audit_outbox').get(),
    ).toEqual({ value: 0 })
  })

  it('persists a successful conditional mutation and its audit in one batch', async () => {
    const d1 = makeD1()
    d1.database
      .prepare(`INSERT INTO resources (id, value, version) VALUES ('resource_1', 'old', 1)`)
      .run()
    const audit = prepareAudit(d1, 1)

    const [auditResult, mutationResult] = await d1.batch([
      audit.statement,
      d1
        .prepare(
          `UPDATE resources
              SET value = 'new', version = 2
            WHERE id = ? AND version = ? AND ${audit.mutationGate.sql}`,
        )
        .bind('resource_1', 1, ...audit.mutationGate.bindings),
    ])

    expect(auditResult?.meta.changes).toBe(1)
    expect(mutationResult?.meta.changes).toBe(1)
    expect(
      d1.database.prepare(`SELECT value FROM resources WHERE id = 'resource_1'`).get(),
    ).toEqual({
      value: 'new',
    })
    expect(
      d1.database.prepare('SELECT COUNT(*) AS value FROM platform_audit_outbox').get(),
    ).toEqual({ value: 1 })
  })

  it('rolls back the conditional audit if a later mutation statement fails', async () => {
    const d1 = makeD1()
    d1.database
      .prepare(`INSERT INTO resources (id, value, version) VALUES ('resource_1', 'old', 1)`)
      .run()
    const audit = prepareAudit(d1, 1)

    await expect(
      d1.batch([
        audit.statement,
        d1
          .prepare(
            `UPDATE resources
                SET value = NULL
              WHERE id = ? AND version = ? AND ${audit.mutationGate.sql}`,
          )
          .bind('resource_1', 1, ...audit.mutationGate.bindings),
      ]),
    ).rejects.toThrow()

    expect(
      d1.database.prepare('SELECT COUNT(*) AS value FROM platform_audit_outbox').get(),
    ).toEqual({ value: 0 })
  })
})
