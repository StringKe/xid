// Invitation surface contract: raw-token preview stays readable; a signed-in account whose verified
// primary email matches accepts directly instead of an Email claim creating a second identity.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTenantDb } from '@xid-kit/db'
import {
  acceptInvitation,
  findInvitationByRawToken,
  invitationAcceptContinuePath,
  loadInvitationPreview,
  resolveInvitationTenant,
} from '../../auth/invitations'
import { AppError } from '../../lib/errors'
import { createTenantBoundInvitationToken } from '../../lib/invitation-token'
import { readSessionForTenant } from '../../lib/session'
import { handleInvitationAccept, handleInvitationPreview } from '../invitation-accept'
import { requireActiveClaimOrganization, resolveClaimTargetTenant } from '../invitation-claim-state'
import { execCtx, makeApp, makeEnv, makeSession, makeTenant } from './helpers'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    users: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
    userEmails: { userId: 'userId', email: 'email' },
    sessions: { id: 'id', userId: 'userId' },
    organizations: { id: 'id' },
  },
}))

vi.mock('../../auth/invitations', () => ({
  acceptInvitation: vi.fn(),
  findInvitationByRawToken: vi.fn(),
  invitationAcceptContinuePath: vi.fn(),
  loadInvitationPreview: vi.fn(),
  resolveInvitationTenant: vi.fn(),
}))

vi.mock('../../lib/session', () => ({
  readSessionForTenant: vi.fn(),
}))

vi.mock('../invitation-claim-state', () => ({
  emitInvitationClaimAudit: vi.fn(),
  requireActiveClaimOrganization: vi.fn(),
  resolveClaimTargetTenant: vi.fn(),
}))

vi.mock('../../auth/hosted-policy', () => ({
  assertEmailAllowed: vi.fn(),
}))

function registerLegacyInvitationRoutes(
  app: Parameters<typeof makeApp>[0] extends (app: infer T) => void ? T : never,
) {
  app.get('/auth/invitation/preview', handleInvitationPreview)
  app.post('/auth/invitation/accept', handleInvitationAccept)
}

describe('handleInvitationPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveInvitationTenant).mockResolvedValue(makeTenant() as never)
    vi.mocked(createTenantDb).mockReturnValue({} as ReturnType<typeof createTenantDb>)
  })

  it('returns invitation preview JSON for token query', async () => {
    vi.mocked(loadInvitationPreview).mockResolvedValue({
      status: 'pending',
      orgName: 'Acme',
      email: 'invitee@example.com',
    })
    const app = makeApp(registerLegacyInvitationRoutes)
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

  it('forwards an expired raw-token preview without enabling acceptance', async () => {
    vi.mocked(loadInvitationPreview).mockResolvedValue({
      status: 'expired',
      orgId: 'org-1',
      orgName: 'Acme',
      email: 'invitee@example.com',
      role: 'member',
      expiresAt: '2026-07-01T00:00:00.000Z',
    })
    const app = makeApp(registerLegacyInvitationRoutes)

    const res = await app.request(
      'https://xid.dev/auth/invitation/preview?token=expired-token',
      {},
      makeEnv(),
      execCtx,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      status: 'expired',
      email: 'invitee@example.com',
      orgId: 'org-1',
    })
    expect(loadInvitationPreview).toHaveBeenCalledWith(expect.anything(), 'expired-token')
  })

  it('forwards an invalid raw-token preview from the scoped loader', async () => {
    vi.mocked(loadInvitationPreview).mockResolvedValue({
      status: 'invalid',
      email: null,
      orgId: null,
      orgName: null,
      role: null,
      expiresAt: null,
    })
    const app = makeApp(registerLegacyInvitationRoutes)

    const res = await app.request(
      'https://xid.dev/auth/invitation/preview?token=already-used-token',
      {},
      makeEnv(),
      execCtx,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'invalid',
      email: null,
      orgId: null,
      orgName: null,
      role: null,
      expiresAt: null,
    })
  })

  it('returns an opaque invalid preview when the shared Tenant resolver rejects the token', async () => {
    vi.mocked(resolveInvitationTenant).mockResolvedValue(null)
    const app = makeApp(registerLegacyInvitationRoutes)

    const res = await app.request(
      'https://xid.dev/auth/invitation/preview?token=unbound-token',
      {},
      makeEnv(),
      execCtx,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'invalid',
      email: null,
      orgId: null,
      orgName: null,
      role: null,
      expiresAt: null,
    })
    expect(loadInvitationPreview).not.toHaveBeenCalled()
  })

  it('restores a non-default Tenant from a bound token before the scoped preview lookup', async () => {
    const target = makeTenant('tenant-invite')
    vi.mocked(resolveInvitationTenant).mockResolvedValue(target as never)
    vi.mocked(loadInvitationPreview).mockResolvedValue({
      status: 'pending',
      orgId: 'tenant-invite',
      orgName: 'Invited Tenant',
      email: 'invitee@example.com',
      role: 'member',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })
    const root = {
      ...makeTenant('default'),
      issuer: 'https://xid.dev',
      rpId: 'xid.dev',
      resolution: {
        kind: 'instance_entry' as const,
        primaryDomain: 'xid.dev',
        unresolvedRoot: true,
      },
    }
    const token = createTenantBoundInvitationToken('tenant-invite')
    const app = makeApp(registerLegacyInvitationRoutes, { tenant: root as never })

    const env = makeEnv()
    const res = await app.request(
      `https://xid.dev/auth/invitation/preview?token=${encodeURIComponent(token)}`,
      {},
      env,
      execCtx,
    )

    expect(res.status).toBe(200)
    expect(resolveInvitationTenant).toHaveBeenCalledWith(expect.anything(), token)
    expect(createTenantDb).toHaveBeenCalledWith(env.DB, target)
    expect(loadInvitationPreview).toHaveBeenCalledWith(expect.anything(), token)
  })

  it('treats a legacy continuation-only preview as opaque invalid', async () => {
    vi.mocked(resolveInvitationTenant).mockResolvedValue(null)
    const app = makeApp(registerLegacyInvitationRoutes)

    const res = await app.request(
      'https://xid.dev/auth/invitation/preview?continuation_token=signed-continuation',
      {},
      makeEnv(),
      execCtx,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'invalid',
      email: null,
      orgId: null,
      orgName: null,
      role: null,
      expiresAt: null,
    })
    expect(resolveInvitationTenant).toHaveBeenCalledWith(expect.anything(), '')
    expect(createTenantDb).not.toHaveBeenCalled()
    expect(loadInvitationPreview).not.toHaveBeenCalled()
  })
})

