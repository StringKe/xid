import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { provisionAccountAtomically, type AccountProvisioningInput } from '../account-provisioning'

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
    const bindings = this.bindings.map((value) =>
      value instanceof ArrayBuffer ? new Uint8Array(value) : value,
    )
    if (this.sql.trimStart().toLowerCase().startsWith('select')) {
      return {
        success: true,
        results: statement.all(...bindings),
        meta: { changes: 0 },
      } as D1Result<unknown>
    }
    const result = statement.run(...bindings)
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as D1Result<unknown>
  }

  async first<T>(): Promise<T | null> {
    this.owner.maybeFail(this.sql)
    return (this.owner.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null
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

const databases: SqliteD1[] = []

function makeD1(): SqliteD1 {
  const d1 = new SqliteD1()
  databases.push(d1)
  d1.database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      username TEXT,
      external_id TEXT,
      primary_email_id TEXT,
      primary_phone_id TEXT,
      first_name TEXT,
      last_name TEXT,
      display_name TEXT,
      status TEXT NOT NULL,
      is_new_user INTEGER NOT NULL,
      profile_completion_status TEXT NOT NULL,
      provisioned_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE user_emails (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      verified INTEGER NOT NULL,
      verification_status TEXT NOT NULL,
      is_primary INTEGER NOT NULL,
      verified_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (tenant_id, email)
    );
    CREATE TABLE user_phones (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      verified INTEGER NOT NULL,
      verification_status TEXT NOT NULL,
      is_primary INTEGER NOT NULL,
      verified_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (tenant_id, phone)
    );
    CREATE TABLE passwords (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL UNIQUE,
      hash TEXT NOT NULL,
      algo TEXT NOT NULL,
      pepper_version INTEGER NOT NULL,
      reuse_tag TEXT,
      breached INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE user_identities (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      identity_type TEXT NOT NULL,
      provider TEXT,
      provider_user_id TEXT,
      access_token_ciphertext BLOB,
      refresh_token_ciphertext BLOB,
      scopes TEXT,
      profile_raw TEXT,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (tenant_id, provider, provider_user_id)
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
      joined_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (org_id, user_id)
    );
  `)
  return d1
}

function passwordInput(d1: SqliteD1): AccountProvisioningInput {
  return {
    d1: d1 as unknown as D1Database,
    tenantId: 'tenant-a',
    user: {
      id: 'user_AAAAAAAAAAAAAAAAAAAAA',
      username: 'ada',
      externalId: null,
      primaryEmailId: 'email-1',
      primaryPhoneId: 'phone-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      displayName: 'Ada Lovelace',
      profileCompletionStatus: 'complete',
      provisionedBy: 'hosted_password',
      isNewUser: true,
    },
    primaryEmail: {
      id: 'email-1',
      email: 'ada@example.com',
      verified: false,
      verificationStatus: 'unverified',
    },
    primaryPhone: {
      id: 'phone-1',
      phone: '+15555550100',
      verified: false,
      verificationStatus: 'unverified',
    },
    password: {
      id: 'password-1',
      hash: '$argon2id$test',
      algo: 'argon2id',
      pepperVersion: 1,
      reuseTag: 'reuse-tag',
    },
    defaultMembership: {
      id: 'mem_AAAAAAAAAAAAAAAAAAAAA',
      orgId: 'tenant-a',
    },
    now: new Date(1_000),
  }
}

function socialInput(d1: SqliteD1): AccountProvisioningInput {
  return {
    d1: d1 as unknown as D1Database,
    tenantId: 'tenant-a',
    user: {
      id: 'user_BBBBBBBBBBBBBBBBBBBBB',
      username: null,
      externalId: 'external-1',
      primaryEmailId: 'email-social',
      primaryPhoneId: null,
      firstName: 'Grace',
      lastName: 'Hopper',
      displayName: 'Grace Hopper',
      profileCompletionStatus: 'incomplete',
      provisionedBy: null,
      isNewUser: true,
    },
    primaryEmail: {
      id: 'email-social',
      email: 'grace@example.com',
      verified: true,
      verificationStatus: 'verified',
      verifiedAt: new Date(900),
    },
    socialIdentity: {
      id: 'idn_AAAAAAAAAAAAAAAAAAAAA',
      provider: 'github',
      providerUserId: 'github-123',
      accessTokenCiphertext: new Uint8Array([1, 2, 3]),
      refreshTokenCiphertext: null,
      scopes: ['read:user'],
      profileRaw: { login: 'grace' },
      lastUsedAt: new Date(1_000),
    },
    defaultMembership: null,
    now: new Date(1_000),
  }
}

function tableCount(d1: SqliteD1, table: string): number {
  const row = d1.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number
  }
  return row.count
}

afterEach(() => {
  for (const d1 of databases.splice(0)) d1.database.close()
})

describe('provisionAccountAtomically', () => {
  it('creates the password account graph once and accepts an exact replay', async () => {
    const d1 = makeD1()
    const input = passwordInput(d1)

    await provisionAccountAtomically(input)
    await provisionAccountAtomically(input)

    expect(tableCount(d1, 'users')).toBe(1)
    expect(tableCount(d1, 'user_emails')).toBe(1)
    expect(tableCount(d1, 'user_phones')).toBe(1)
    expect(tableCount(d1, 'passwords')).toBe(1)
    expect(tableCount(d1, 'memberships')).toBe(1)
  })

  it.each([
    /INSERT INTO users/,
    /INSERT INTO user_emails/,
    /INSERT INTO user_phones/,
    /INSERT INTO passwords/,
    /INSERT INTO memberships/,
  ])('rolls back the complete password account graph when %s fails', async (pattern) => {
    const d1 = makeD1()
    d1.failNext(pattern)

    await expect(provisionAccountAtomically(passwordInput(d1))).rejects.toMatchObject({
      code: 'server_error',
      cause: expect.objectContaining({ message: 'injected_d1_failure' }),
    })

    for (const table of ['users', 'user_emails', 'user_phones', 'passwords', 'memberships']) {
      expect(tableCount(d1, table)).toBe(0)
    }
  })

  it('rolls back user, contact, and social identity together', async () => {
    const d1 = makeD1()
    d1.failNext(/INSERT INTO user_identities/)

    await expect(provisionAccountAtomically(socialInput(d1))).rejects.toMatchObject({
      code: 'server_error',
      cause: expect.objectContaining({ message: 'injected_d1_failure' }),
    })

    expect(tableCount(d1, 'users')).toBe(0)
    expect(tableCount(d1, 'user_emails')).toBe(0)
    expect(tableCount(d1, 'user_identities')).toBe(0)
  })

  it('does not create a default membership when product onboarding skips it', async () => {
    const d1 = makeD1()

    await provisionAccountAtomically(socialInput(d1))

    expect(tableCount(d1, 'users')).toBe(1)
    expect(tableCount(d1, 'user_identities')).toBe(1)
    expect(tableCount(d1, 'memberships')).toBe(0)
  })

  it('does not attach account artifacts to the same user id in another tenant', async () => {
    const d1 = makeD1()
    const input = passwordInput(d1)
    d1.database
      .prepare(
        `INSERT INTO users (
           id, tenant_id, username, external_id, primary_email_id, primary_phone_id,
           first_name, last_name, display_name, status, is_new_user,
           profile_completion_status, provisioned_by, created_at, updated_at
         ) VALUES (?, 'tenant-b', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                   'active', 1, 'incomplete', NULL, 1, 1)`,
      )
      .run(input.user.id)

    await expect(provisionAccountAtomically(input)).rejects.toThrow()

    expect(tableCount(d1, 'users')).toBe(1)
    expect(tableCount(d1, 'user_emails')).toBe(0)
    expect(tableCount(d1, 'passwords')).toBe(0)
    expect(tableCount(d1, 'memberships')).toBe(0)
  })

  it('rejects a default membership outside the explicit tenant scope', async () => {
    const d1 = makeD1()
    const input = passwordInput(d1)
    input.defaultMembership = {
      id: 'mem_BBBBBBBBBBBBBBBBBBBBB',
      orgId: 'tenant-b',
    }

    await expect(provisionAccountAtomically(input)).rejects.toMatchObject({
      code: 'server_error',
    })
    expect(tableCount(d1, 'users')).toBe(0)
    expect(tableCount(d1, 'memberships')).toBe(0)
  })

  it('rejects a primary contact that is not the user primary id', async () => {
    const d1 = makeD1()
    const input = passwordInput(d1)
    input.user.primaryEmailId = 'different-email'

    await expect(provisionAccountAtomically(input)).rejects.toMatchObject({
      code: 'server_error',
    })
    expect(tableCount(d1, 'users')).toBe(0)
    expect(tableCount(d1, 'user_emails')).toBe(0)
  })
})
