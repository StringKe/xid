import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { createTenantDb, schema } from '@xid-kit/db'
import { acceptInvitation } from '../invitations'

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
    const result = this.owner.database.prepare(this.sql).run(...this.bindings)
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as D1Result<unknown>
  }
}

class SqliteD1 {
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
}

function seed(d1: SqliteD1): void {
  d1.database.exec(`
    CREATE TABLE invitations (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      invited_by_user_id TEXT,
      accepted_by_user_id TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE memberships (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      membership_type TEXT NOT NULL,
      status TEXT NOT NULL,
      is_managed INTEGER NOT NULL,
      invited_by_user_id TEXT,
      joined_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (org_id, user_id)
    );
  `)
  const now = Date.now()
  d1.database
    .prepare(
      `INSERT INTO invitations (
         id, tenant_id, org_id, email, role, token_hash, used_count, status,
         invited_by_user_id, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?, ?)`,
    )
    .run(
      'invitation-1',
      'tenant-b',
      'org-b',
      'invitee@example.com',
      'admin',
      'token-hash',
      'inviter-1',
      now + 86_400_000,
      now,
      now,
    )
}

function invitation(d1: SqliteD1): typeof schema.invitations.$inferSelect {
  const row = d1.database
    .prepare('SELECT * FROM invitations WHERE id = ?')
    .get('invitation-1') as Record<string, unknown>
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    orgId: String(row['org_id']),
    email: String(row['email']),
    role: String(row['role']) as 'admin',
    tokenHash: String(row['token_hash']),
    tokenVersion: 'locator_v1',
    inviteType: 'email',
    maxUses: null,
    usedCount: Number(row['used_count']),
    status: String(row['status']),
    invitedByUserId: String(row['invited_by_user_id']),
    acceptedByUserId: null,
    expiresAt: new Date(Number(row['expires_at'])),
    createdAt: new Date(Number(row['created_at'])),
    updatedAt: new Date(Number(row['updated_at'])),
  }
}

function scopedDb(d1: SqliteD1): ReturnType<typeof createTenantDb> {
  return {
    forOrg: () => ({
      memberships: {
        findOne: async () => {
          const row = d1.database
            .prepare(
              `SELECT id, role, status
                 FROM memberships
                WHERE tenant_id = ? AND org_id = ? AND user_id = ?`,
            )
            .get('tenant-b', 'org-b', 'user-b') as Record<string, unknown> | undefined
          return row
            ? ({
                id: String(row['id']),
                role: String(row['role']),
                status: String(row['status']),
              } as never)
            : undefined
        },
      },
    }),
  } as unknown as ReturnType<typeof createTenantDb>
}

function env(d1: SqliteD1): Env {
  return {
    DB: d1 as unknown as D1Database,
    WEBHOOK_QUEUE: {
      send: async () => undefined,
    } as unknown as Queue,
  } as Env
}

function accept(d1: SqliteD1): ReturnType<typeof acceptInvitation> {
  return acceptInvitation({
    db: scopedDb(d1),
    env: env(d1),
    tenantId: 'tenant-b',
    invitation: invitation(d1),
    userId: 'user-b',
    userEmail: {
      email: 'invitee@example.com',
      verified: true,
      verificationStatus: 'verified',
    },
  })
}

describe('invitation acceptance transaction', () => {
  const databases: SqliteD1[] = []

  afterEach(() => {
    for (const d1 of databases.splice(0)) d1.database.close()
  })

  it('allows one concurrent winner without leaving loser membership or role writes', async () => {
    const d1 = new SqliteD1()
    databases.push(d1)
    seed(d1)

    const results = await Promise.allSettled([accept(d1), accept(d1)])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'invitation_invalid' },
    })
    expect(
      d1.database.prepare('SELECT COUNT(*) AS count FROM memberships').get() as Record<
        string,
        unknown
      >,
    ).toEqual({ count: 1 })
    expect(
      d1.database
        .prepare('SELECT role, status FROM memberships WHERE org_id = ? AND user_id = ?')
        .get('org-b', 'user-b'),
    ).toEqual({ role: 'admin', status: 'active' })
    expect(
      d1.database
        .prepare('SELECT status, used_count, accepted_by_user_id FROM invitations WHERE id = ?')
        .get('invitation-1'),
    ).toEqual({ status: 'accepted', used_count: 1, accepted_by_user_id: 'user-b' })
  })

  it('rolls back membership creation when invitation consume fails', async () => {
    const d1 = new SqliteD1()
    databases.push(d1)
    seed(d1)
    d1.failNext(/UPDATE invitations/)

    await expect(accept(d1)).rejects.toThrow('injected_d1_failure')
    expect(
      d1.database.prepare('SELECT COUNT(*) AS count FROM memberships').get() as Record<
        string,
        unknown
      >,
    ).toEqual({ count: 0 })
    expect(
      d1.database
        .prepare('SELECT status, used_count FROM invitations WHERE id = ?')
        .get('invitation-1'),
    ).toEqual({ status: 'pending', used_count: 0 })
  })

  it('rolls back an existing membership role change when invitation consume fails', async () => {
    const d1 = new SqliteD1()
    databases.push(d1)
    seed(d1)
    const now = Date.now()
    d1.database
      .prepare(
        `INSERT INTO memberships (
           id, tenant_id, org_id, user_id, role, membership_type, status, is_managed,
           joined_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'member', 'member', 'active', 0, ?, ?, ?)`,
      )
      .run('membership-existing', 'tenant-b', 'org-b', 'user-b', now, now, now)
    d1.failNext(/UPDATE invitations/)

    await expect(accept(d1)).rejects.toThrow('injected_d1_failure')
    expect(
      d1.database
        .prepare('SELECT role, status FROM memberships WHERE id = ?')
        .get('membership-existing'),
    ).toEqual({ role: 'member', status: 'active' })
    expect(
      d1.database
        .prepare('SELECT status, used_count FROM invitations WHERE id = ?')
        .get('invitation-1'),
    ).toEqual({ status: 'pending', used_count: 0 })
  })
})
