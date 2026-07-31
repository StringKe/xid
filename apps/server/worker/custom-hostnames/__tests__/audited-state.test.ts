import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { schema } from '@xid-kit/db'
import {
  persistCustomHostnameStateWithAudit,
  releaseCustomHostnameWithAudit,
} from '../audited-state'

type CustomHostnameRow = typeof schema.customHostnames.$inferSelect

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
      CREATE TABLE custom_hostnames (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        hostname TEXT NOT NULL,
        cloudflare_hostname_id TEXT,
        status TEXT NOT NULL CHECK (status <> 'invalid'),
        hostname_status TEXT NOT NULL,
        ssl_status TEXT,
        ownership_verification_type TEXT,
        ownership_verification_name TEXT,
        ownership_verification_value TEXT,
        ownership_expires_at INTEGER,
        dcv_delegation_records TEXT NOT NULL,
        validation_records TEXT NOT NULL,
        traffic_cname_target TEXT NOT NULL,
        verification_errors TEXT NOT NULL,
        requires_passkey_reregistration INTEGER NOT NULL,
        activated_at INTEGER,
        last_polled_at INTEGER,
        deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
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
        queued_at INTEGER,
        last_error_code TEXT,
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
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) database.close()
})

function makeD1(): SqliteD1 {
  const d1 = new SqliteD1()
  databases.push(d1)
  return d1
}

function hostnameRow(overrides: Partial<CustomHostnameRow> = {}): CustomHostnameRow {
  const createdAt = new Date(1_000)
  return {
    id: 'ch_1',
    tenantId: 'tenant_1',
    orgId: 'org_1',
    instanceId: 'instance_1',
    hostname: 'login.customer.example',
    cloudflareHostnameId: 'cf_1',
    status: 'pending',
    hostnameStatus: 'pending',
    sslStatus: 'pending_validation',
    ownershipVerificationType: 'txt',
    ownershipVerificationName: '_cf-custom-hostname.login.customer.example',
    ownershipVerificationValue: 'ownership-token',
    ownershipExpiresAt: new Date(10_000),
    dcvDelegationRecords: [],
    validationRecords: [],
    trafficCnameTarget: 'customers.xid.dev',
    verificationErrors: [],
    requiresPasskeyReregistration: true,
    activatedAt: null,
    lastPolledAt: createdAt,
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  }
}

