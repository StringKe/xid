// me/shared 单元测试:session 守卫、ISO 格式化、指纹脱敏、primary email 与 membership 查询。
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { createTenantDb } from '@xid-kit/db'
import type { SessionData, TenantVar, XidHonoEnv } from '../../lib/types'
import {
  findActiveMembership,
  loadPrimaryEmail,
  maskFingerprint,
  requireSession,
  resolveActiveSession,
  resolveSession,
  toIso,
} from '../shared'
import { makeSession } from '../../me-auth/__tests__/helpers'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    userEmails: { id: 'id', userId: 'userId', isPrimary: 'isPrimary' },
    memberships: { userId: 'userId', orgId: 'orgId', status: 'status' },
  },
}))

function makeCtx(session: SessionData | null): Parameters<typeof requireSession>[0] {
  const app = new Hono<XidHonoEnv>()
  let ctx!: Parameters<typeof requireSession>[0]
  app.get('/probe', async (c) => {
    ctx = c
    return c.text('ok')
  })
  return {
    async get() {
      await app.request('https://test.xid.dev/probe', {}, {} as Env)
      ctx.set('tenant', { tenantId: 'tenant_1' } as TenantVar)
      ctx.set('session', session)
      return ctx
    },
  }
}

describe('toIso', () => {
  it('returns ISO string for Date and null otherwise', () => {
    const date = new Date('2026-06-19T12:00:00.000Z')
    expect(toIso(date)).toBe('2026-06-19T12:00:00.000Z')
    expect(toIso(null)).toBeNull()
    expect(toIso(undefined)).toBeNull()
  })
})

describe('maskFingerprint', () => {
  it('masks long hashes and passes through short values', () => {
    expect(maskFingerprint('abcdef1234567890')).toBe('abcdef12...')
    expect(maskFingerprint('short')).toBe('short')
    expect(maskFingerprint(null)).toBeNull()
  })
})

describe('resolveSession / requireSession', () => {
  it('resolveSession returns context session without throwing', async () => {
    const session = makeSession('user_1')
    const c = await makeCtx(session).get()
    await expect(resolveSession(c)).resolves.toBe(session)
  })

  it('resolveActiveSession ignores context pending MFA session', async () => {
    const c = await makeCtx({ ...makeSession('user_1'), status: 'pending_mfa' }).get()
    await expect(resolveActiveSession(c)).resolves.toBeNull()
  })

  it('requireSession throws unauthorized when session missing', async () => {
    const c = await makeCtx(null).get()
    await expect(requireSession(c)).rejects.toMatchObject({
      code: 'unauthorized',
      httpStatus: 401,
    })
  })

  it('requireSession throws unauthorized for pending MFA session', async () => {
    const c = await makeCtx({ ...makeSession('user_1'), status: 'pending_mfa' }).get()
    await expect(requireSession(c)).rejects.toMatchObject({
      code: 'unauthorized',
      httpStatus: 401,
    })
  })
})

describe('loadPrimaryEmail', () => {
  it('loads row by primaryEmailId when present', async () => {
    const findOne = vi.fn().mockResolvedValue({ email: 'primary@example.com', verified: true })
    vi.mocked(createTenantDb).mockReturnValue({
      userEmails: { findOne, findMany: vi.fn() },
    } as unknown as ReturnType<typeof createTenantDb>)
    const c = await makeCtx(makeSession()).get()
    const result = await loadPrimaryEmail(c, 'user_1', 'email_row_1')
    expect(result).toEqual({ email: 'primary@example.com', verified: true })
    expect(findOne).toHaveBeenCalled()
  })

  it('falls back to first primary or first email row', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { email: 'primary@example.com', verified: true, isPrimary: true },
      { email: 'secondary@example.com', verified: false, isPrimary: false },
    ])
    vi.mocked(createTenantDb).mockReturnValue({
      userEmails: { findOne: vi.fn(), findMany },
    } as unknown as ReturnType<typeof createTenantDb>)
    const c = await makeCtx(makeSession()).get()
    const result = await loadPrimaryEmail(c, 'user_1', null)
    expect(result).toEqual({ email: 'primary@example.com', verified: true })
  })
})

describe('findActiveMembership', () => {
  it('queries active membership for user and org', async () => {
    const membership = { id: 'mem_1', userId: 'user_1', orgId: 'org_1', status: 'active' }
    const findOne = vi.fn().mockResolvedValue(membership)
    vi.mocked(createTenantDb).mockReturnValue({
      memberships: { findOne },
    } as unknown as ReturnType<typeof createTenantDb>)
    const c = await makeCtx(makeSession()).get()
    await expect(findActiveMembership(c, 'user_1', 'org_1')).resolves.toBe(membership)
    expect(findOne).toHaveBeenCalled()
  })
})
