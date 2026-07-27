// organization-self 单元测试:顶级 Tenant 创建、owner membership 和 provisional user 原子迁移。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTenantDb } from '@xid-kit/db'
import { invitationAcceptContinuePath } from '../../auth/invitations'
import { emitWebhookAsync } from '../../v1/shared'
import { registerSessionAuthRoutes } from '../index'
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
    const createMembership = statements?.[2]
    expect(claimUser?.params[1]).toBe('guest@example.com')
    expect(createTenant?.sql).toContain('INSERT INTO organizations')
    expect(createTenant?.params[0]).toBe(createTenant?.params[1])
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
