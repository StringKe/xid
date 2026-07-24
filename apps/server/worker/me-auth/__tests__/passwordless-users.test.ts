// passwordless-users 单元测试:默认 membership 跳过规则与用户创建路径。
import { describe, expect, it, vi } from 'vitest'
import { createTenantDb } from '@xid-kit/db'
import {
  createPasswordlessEmailUser,
  ensureDefaultMembership,
  shouldSkipDefaultMembership,
} from '../passwordless-users'

describe('shouldSkipDefaultMembership', () => {
  it('skips when invitation token, sign-up intent, OAuth redirect, or create-org path', () => {
    expect(shouldSkipDefaultMembership({ invitationToken: ' inv ' })).toBe(true)
    expect(shouldSkipDefaultMembership({ intent: 'sign-up' })).toBe(true)
    expect(
      shouldSkipDefaultMembership({ redirectAfterLogin: '/authorize?authz_request_id=abc' }),
    ).toBe(true)
    expect(shouldSkipDefaultMembership({ redirectAfterLogin: '/create-organization' })).toBe(true)
    expect(shouldSkipDefaultMembership({ redirectAfterLogin: '/create-organization?step=1' })).toBe(
      true,
    )
  })

  it('does not skip for ordinary login redirects', () => {
    expect(shouldSkipDefaultMembership({ redirectAfterLogin: '/account' })).toBe(false)
    expect(shouldSkipDefaultMembership({})).toBe(false)
  })
})

describe('ensureDefaultMembership', () => {
  it('inserts default org membership when not skipped', async () => {
    const insert = vi.fn().mockResolvedValue(undefined)
    const db = { memberships: { insert } } as unknown as ReturnType<typeof createTenantDb>
    await ensureDefaultMembership({ db, tenantId: 'tenant_1', userId: 'user_1' })
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        orgId: 'tenant_1',
        userId: 'user_1',
        role: 'member',
        status: 'active',
      }),
    )
  })

  it('no-ops when skip flag set', async () => {
    const insert = vi.fn()
    const db = { memberships: { insert } } as unknown as ReturnType<typeof createTenantDb>
    await ensureDefaultMembership({ db, tenantId: 'tenant_1', userId: 'user_1', skip: true })
    expect(insert).not.toHaveBeenCalled()
  })
})

describe('createPasswordlessEmailUser', () => {
  it('creates user, primary email, and default membership', async () => {
    const usersInsert = vi.fn().mockResolvedValue(undefined)
    const emailsInsert = vi.fn().mockResolvedValue(undefined)
    const membershipsInsert = vi.fn().mockResolvedValue(undefined)
    const db = {
      users: { insert: usersInsert },
      userEmails: { insert: emailsInsert },
      memberships: { insert: membershipsInsert },
    } as unknown as ReturnType<typeof createTenantDb>

    const userId = await createPasswordlessEmailUser({
      db,
      tenantId: 'tenant_1',
      email: 'user@example.com',
      profile: {
        email: 'user@example.com',
        username: null,
        phone: null,
        firstName: 'Ada',
        lastName: 'Lovelace',
        displayName: 'Ada Lovelace',
        profileCompletionStatus: 'complete',
      },
    })

    expect(userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(usersInsert).toHaveBeenCalled()
    expect(emailsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'user@example.com', isPrimary: true, verified: false }),
    )
    expect(membershipsInsert).toHaveBeenCalled()
  })
})
