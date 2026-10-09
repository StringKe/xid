// Console 管理接口测试共用夹具:node:sqlite 内存库 + 全量迁移链,数据经 createTenantDb 写入(真实租户谓词)。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import { Hono } from 'hono'
import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { SqliteD1 } from '../../../../../packages/db/src/__tests__/sqlite-d1'
import { isAppError } from '../../lib/errors'
import type { SessionData, XidHonoEnv } from '../../lib/types'

const migrationDir = fileURLToPath(new URL('../../../../../packages/db/drizzle/', import.meta.url))

export const TENANT_A: TenantContext = {
  tenantId: 't_a',
  issuer: 'https://acme.xid.dev',
  rpId: 'acme.xid.dev',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

export const TENANT_B: TenantContext = { ...TENANT_A, tenantId: 't_b', rpId: 'beta.xid.dev' }

export function makeDb(): SqliteD1 {
  const d1 = new SqliteD1()
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    d1.database.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
  return d1
}

export function tenantDb(d1: SqliteD1, tenant: TenantContext = TENANT_A) {
  return createTenantDb(d1 as unknown as D1Database, tenant)
}

export async function seedOrg(
  d1: SqliteD1,
  input: { id: string; tenant?: TenantContext; name?: string },
): Promise<void> {
  const tenant = input.tenant ?? TENANT_A
  await tenantDb(d1, tenant).organizations.insert({
    id: input.id,
    tenantId: tenant.tenantId,
    instanceId: 'inst_1',
    parentOrgId: input.id === tenant.tenantId ? null : tenant.tenantId,
    slug: input.id.replaceAll('_', '-'),
    name: input.name ?? input.id,
  })
}

export async function seedUser(
  d1: SqliteD1,
  input: {
    id: string
    tenant?: TenantContext
    email?: string
    phone?: string
    status?: string
    deleted?: boolean
    provisionedBy?: string
    externalId?: string
    firstName?: string
    createdAt?: Date
    lastLoginAt?: Date
  },
): Promise<void> {
  const tenant = input.tenant ?? TENANT_A
  const db = tenantDb(d1, tenant)
  const emailId = input.email ? `email_${input.id}` : null
  const phoneId = input.phone ? `phone_${input.id}` : null
  await db.users.insert({
    id: input.id,
    tenantId: tenant.tenantId,
    primaryEmailId: emailId,
    primaryPhoneId: phoneId,
    firstName: input.firstName ?? null,
    externalId: input.externalId ?? null,
    status: input.deleted ? 'deleted' : (input.status ?? 'active'),
    deletedAt: input.deleted ? new Date(5000) : null,
    provisionedBy: input.provisionedBy ?? null,
    lastLoginAt: input.lastLoginAt ?? null,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  })
  if (input.email && emailId) {
    await db.userEmails.insert({
      id: emailId,
      tenantId: tenant.tenantId,
      userId: input.id,
      email: input.email,
      verified: true,
      verificationStatus: 'verified',
      isPrimary: true,
    })
  }
  if (input.phone && phoneId) {
    await db.userPhones.insert({
      id: phoneId,
      tenantId: tenant.tenantId,
      userId: input.id,
      phone: input.phone,
      isPrimary: true,
    })
  }
}

export async function seedMembership(
  d1: SqliteD1,
  input: { id: string; userId: string; orgId: string; role?: string; tenant?: TenantContext },
): Promise<void> {
  const tenant = input.tenant ?? TENANT_A
  await tenantDb(d1, tenant).memberships.insert({
    id: input.id,
    tenantId: tenant.tenantId,
    orgId: input.orgId,
    userId: input.userId,
    role: (input.role ?? 'member') as 'member',
    joinedAt: new Date(1000),
  })
}

export async function seedApiKey(
  d1: SqliteD1,
  input: { id: string; scopes: string[]; tenant?: TenantContext },
): Promise<string> {
  const tenant = input.tenant ?? TENANT_A
  const token = `sk_live_${input.id}`
  await tenantDb(d1, tenant).apiKeys.insert({
    id: input.id,
    tenantId: tenant.tenantId,
    name: 'test',
    keyHash: await sha256Hex(token),
    keyPrefix: token.slice(0, 16),
    scopes: input.scopes,
  })
  return token
}

export function sessionFor(userId: string): SessionData {
  return {
    sessionId: `sess_${userId}`,
    userId,
    status: 'active',
    activeOrgId: null,
    authenticatedAt: new Date(0),
    lastActiveAt: new Date(0),
    expiresAt: new Date(Date.now() + 3_600_000),
    rememberMe: false,
    isImpersonation: false,
    impersonatorUserId: null,
    acr: null,
    amr: null,
    aal: 1,
  }
}

export function buildApp(
  register: (app: Hono<XidHonoEnv>) => void,
  options: { session?: SessionData | null; tenant?: TenantContext } = {},
): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError((err, c) => {
    if (isAppError(err)) {
      return c.json({ code: err.code, meta: err.meta ?? null }, err.httpStatus as 400)
    }
    return c.json({ code: 'server_error', message: String(err) }, 500)
  })
  app.use('*', async (c, next) => {
    c.set('tenant', options.tenant ?? TENANT_A)
    c.set('session', options.session ?? null)
    await next()
  })
  register(app)
  return app
}

export type FakeEnv = Env & {
  sessionRevocations: string[]
  auditSend: ReturnType<typeof vi.fn>
  emailSend: ReturnType<typeof vi.fn>
}

function makeMemoryKv(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  } as unknown as KVNamespace
}

export function envOf(d1: SqliteD1, options: { rateLimitAllowed?: boolean } = {}): FakeEnv {
  const sessionRevocations: string[] = []
  const auditSend = vi.fn().mockResolvedValue(undefined)
  const emailSend = vi.fn().mockResolvedValue(undefined)
  return {
    DB: d1 as unknown as D1Database,
    KEK: btoa('0'.repeat(32)),
    AUDIT_QUEUE: { send: auditSend },
    WEBHOOK_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    EMAIL_QUEUE: { send: emailSend },
    SCIM_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    CACHE: makeMemoryKv(),
    SESSION_REVOCATION: {
      idFromName: (name: string) => {
        sessionRevocations.push(name)
        return name
      },
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
    RATE_LIMITER: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({ allowed: options.rateLimitAllowed ?? true }),
      }),
    },
    sessionRevocations,
    auditSend,
    emailSend,
  } as unknown as FakeEnv
}

export async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T
}
