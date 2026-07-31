// organization-self 单元测试:顶级 Tenant 创建、owner membership 和 provisional user 原子迁移。

import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTenantDb } from '@xid-kit/db'
import { invitationAcceptContinuePath } from '../../auth/invitations'
import { emitWebhookAsync } from '../../v1/shared'
import { registerSessionAuthRoutes } from '../index'
import { buildTenantMigrationStatements } from '../organization-self'
import { execCtx, makeApp, makeEnv, makeSession, makeTenant, testErrorHandler } from './helpers'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    users: { id: 'id', status: 'status', isNewUser: 'isNewUser' },
    userEmails: { id: 'id', userId: 'userId', isPrimary: 'isPrimary' },
  },
}))

vi.mock('../../auth/invitations', () => ({
  invitationAcceptContinuePath: vi.fn(),
}))

vi.mock('../../v1/shared', () => ({
  emitWebhookAsync: vi.fn(),
}))

type BoundStatement = {
  sql: string
  params: unknown[]
  first: <T>() => Promise<T | null>
}

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

const openDatabases: SqliteD1[] = []

function makeOnboardingSqlite(): SqliteD1 {
  const d1 = new SqliteD1()
  openDatabases.push(d1)
  d1.database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      pending_email TEXT,
      is_new_user INTEGER NOT NULL,
      status TEXT NOT NULL,
      deleted_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      active_org_id TEXT
    );
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      parent_org_id TEXT,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      public_metadata TEXT NOT NULL,
      private_metadata TEXT NOT NULL,
      seat_limit INTEGER NOT NULL,
      enrollment_mode TEXT NOT NULL,
      allow_org_self_service INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE organization_quotas (
      tenant_id TEXT NOT NULL,
      quota_key TEXT NOT NULL,
      "limit" INTEGER NOT NULL,
      enforcement TEXT NOT NULL,
      updated_by TEXT,
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
      joined_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE manager_assignments (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE user_grants (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE authorization_codes (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE refresh_tokens (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE oauth_consents (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE saml_session_bindings (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE directory_users (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE access_token_issuances (tenant_id TEXT NOT NULL, subject TEXT NOT NULL);
    CREATE TABLE access_token_revocations (tenant_id TEXT NOT NULL, subject TEXT NOT NULL);
    CREATE TABLE user_emails (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT);
    CREATE TABLE user_phones (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE user_identities (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE gdpr_consents (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE passwords (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE password_history (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE password_reset_tokens (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE verification_tokens (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE passkey_credentials (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE mfa_factors (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE backup_codes (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE trusted_devices (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE metering_outbox (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE privacy_requests (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      request_type TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `)
  d1.database
    .prepare(
      `INSERT INTO users (
         id, tenant_id, pending_email, is_new_user, status, deleted_at, updated_at
       ) VALUES ('user-1', 'tenant-source', NULL, 1, 'active', NULL, 1)`,
    )
    .run()
  d1.database
    .prepare(
      `INSERT INTO sessions (id, tenant_id, user_id, status, active_org_id)
       VALUES ('session-1', 'tenant-source', 'user-1', 'active', NULL)`,
    )
    .run()
  return d1
}

function onboardingStatements(d1: SqliteD1): D1PreparedStatement[] {
  return buildTenantMigrationStatements({
    env: { DB: d1 as unknown as D1Database } as Env,
    sourceTenantId: 'tenant-source',
    targetTenantId: 'tenant-target',
    instanceId: 'instance-1',
    userId: 'user-1',
    sessionId: 'session-1',
    email: 'guest@example.com',
    pendingEmail: 'guest@example.com',
    slug: 'acme',
    name: 'Acme',
    membershipId: 'membership-1',
    nowMs: 2,
  })
}

function makeD1(
  options: {
    sourceValid?: boolean
    slugExists?: boolean
    claimChanges?: number
  } = {},
) {
  const { sourceValid = true, slugExists = false, claimChanges = 1 } = options
  const batches: BoundStatement[][] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            sql,
            params,
            async first<T>() {
              if (sql.includes('JOIN instances')) {
                return (
                  sourceValid
                    ? {
                        instanceMode: 'multi_tenant',
                        slug: 'default',
                        parentOrgId: null,
                        orgTenantId: 'tenant-source',
                      }
                    : null
                ) as T | null
              }
              if (sql.includes('WHERE instance_id = ?')) {
                return (slugExists ? { id: 'org-existing' } : null) as T | null
              }
              return null
            },
          }
        },
      }
    },
    async batch(statements: BoundStatement[]) {
      batches.push(statements)
      return statements.map((statement) => ({
        success: true,
        results: [],
        meta: {
          changes: statement.sql.startsWith('UPDATE users') ? claimChanges : 1,
        },
      }))
    },
  } as unknown as D1Database
  return { db, batches }
}

function mockUser(options: { email?: string; isNewUser?: boolean } = {}) {
  const email = options.email
  const userFindOne = vi.fn().mockResolvedValue({
    id: 'user-1',
    status: 'active',
    deletedAt: null,
    isNewUser: options.isNewUser ?? true,
    primaryEmailId: email ? 'email-1' : null,
  })
  const emailFindOne = vi.fn().mockResolvedValue(
    email
      ? {
          id: 'email-1',
          userId: 'user-1',
          email,
          isPrimary: true,
        }
      : null,
  )
  vi.mocked(createTenantDb).mockReturnValue({
    users: { findOne: userFindOne },
    userEmails: { findOne: emailFindOne },
  } as unknown as ReturnType<typeof createTenantDb>)
}

function tenant() {
  return {
    ...makeTenant('tenant-source', 'https://xid.dev'),
    instanceId: 'instance-1',
    issuer: 'https://xid.dev',
    rpId: 'xid.dev',
    resolution: { kind: 'tenant', primaryDomain: 'xid.dev' },
  }
}

function post(
  d1: D1Database,
  body: Record<string, unknown>,
  options: { rateLimitAllowed?: boolean } = {},
) {
  const app = makeApp(registerSessionAuthRoutes, {
    tenant: tenant() as never,
    session: makeSession('user-1', 'session-1'),
  })
  app.onError(testErrorHandler)
  return app.request(
    'https://xid.dev/v1/organizations/self',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { ...makeEnv(options), DB: d1 },
    execCtx,
  )
}

describe('POST /v1/organizations/self', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(invitationAcceptContinuePath).mockReturnValue('/console/org?orgId=new')
  })

  afterEach(() => {
    for (const database of openDatabases.splice(0)) database.close()
  })

  it('atomically blocks onboarding while privacy work is active, then migrates terminal history', async () => {
    const d1 = makeOnboardingSqlite()
    d1.database
      .prepare(
        `INSERT INTO privacy_requests (id, tenant_id, user_id, request_type, status)
         VALUES ('privacy-1', 'tenant-source', 'user-1', 'export', 'pending')`,
      )
      .run()

    const blocked = await d1.batch(onboardingStatements(d1))

    expect(blocked[0]?.meta.changes).toBe(0)
    expect(d1.database.prepare(`SELECT tenant_id FROM users WHERE id = 'user-1'`).get()).toEqual({
      tenant_id: 'tenant-source',
    })
    expect(d1.database.prepare(`SELECT COUNT(*) AS value FROM organizations`).get()).toEqual({
      value: 0,
    })
    expect(d1.database.prepare(`SELECT COUNT(*) AS value FROM memberships`).get()).toEqual({
      value: 0,
    })

    d1.database
      .prepare(`UPDATE privacy_requests SET status = 'completed' WHERE id = 'privacy-1'`)
      .run()
    const migrated = await d1.batch(onboardingStatements(d1))

    expect(migrated[0]?.meta.changes).toBe(1)
    expect(d1.database.prepare(`SELECT tenant_id FROM users WHERE id = 'user-1'`).get()).toEqual({
      tenant_id: 'tenant-target',
    })
    expect(
      d1.database.prepare(`SELECT tenant_id FROM privacy_requests WHERE id = 'privacy-1'`).get(),
    ).toEqual({ tenant_id: 'tenant-target' })
    expect(
      d1.database
        .prepare(`SELECT tenant_id, active_org_id FROM sessions WHERE id = 'session-1'`)
        .get(),
    ).toEqual({ tenant_id: 'tenant-target', active_org_id: 'tenant-target' })
  })

  it('guest Email 保持 pending，并原子创建顶级 Tenant 和 owner membership', async () => {
    mockUser()
    const { db, batches } = makeD1()
    const res = await post(db, {
      email: 'Guest@Example.com',
      name: 'Acme Corp',
      slug: 'Acme Corp!',
    })

    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      slug: 'acme-corp',
      name: 'Acme Corp',
      role: 'owner',
      redirectUrl: '/console/org?orgId=new',
    })
    const statements = batches[0]
    expect(statements).toBeDefined()
    const claimUser = statements?.[0]
    const createTenant = statements?.[1]
    const createSeatQuota = statements?.[2]
    const createMembership = statements?.[3]
    expect(claimUser?.params[1]).toBe('guest@example.com')
    expect(createTenant?.sql).toContain('INSERT INTO organizations')
    expect(createTenant?.params[0]).toBe(createTenant?.params[1])
    expect(createTenant?.params).toContain(10)
    expect(createSeatQuota?.sql).toContain('INSERT INTO organization_quotas')
    expect(createSeatQuota?.params.slice(0, 2)).toEqual([createTenant?.params[0], 10])
    expect(createMembership?.sql).toContain('INSERT INTO memberships')
    expect(createMembership?.params[1]).toBe(createMembership?.params[2])
    expect(emitWebhookAsync).toHaveBeenCalledTimes(2)
    expect(emitWebhookAsync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: createTenant?.params[0] }),
    )
  })

  it('既有 primary Email 必须匹配并随用户迁移，不写 pending Email', async () => {
    mockUser({ email: 'owner@example.com' })
    const { db, batches } = makeD1()
    const res = await post(db, {
      email: 'OWNER@example.com',
      name: 'Owner Org',
      slug: 'owner-org',
    })

    expect(res.status).toBe(201)
    expect(batches[0]?.[0]?.params[1]).toBeNull()
  })

  it('非 default staging Tenant 或已占用的 instance slug 被拒绝', async () => {
    mockUser()
    const invalidSource = makeD1({ sourceValid: false })
    const invalidSourceRes = await post(invalidSource.db, {
      email: 'guest@example.com',
      name: 'Acme',
      slug: 'acme',
    })
    expect(invalidSourceRes.status).toBe(409)

    const duplicate = makeD1({ slugExists: true })
    const duplicateRes = await post(duplicate.db, {
      email: 'guest@example.com',
      name: 'Acme',
      slug: 'acme',
    })
    expect(duplicateRes.status).toBe(409)
    expect((await duplicateRes.json()) as { meta?: { paramName?: string } }).toMatchObject({
      meta: { paramName: 'slug' },
    })
  })

  it('既有 primary Email 与表单不一致时拒绝', async () => {
    mockUser({ email: 'owner@example.com' })
    const { db, batches } = makeD1()
    const res = await post(db, {
      email: 'other@example.com',
      name: 'Acme',
      slug: 'acme',
    })

    expect(res.status).toBe(422)
    expect((await res.json()) as { meta?: { paramName?: string } }).toMatchObject({
      meta: { paramName: 'email' },
    })
    expect(batches).toHaveLength(0)
  })

  it('原子 eligibility claim 失败时不报告创建成功', async () => {
    mockUser()
    const { db } = makeD1({ claimChanges: 0 })
    const res = await post(db, {
      email: 'guest@example.com',
      name: 'Acme',
      slug: 'acme',
    })
    expect(res.status).toBe(409)
  })

  it('超过每日创建限流时返回 429', async () => {
    mockUser()
    const { db, batches } = makeD1()
    const res = await post(
      db,
      { email: 'guest@example.com', name: 'Acme', slug: 'acme' },
      { rateLimitAllowed: false },
    )
    expect(res.status).toBe(429)
    expect(batches).toHaveLength(0)
  })
})
