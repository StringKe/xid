import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  preparePrivacyErasureAtomicGuard,
  readPrivacyErasureEligibility,
  requirePrivacyErasureEligibility,
} from '../erasure-eligibility'

type SqliteRow = Record<string, unknown>

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
    const result = this.owner.database.prepare(this.sql).run(...this.bindings)
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as D1Result<unknown>
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.execute() as D1Result<T>
  }

  async all<T = SqliteRow>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.owner.database.prepare(this.sql).all(...this.bindings) as T[],
      meta: { changes: 0 },
    } as D1Result<T>
  }

  async first<T = SqliteRow>(): Promise<T | null> {
    return (this.owner.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null
  }
}

class SqliteD1 {
  readonly database = new DatabaseSync(':memory:')

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

  close(): void {
    this.database.close()
  }
}

function makeEnv(): { d1: SqliteD1; env: Env } {
  const d1 = new SqliteD1()
  d1.database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE memberships (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE manager_assignments (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      manager_role TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT
    );
    CREATE TABLE privacy_requests (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      request_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return { d1, env: { DB: d1 as unknown as D1Database } as Env }
}

function addUser(d1: SqliteD1, id: string, tenantId = 't_1', status = 'active'): void {
  d1.database
    .prepare(`INSERT INTO users (id, tenant_id, status, deleted_at) VALUES (?, ?, ?, NULL)`)
    .run(id, tenantId, status)
}

function addOwner(
  d1: SqliteD1,
  id: string,
  userId: string,
  options: { tenantId?: string; orgId?: string; status?: string } = {},
): void {
  const { tenantId = 't_1', orgId = 'org_1', status = 'active' } = options
  d1.database
    .prepare(
      `INSERT INTO memberships (id, tenant_id, org_id, user_id, role, status)
       VALUES (?, ?, ?, ?, 'owner', ?)`,
    )
    .run(id, tenantId, orgId, userId, status)
}

function addInstanceManager(
  d1: SqliteD1,
  id: string,
  userId: string,
  options: { tenantId?: string; scopeId?: string | null } = {},
): void {
  const { tenantId = 't_1', scopeId = null } = options
  d1.database
    .prepare(
      `INSERT INTO manager_assignments (
         id, tenant_id, user_id, manager_role, scope_type, scope_id
       ) VALUES (?, ?, ?, 'instance_manager', 'instance', ?)`,
    )
    .run(id, tenantId, userId, scopeId)
}

const openDatabases: SqliteD1[] = []

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close()
})