function insertHostname(d1: SqliteD1, row: CustomHostnameRow): void {
  d1.database
    .prepare(
      `INSERT INTO custom_hostnames (
         id, tenant_id, org_id, instance_id, hostname, cloudflare_hostname_id,
         status, hostname_status, ssl_status, ownership_verification_type,
         ownership_verification_name, ownership_verification_value, ownership_expires_at,
         dcv_delegation_records, validation_records, traffic_cname_target,
         verification_errors, requires_passkey_reregistration, activated_at,
         last_polled_at, deleted_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.tenantId,
      row.orgId,
      row.instanceId,
      row.hostname,
      row.cloudflareHostnameId,
      row.status,
      row.hostnameStatus,
      row.sslStatus,
      row.ownershipVerificationType,
      row.ownershipVerificationName,
      row.ownershipVerificationValue,
      row.ownershipExpiresAt?.getTime() ?? null,
      JSON.stringify(row.dcvDelegationRecords),
      JSON.stringify(row.validationRecords),
      row.trafficCnameTarget,
      JSON.stringify(row.verificationErrors),
      row.requiresPasskeyReregistration ? 1 : 0,
      row.activatedAt?.getTime() ?? null,
      row.lastPolledAt?.getTime() ?? null,
      row.deletedAt?.getTime() ?? null,
      row.createdAt.getTime(),
      row.updatedAt.getTime(),
    )
}

function env(d1: SqliteD1, send = vi.fn(async () => undefined)): Env {
  return {
    DB: d1 as unknown as D1Database,
    AUDIT_QUEUE: { send },
  } as unknown as Env
}

describe('custom hostname audited state mutation', () => {
  it('keeps the committed mutation successful when immediate queue delivery fails', async () => {
    const d1 = makeD1()
    const row = hostnameRow()
    insertHostname(d1, row)
    const send = vi.fn(async () => {
      throw new Error('queue unavailable')
    })

    const updated = await persistCustomHostnameStateWithAudit(env(d1, send), {
      row,
      patch: {
        status: 'active',
        hostnameStatus: 'active',
        sslStatus: 'active',
        activatedAt: new Date(2_000),
        lastPolledAt: new Date(2_000),
      },
      action: 'custom_hostname.refreshed',
      actorId: 'user_1',
      now: 2_000,
    })

    expect(updated.status).toBe('active')
    expect(
      d1.database
        .prepare(`SELECT status, hostname_status AS hostnameStatus FROM custom_hostnames`)
        .get(),
    ).toEqual({ status: 'active', hostnameStatus: 'active' })
    expect(
      d1.database
        .prepare(
          `SELECT status, attempt_count AS attemptCount, last_error_code AS lastErrorCode
             FROM platform_audit_outbox`,
        )
        .get(),
    ).toEqual({
      status: 'pending',
      attemptCount: 1,
      lastErrorCode: 'audit_queue_send_failed',
    })
  })

  it('rolls back the audit insert when the hostname mutation fails', async () => {
    const d1 = makeD1()
    const row = hostnameRow()
    insertHostname(d1, row)

    await expect(
      persistCustomHostnameStateWithAudit(env(d1), {
        row,
        patch: { status: 'invalid' },
        action: 'custom_hostname.refreshed',
        actorId: 'user_1',
        now: 2_000,
      }),
    ).rejects.toThrow()

    expect(
      d1.database.prepare(`SELECT status FROM custom_hostnames WHERE id = 'ch_1'`).get(),
    ).toEqual({ status: 'pending' })
    expect(
      d1.database.prepare(`SELECT COUNT(*) AS value FROM platform_audit_outbox`).get(),
    ).toEqual({ value: 0 })
  })

  it('persists neither mutation nor audit after an optimistic-concurrency mismatch', async () => {
    const d1 = makeD1()
    const stale = hostnameRow()
    insertHostname(d1, stale)
    d1.database.prepare(`UPDATE custom_hostnames SET updated_at = 1500 WHERE id = 'ch_1'`).run()

    await expect(
      persistCustomHostnameStateWithAudit(env(d1), {
        row: stale,
        patch: { status: 'active' },
        action: 'custom_hostname.refreshed',
        actorId: 'user_1',
        now: 2_000,
      }),
    ).rejects.toMatchObject({ code: 'not_found' })

    expect(
      d1.database.prepare(`SELECT status FROM custom_hostnames WHERE id = 'ch_1'`).get(),
    ).toEqual({ status: 'pending' })
    expect(
      d1.database.prepare(`SELECT COUNT(*) AS value FROM platform_audit_outbox`).get(),
    ).toEqual({ value: 0 })
  })

  it('keeps an audited ownership release committed when immediate queue delivery fails', async () => {
    const d1 = makeD1()
    const row = hostnameRow()
    insertHostname(d1, row)
    const send = vi.fn(async () => {
      throw new Error('queue unavailable')
    })

    await releaseCustomHostnameWithAudit(env(d1, send), {
      row,
      action: 'custom_hostname.ownership_expired',
      now: 2_000,
    })

    expect(d1.database.prepare(`SELECT COUNT(*) AS value FROM custom_hostnames`).get()).toEqual({
      value: 0,
    })
    expect(
      d1.database
        .prepare(
          `SELECT action, status, attempt_count AS attemptCount,
                  last_error_code AS lastErrorCode
             FROM platform_audit_outbox`,
        )
        .get(),
    ).toEqual({
      action: 'custom_hostname.ownership_expired',
      status: 'pending',
      attemptCount: 1,
      lastErrorCode: 'audit_queue_send_failed',
    })
  })

  it('rolls back the ownership-release audit when the delete fails', async () => {
    const d1 = makeD1()
    const row = hostnameRow()
    insertHostname(d1, row)
    d1.database.exec(`
      CREATE TRIGGER custom_hostname_delete_rejected
      BEFORE DELETE ON custom_hostnames
      BEGIN
        SELECT RAISE(ABORT, 'delete rejected');
      END;
    `)

    await expect(
      releaseCustomHostnameWithAudit(env(d1), {
        row,
        action: 'custom_hostname.ownership_expired',
        now: 2_000,
      }),
    ).rejects.toThrow()

    expect(d1.database.prepare(`SELECT COUNT(*) AS value FROM custom_hostnames`).get()).toEqual({
      value: 1,
    })
    expect(
      d1.database.prepare(`SELECT COUNT(*) AS value FROM platform_audit_outbox`).get(),
    ).toEqual({ value: 0 })
  })

  it('releases neither hostname nor audit after an ownership-release concurrency mismatch', async () => {
    const d1 = makeD1()
    const stale = hostnameRow()
    insertHostname(d1, stale)
    d1.database.prepare(`UPDATE custom_hostnames SET updated_at = 1500 WHERE id = 'ch_1'`).run()

    await expect(
      releaseCustomHostnameWithAudit(env(d1), {
        row: stale,
        action: 'custom_hostname.ownership_expired',
        now: 2_000,
      }),
    ).rejects.toMatchObject({ code: 'not_found' })

    expect(d1.database.prepare(`SELECT COUNT(*) AS value FROM custom_hostnames`).get()).toEqual({
      value: 1,
    })
    expect(
      d1.database.prepare(`SELECT COUNT(*) AS value FROM platform_audit_outbox`).get(),
    ).toEqual({ value: 0 })
  })
})