describe('POST /auth/invitation/accept', () => {
  const invitation = { id: 'inv-1', orgId: 'org-1', email: 'ada@example.com', role: 'member' }
  const sessionsUpdate = vi.fn()
  const userEmailsFindOne = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    userEmailsFindOne.mockResolvedValue({
      email: 'ada@example.com',
      verified: true,
      verificationStatus: 'verified',
    })
    vi.mocked(resolveInvitationTenant).mockResolvedValue(makeTenant() as never)
    vi.mocked(readSessionForTenant).mockResolvedValue(makeSession() as never)
    vi.mocked(findInvitationByRawToken).mockResolvedValue(invitation as never)
    vi.mocked(acceptInvitation).mockResolvedValue({
      orgId: 'org-1',
      membershipId: 'mem-1',
      role: 'member',
    })
    vi.mocked(invitationAcceptContinuePath).mockReturnValue('/account')
    vi.mocked(resolveClaimTargetTenant).mockResolvedValue(makeTenant() as never)
    vi.mocked(requireActiveClaimOrganization).mockResolvedValue({
      id: 'org-1',
      name: 'Acme',
    } as never)
    sessionsUpdate.mockResolvedValue([{ id: 'sess-1' }])
    vi.mocked(createTenantDb).mockReturnValue({
      users: { findOne: vi.fn().mockResolvedValue({ id: 'user-1', primaryEmailId: 'em-1' }) },
      userEmails: { findOne: userEmailsFindOne },
      sessions: { update: sessionsUpdate },
    } as unknown as ReturnType<typeof createTenantDb>)
  })

  function accept(body: unknown): Promise<Response> {
    const app = makeApp(registerLegacyInvitationRoutes)
    return Promise.resolve(
      app.request(
        'https://xid.dev/auth/invitation/accept',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        makeEnv(),
        execCtx,
      ),
    )
  }

  it('adds the signed-in account to the organization and activates it', async () => {
    const res = await accept({ token: 'invite-token' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ redirectUrl: '/account' })
    expect(acceptInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        invitation,
        userEmail: expect.objectContaining({ email: 'ada@example.com', verified: true }),
      }),
    )
    expect(sessionsUpdate).toHaveBeenCalledWith({ activeOrgId: 'org-1' }, expect.anything())
  })

  it('requires a signed-in session in the invitation tenant', async () => {
    vi.mocked(readSessionForTenant).mockResolvedValue(null)

    const res = await accept({ token: 'invite-token' })

    expect(res.status).toBe(401)
    expect(acceptInvitation).not.toHaveBeenCalled()
  })

  it('rejects an impersonation session', async () => {
    vi.mocked(readSessionForTenant).mockResolvedValue({
      ...makeSession(),
      isImpersonation: true,
    } as never)

    const res = await accept({ token: 'invite-token' })

    expect(res.status).toBe(403)
    expect(acceptInvitation).not.toHaveBeenCalled()
  })

  it('returns an opaque invalid result for a token outside every reachable tenant', async () => {
    vi.mocked(resolveInvitationTenant).mockResolvedValue(null)

    const res = await accept({ token: 'cross-tenant-token' })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invitation_invalid' })
    expect(readSessionForTenant).not.toHaveBeenCalled()
  })

  it('rejects an invitation into a suspended or deleted organization', async () => {
    vi.mocked(requireActiveClaimOrganization).mockRejectedValue(new AppError('invitation_invalid'))

    const res = await accept({ token: 'invite-token' })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invitation_invalid' })
    expect(acceptInvitation).not.toHaveBeenCalled()
  })

  it('passes no verified email when the account has not verified the invited address', async () => {
    userEmailsFindOne.mockResolvedValue({
      email: 'ada@example.com',
      verified: false,
      verificationStatus: 'pending',
    })

    await accept({ token: 'invite-token' })

    expect(acceptInvitation).toHaveBeenCalledWith(expect.objectContaining({ userEmail: null }))
  })

  it('surfaces the email mismatch from the shared acceptance check', async () => {
    vi.mocked(acceptInvitation).mockRejectedValue(
      new AppError('invitation_email_mismatch', { httpStatus: 403 }),
    )

    const res = await accept({ token: 'invite-token' })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'invitation_email_mismatch' })
    expect(sessionsUpdate).not.toHaveBeenCalled()
  })

  it('rejects a body without a token', async () => {
    const res = await accept({ continuationToken: 'signed-continuation' })

    expect(res.status).toBe(422)
    expect(resolveInvitationTenant).not.toHaveBeenCalled()
  })
})
