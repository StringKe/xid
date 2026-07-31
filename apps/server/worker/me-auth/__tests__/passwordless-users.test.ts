// passwordless-users 单元测试:默认 membership 跳过规则与用户创建路径。
import { describe, expect, it, vi } from 'vitest'
import { createTenantDb } from '@xid-kit/db'
import {
  createPasswordlessEmailUser,
  createPasswordlessPhoneUser,
  shouldSkipDefaultMembership,
} from '../passwordless-users'

vi.mock('../../auth/account-provisioning', () => ({
  provisionAccountAtomically: vi.fn(async (input: { user: { id: string } }) => input.user.id),
}))

import { provisionAccountAtomically } from '../../auth/account-provisioning'

describe('shouldSkipDefaultMembership', () => {
  it('skips for invitation and product onboarding, but not Application authorization', () => {
    expect(shouldSkipDefaultMembership({ invitationToken: ' inv ' })).toBe(true)
    expect(shouldSkipDefaultMembership({ intent: 'sign-up' })).toBe(true)
    expect(
      shouldSkipDefaultMembership({ redirectAfterLogin: '/authorize?authz_request_id=abc' }),
    ).toBe(false)
    expect(shouldSkipDefaultMembership({ intent: 'application-sign-up' })).toBe(false)
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

describe('createPasswordlessEmailUser', () => {
  it('provisions user, primary email, optional phone, and default membership atomically', async () => {
    const db = {} as ReturnType<typeof createTenantDb>
    const d1 = {} as D1Database

    const userId = await createPasswordlessEmailUser({
      d1,
      db,
      tenantId: 'tenant_1',
      email: 'user@example.com',
      profile: {
        email: 'user@example.com',
        username: null,
        phone: '+15555550100',
        firstName: 'Ada',
        lastName: 'Lovelace',
        displayName: 'Ada Lovelace',
        profileCompletionStatus: 'complete',
      },
    })

    expect(userId).toMatch(/^user_[A-Za-z0-9]{21}$/)
    expect(provisionAccountAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        d1,
        tenantId: 'tenant_1',
        user: expect.objectContaining({
          id: userId,
          primaryEmailId: expect.any(String),
          primaryPhoneId: expect.any(String),
          provisionedBy: 'hosted_passwordless',
        }),
        primaryEmail: expect.objectContaining({
          email: 'user@example.com',
          verified: false,
        }),
        primaryPhone: expect.objectContaining({ phone: '+15555550100', verified: false }),
        defaultMembership: expect.objectContaining({
          id: expect.stringMatching(/^mem_[A-Za-z0-9]{21}$/),
          orgId: 'tenant_1',
        }),
      }),
    )
  })

  it('provisions a phone-first account without a membership for product onboarding', async () => {
    const db = {} as ReturnType<typeof createTenantDb>
    const d1 = {} as D1Database

    const userId = await createPasswordlessPhoneUser({
      d1,
      db,
      tenantId: 'tenant_1',
      phone: '+15555550100',
      skipDefaultMembership: true,
    })

    expect(provisionAccountAtomically).toHaveBeenLastCalledWith(
      expect.objectContaining({
        d1,
        tenantId: 'tenant_1',
        user: expect.objectContaining({ id: userId, primaryPhoneId: expect.any(String) }),
        primaryEmail: null,
        primaryPhone: expect.objectContaining({ phone: '+15555550100' }),
        defaultMembership: null,
      }),
    )
  })
})
