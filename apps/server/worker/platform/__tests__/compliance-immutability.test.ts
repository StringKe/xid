import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CURRENT_VISIBLE_SOURCE_EXISTS,
  currentVisibleSourceBindings,
  prepareDpaAcceptanceInsert,
  type ComplianceDocumentRow,
} from '../../compliance'
import { prepareConditionalPlatformAuditOutboxInsert } from '../audit-outbox'
import { prepareComplianceDocumentDelete } from '../compliance'

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

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.execute() as D1Result<T>
  }

  execute(): D1Result<unknown> {
    const result = this.database.prepare(this.sql).run(...this.bindings)
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as D1Result<unknown>
  }
}

class SqliteD1 {
  readonly database = new DatabaseSync(':memory:')

  constructor() {
    this.database.exec(`
      CREATE TABLE compliance_documents (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT,
        document_type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        storage_key TEXT,
        checksum TEXT,
        version TEXT NOT NULL,
        accepted_by TEXT,
        accepted_at INTEGER,
        generated_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX compliance_documents_tenant_type_version_unq
        ON compliance_documents (tenant_id, document_type, version);
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

function sourceRow(): ComplianceDocumentRow {
  const createdAt = new Date('2026-07-28T00:00:00.000Z')
  return {
    id: 'cmp_source',
    tenantId: null,
    documentType: 'dpa',
    title: 'DPA',
    status: 'available',
    storageKey: 'compliance/dpa/2026-07.pdf',
    checksum: `sha256:${'a'.repeat(64)}`,
    version: '2026-07',
    acceptedBy: null,
    acceptedAt: null,
    generatedBy: 'user_manager',
    createdAt,
    updatedAt: createdAt,
  }
}

function acceptedRow(source: ComplianceDocumentRow): ComplianceDocumentRow {
  const acceptedAt = new Date('2026-07-28T01:00:00.000Z')
  return {
    ...source,
    id: 'cmp_acceptance',
    tenantId: 'org_1',
    acceptedBy: 'user_owner',
    acceptedAt,
    generatedBy: source.id,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
  }
}

function insertRow(database: DatabaseSync, row: ComplianceDocumentRow): void {
  database
    .prepare(
      `INSERT INTO compliance_documents (
         id, tenant_id, document_type, title, status, storage_key, checksum, version,
         accepted_by, accepted_at, generated_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.tenantId,
      row.documentType,
      row.title,
      row.status,
      row.storageKey,
      row.checksum,
      row.version,
      row.acceptedBy,
      row.acceptedAt?.getTime() ?? null,
      row.generatedBy,
      row.createdAt.getTime(),
      row.updatedAt.getTime(),
    )
}

describe('compliance evidence immutability', () => {
  it('blocks source deletion after an Organization accepted that exact evidence', async () => {
    const d1 = makeD1()
    const source = sourceRow()
    insertRow(d1.database, source)
    insertRow(d1.database, acceptedRow(source))

    const result = await prepareComplianceDocumentDelete(
      { DB: d1 as unknown as D1Database } as Env,
      source.id,
    ).run()

    expect(result.meta.changes).toBe(0)
    expect(d1.database.prepare('SELECT COUNT(*) AS value FROM compliance_documents').get()).toEqual(
      { value: 2 },
    )
  })

  it('allows deletion only while the evidence has no acceptance', async () => {
    const d1 = makeD1()
    const source = sourceRow()
    insertRow(d1.database, source)

    const result = await prepareComplianceDocumentDelete(
      { DB: d1 as unknown as D1Database } as Env,
      source.id,
    ).run()

    expect(result.meta.changes).toBe(1)
  })

  it('does not create an acceptance from a source deleted after the route read it', async () => {
    const d1 = makeD1()
    const source = sourceRow()
    const acceptance = acceptedRow(source)

    const result = await prepareDpaAcceptanceInsert(
      { DB: d1 as unknown as D1Database } as Env,
      acceptance,
      source,
      acceptance.tenantId!,
    ).run()

    expect(result.meta.changes).toBe(0)
    expect(d1.database.prepare('SELECT COUNT(*) AS value FROM compliance_documents').get()).toEqual(
      { value: 0 },
    )
  })

  it('atomically creates an acceptance while the exact source is still visible', async () => {
    const d1 = makeD1()
    const source = sourceRow()
    const acceptance = acceptedRow(source)
    insertRow(d1.database, source)

    const result = await prepareDpaAcceptanceInsert(
      { DB: d1 as unknown as D1Database } as Env,
      acceptance,
      source,
      acceptance.tenantId!,
    ).run()

    expect(result.meta.changes).toBe(1)
    expect(
      d1.database
        .prepare(
          `SELECT generated_by, accepted_by, accepted_at
           FROM compliance_documents WHERE id = 'cmp_acceptance'`,
        )
        .get(),
    ).toEqual({
      generated_by: source.id,
      accepted_by: 'user_owner',
      accepted_at: acceptance.acceptedAt?.getTime(),
    })
  })

  it('does not persist an acceptance audit when the exact source disappeared before the batch', async () => {
    const d1 = makeD1()
    const source = sourceRow()
    const acceptance = acceptedRow(source)
    const env = { DB: d1 as unknown as D1Database } as Env
    const audit = prepareConditionalPlatformAuditOutboxInsert(
      env,
      {
        id: 'paud_acceptance',
        tenantId: acceptance.tenantId!,
        orgId: acceptance.tenantId!,
        action: 'compliance.dpa.accepted',
        actorId: acceptance.acceptedBy!,
        payload: { targetId: acceptance.id },
      },
      {
        sql: CURRENT_VISIBLE_SOURCE_EXISTS,
        bindings: currentVisibleSourceBindings(source, acceptance.tenantId!),
      },
      acceptance.acceptedAt!.getTime(),
    )

    const [auditResult, mutationResult] = await d1.batch([
      audit.statement,
      prepareDpaAcceptanceInsert(env, acceptance, source, {
        tenantId: acceptance.tenantId!,
        auditGate: audit.mutationGate,
      }),
    ])

    expect(auditResult?.meta.changes).toBe(0)
    expect(mutationResult?.meta.changes).toBe(0)
    expect(
      d1.database.prepare('SELECT COUNT(*) AS value FROM platform_audit_outbox').get(),
    ).toEqual({ value: 0 })
  })

  it('persists the exact-source acceptance and audit together', async () => {
    const d1 = makeD1()
    const source = sourceRow()
    const acceptance = acceptedRow(source)
    insertRow(d1.database, source)
    const env = { DB: d1 as unknown as D1Database } as Env
    const audit = prepareConditionalPlatformAuditOutboxInsert(
      env,
      {
        id: 'paud_acceptance',
        tenantId: acceptance.tenantId!,
        orgId: acceptance.tenantId!,
        action: 'compliance.dpa.accepted',
        actorId: acceptance.acceptedBy!,
        payload: { targetId: acceptance.id },
      },
      {
        sql: CURRENT_VISIBLE_SOURCE_EXISTS,
        bindings: currentVisibleSourceBindings(source, acceptance.tenantId!),
      },
      acceptance.acceptedAt!.getTime(),
    )

    const [auditResult, mutationResult] = await d1.batch([
      audit.statement,
      prepareDpaAcceptanceInsert(env, acceptance, source, {
        tenantId: acceptance.tenantId!,
        auditGate: audit.mutationGate,
      }),
    ])

    expect(auditResult?.meta.changes).toBe(1)
    expect(mutationResult?.meta.changes).toBe(1)
    expect(
      d1.database.prepare('SELECT COUNT(*) AS value FROM platform_audit_outbox').get(),
    ).toEqual({ value: 1 })
  })
})