describe('privacy erasure role eligibility', () => {
  it('blocks a sole active owner and allows erasure after an active replacement exists', async () => {
    const { d1, env } = makeEnv()
    openDatabases.push(d1)
    addUser(d1, 'user_target')
    addOwner(d1, 'mem_target', 'user_target')

    await expect(readPrivacyErasureEligibility(env, 't_1', 'user_target')).resolves.toEqual({
      blocksOwnerErasure: true,
      blocksInstanceManagerErasure: false,
    })
    await expect(requirePrivacyErasureEligibility(env, 't_1', 'user_target')).rejects.toMatchObject(
      { code: 'conflict', httpStatus: 409 },
    )

    addUser(d1, 'user_other_tenant', 't_2')
    addOwner(d1, 'mem_other_tenant', 'user_other_tenant', { tenantId: 't_2' })
    await expect(readPrivacyErasureEligibility(env, 't_1', 'user_target')).resolves.toEqual({
      blocksOwnerErasure: true,
      blocksInstanceManagerErasure: false,
    })

    addUser(d1, 'user_replacement')
    addOwner(d1, 'mem_replacement', 'user_replacement')
    await expect(readPrivacyErasureEligibility(env, 't_1', 'user_target')).resolves.toEqual({
      blocksOwnerErasure: false,
      blocksInstanceManagerErasure: false,
    })
  })

  it('requires another active user to hold instance_manager, including across tenants', async () => {
    const { d1, env } = makeEnv()
    openDatabases.push(d1)
    addUser(d1, 'user_target')
    addInstanceManager(d1, 'mgr_target', 'user_target')
    addUser(d1, 'user_suspended', 't_2', 'suspended')
    addInstanceManager(d1, 'mgr_suspended', 'user_suspended', { tenantId: 't_2' })

    await expect(readPrivacyErasureEligibility(env, 't_1', 'user_target')).resolves.toEqual({
      blocksOwnerErasure: false,
      blocksInstanceManagerErasure: true,
    })

    d1.database.prepare(`UPDATE users SET status = 'active' WHERE id = 'user_suspended'`).run()
    await expect(readPrivacyErasureEligibility(env, 't_1', 'user_target')).resolves.toEqual({
      blocksOwnerErasure: false,
      blocksInstanceManagerErasure: false,
    })
  })

  it('does not accept an active instance_manager from another instance scope', async () => {
    const { d1, env } = makeEnv()
    openDatabases.push(d1)
    addUser(d1, 'user_target')
    addInstanceManager(d1, 'mgr_target', 'user_target', { scopeId: 'inst_a' })
    addUser(d1, 'user_other_scope', 't_2')
    addInstanceManager(d1, 'mgr_other_scope', 'user_other_scope', {
      tenantId: 't_2',
      scopeId: 'inst_b',
    })

    await expect(readPrivacyErasureEligibility(env, 't_1', 'user_target')).resolves.toEqual({
      blocksOwnerErasure: false,
      blocksInstanceManagerErasure: true,
    })

    addUser(d1, 'user_same_scope', 't_3')
    addInstanceManager(d1, 'mgr_same_scope', 'user_same_scope', {
      tenantId: 't_3',
      scopeId: 'inst_a',
    })
    await expect(readPrivacyErasureEligibility(env, 't_1', 'user_target')).resolves.toEqual({
      blocksOwnerErasure: false,
      blocksInstanceManagerErasure: false,
    })
  })

  it('matches a NULL instance scope only with another NULL instance scope', async () => {
    const { d1, env } = makeEnv()
    openDatabases.push(d1)
    addUser(d1, 'user_target')
    addInstanceManager(d1, 'mgr_target', 'user_target')
    addUser(d1, 'user_scoped', 't_2')
    addInstanceManager(d1, 'mgr_scoped', 'user_scoped', {
      tenantId: 't_2',
      scopeId: 'inst_a',
    })

    await expect(readPrivacyErasureEligibility(env, 't_1', 'user_target')).resolves.toEqual({
      blocksOwnerErasure: false,
      blocksInstanceManagerErasure: true,
    })

    addUser(d1, 'user_global', 't_3')
    addInstanceManager(d1, 'mgr_global', 'user_global', { tenantId: 't_3' })
    await expect(readPrivacyErasureEligibility(env, 't_1', 'user_target')).resolves.toEqual({
      blocksOwnerErasure: false,
      blocksInstanceManagerErasure: false,
    })
  })

  it('rolls back execution atomically when a replacement owner changes during the grace period', async () => {
    const { d1, env } = makeEnv()
    openDatabases.push(d1)
    addUser(d1, 'user_target')
    addUser(d1, 'user_replacement')
    addOwner(d1, 'mem_target', 'user_target')
    addOwner(d1, 'mem_replacement', 'user_replacement')
    d1.database
      .prepare(
        `INSERT INTO privacy_requests (
           id, tenant_id, user_id, request_type, status, created_at, updated_at
         ) VALUES ('prv_delete', 't_1', 'user_target', 'delete', 'processing', 1, 1)`,
      )
      .run()

    await expect(
      requirePrivacyErasureEligibility(env, 't_1', 'user_target'),
    ).resolves.toBeUndefined()

    d1.database
      .prepare(`UPDATE memberships SET status = 'inactive' WHERE id = 'mem_replacement'`)
      .run()
    const deleteTarget = d1.prepare(
      `DELETE FROM memberships WHERE tenant_id = 't_1' AND user_id = 'user_target'`,
    )
    await expect(
      d1.batch([
        preparePrivacyErasureAtomicGuard(env, {
          requestId: 'prv_delete',
          tenantId: 't_1',
          userId: 'user_target',
        }),
        deleteTarget,
      ]),
    ).rejects.toThrow()
    expect(
      d1.database
        .prepare(`SELECT COUNT(*) AS value FROM memberships WHERE id = 'mem_target'`)
        .get(),
    ).toEqual({ value: 1 })

    d1.database
      .prepare(`UPDATE memberships SET status = 'active' WHERE id = 'mem_replacement'`)
      .run()
    await expect(
      d1.batch([
        preparePrivacyErasureAtomicGuard(env, {
          requestId: 'prv_delete',
          tenantId: 't_1',
          userId: 'user_target',
        }),
        d1.prepare(`DELETE FROM memberships WHERE tenant_id = 't_1' AND user_id = 'user_target'`),
      ]),
    ).resolves.toHaveLength(2)
    expect(
      d1.database
        .prepare(`SELECT COUNT(*) AS value FROM memberships WHERE id = 'mem_target'`)
        .get(),
    ).toEqual({ value: 0 })
  })
})
