// organization-self 单元测试:已登录用户自助创建组织。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createTenantDb } from '@xid-kit/db'
import { invitationAcceptContinuePath } from '../../auth/invitations'
import { emitWebhookAsync } from '../../v1/shared'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeSession, testErrorHandler } from './helpers'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    organizations: { slug: 'slug', id: 'id', status: 'status' },
    sessions: { id: 'id', userId: 'userId', status: 'status' },
  },
}))

vi.mock('../../auth/invitations', () => ({
  invitationAcceptContinuePath: vi.fn(),
}))

vi.mock('../../v1/shared', () => ({
  emitWebhookAsync: vi.fn(),
}))

function mockDb(options: { existingSlug?: boolean } = {}) {
  const orgInsert = vi.fn().mockResolvedValue({
    id: 'org_new',
    slug: 'acme-corp',
    name: 'Acme Corp',
  })
  const orgFindOne = vi
    .fn()
    .mockResolvedValue(options.existingSlug ? { id: 'org_old', status: 'active' } : null)
  const membershipInsert = vi.fn().mockResolvedValue(undefined)
  const sessionsUpdate = vi.fn().mockResolvedValue(undefined)
  vi.mocked(createTenantDb).mockReturnValue({
    organizations: { findOne: orgFindOne, insert: orgInsert },
    forOrg: () => ({ memberships: { insert: membershipInsert } }),
    sessions: { update: sessionsUpdate },
  } as unknown as ReturnType<typeof createTenantDb>)
  return { orgInsert, membershipInsert, sessionsUpdate }
}

describe('POST /v1/organizations/self', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(invitationAcceptContinuePath).mockReturnValue('/org/acme-corp')
  })

  it('creates organization, owner membership, and switches active org', async () => {
    const { orgInsert, membershipInsert, sessionsUpdate } = mockDb()
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession('user_1') })
    app.onError(testErrorHandler)
    const res = await app.request(
      'https://test.xid.dev/v1/organizations/self',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme Corp', slug: 'Acme Corp!' }),
      },
      makeEnv(),
      execCtx,
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      slug: string
      name: string
      role: string
      redirectUrl: string
    }
    expect(body.slug).toBe('acme-corp')
    expect(body.name).toBe('Acme Corp')
    expect(body.role).toBe('owner')
    expect(body.redirectUrl).toBe('/org/acme-corp')
    expect(orgInsert).toHaveBeenCalled()
    expect(membershipInsert).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'owner', userId: 'user_1' }),
    )
    expect(sessionsUpdate).toHaveBeenCalled()
    expect(emitWebhookAsync).toHaveBeenCalledTimes(2)
  })

  it('returns 429 when user exceeds 10/day org creation rate limit', async () => {
    const { orgInsert } = mockDb()
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession('user_1') })
    app.onError(testErrorHandler)
    const res = await app.request(
      'https://test.xid.dev/v1/organizations/self',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      },
      makeEnv({ rateLimitAllowed: false }),
      execCtx,
    )
    expect(res.status).toBe(429)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'rate_limited' })
    expect(orgInsert).not.toHaveBeenCalled()
  })

  it('returns 409 when slug already taken', async () => {
    mockDb({ existingSlug: true })
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession('user_1') })
    app.onError(testErrorHandler)
    const res = await app.request(
      'https://test.xid.dev/v1/organizations/self',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      },
      makeEnv(),
      execCtx,
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; meta?: { paramName?: string } }
    expect(body.code).toBe('already_exists')
    expect(body.meta?.paramName).toBe('slug')
  })

  it('returns 422 when name or slug missing after normalization', async () => {
    mockDb()
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession('user_1') })
    app.onError(testErrorHandler)
    const res = await app.request(
      'https://test.xid.dev/v1/organizations/self',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      },
      makeEnv(),
      execCtx,
    )
    expect(res.status).toBe(422)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'validation_failed' })
  })
})
