// invitation-accept 单元测试:预览与已登录接受流程。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createTenantDb } from '@xid-kit/db'
import {
  acceptInvitationByToken,
  invitationAcceptContinuePath,
  loadInvitationPreview,
  loadPrimaryEmailForUserId,
} from '../../auth/invitations'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeSession, makeTenant, testErrorHandler } from './helpers'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    users: { id: 'id' },
    organizations: { id: 'id' },
    sessions: { id: 'id', userId: 'userId', status: 'status' },
  },
}))

vi.mock('../../auth/invitations', () => ({
  loadInvitationPreview: vi.fn(),
  acceptInvitationByToken: vi.fn(),
  loadPrimaryEmailForUserId: vi.fn(),
  invitationAcceptContinuePath: vi.fn(),
}))

import { handleInvitationPreview } from '../invitation-accept'

function mockDb() {
  const usersFindOne = vi.fn().mockResolvedValue({ id: 'user_1', primaryEmailId: 'email_1' })
  const orgFindOne = vi.fn().mockResolvedValue({ id: 'org_1', name: 'Acme', slug: 'acme' })
  const sessionsUpdate = vi.fn().mockResolvedValue(undefined)
  vi.mocked(createTenantDb).mockReturnValue({
    users: { findOne: usersFindOne },
    organizations: { findOne: orgFindOne },
    sessions: { update: sessionsUpdate },
  } as unknown as ReturnType<typeof createTenantDb>)
  return { usersFindOne, orgFindOne, sessionsUpdate }
}

describe('handleInvitationPreview', () => {
  it('returns invitation preview JSON for token query', async () => {
    vi.mocked(loadInvitationPreview).mockResolvedValue({
      status: 'pending',
      orgName: 'Acme',
      email: 'invitee@example.com',
    })
    const app = makeApp((hon) => {
      hon.get('/auth/invitation/preview', handleInvitationPreview)
    })
    const res = await app.request(
      'https://test.xid.dev/auth/invitation/preview?token=raw-token',
      {},
      makeEnv(),
      execCtx,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'pending',
      orgName: 'Acme',
      email: 'invitee@example.com',
    })
    expect(loadInvitationPreview).toHaveBeenCalled()
  })
})

describe('POST /auth/invitation/accept', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadPrimaryEmailForUserId).mockResolvedValue('invitee@example.com')
    vi.mocked(acceptInvitationByToken).mockResolvedValue({ orgId: 'org_1', role: 'member' })
    vi.mocked(invitationAcceptContinuePath).mockReturnValue('/org/acme')
  })

  it('accepts invitation for authenticated user and updates active org', async () => {
    const { sessionsUpdate } = mockDb()
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: makeTenant() as never,
      session: makeSession('user_1'),
    })
    app.onError(testErrorHandler)
    const res = await app.request(
      'https://test.xid.dev/auth/invitation/accept',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'invite-token' }),
      },
      makeEnv(),
      execCtx,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { orgId: string; role: string; redirectUrl: string }
    expect(body).toEqual({ orgId: 'org_1', role: 'member', redirectUrl: '/org/acme' })
    expect(sessionsUpdate).toHaveBeenCalled()
    expect(acceptInvitationByToken).toHaveBeenCalledWith(
      expect.objectContaining({
        rawToken: 'invite-token',
        userId: 'user_1',
        userEmail: 'invitee@example.com',
      }),
    )
  })

  it('returns 422 when token missing', async () => {
    mockDb()
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession('user_1') })
    app.onError(testErrorHandler)
    const res = await app.request(
      'https://test.xid.dev/auth/invitation/accept',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
      makeEnv(),
      execCtx,
    )
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string; meta?: { paramName?: string } }
    expect(body.code).toBe('validation_failed')
    expect(body.meta?.paramName).toBe('token')
  })
})
