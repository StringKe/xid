// Legacy invitation surface contract: raw-token preview remains readable, while every direct
// acceptance or continuation path fails closed in favor of the proof-first Email claim.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTenantDb } from '@xid-kit/db'
import { loadInvitationPreview, resolveInvitationTenant } from '../../auth/invitations'
import { createTenantBoundInvitationToken } from '../../lib/invitation-token'
import { handleInvitationAccept, handleInvitationPreview } from '../invitation-accept'
import { execCtx, makeApp, makeEnv, makeTenant } from './helpers'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
}))

vi.mock('../../auth/invitations', () => ({
  loadInvitationPreview: vi.fn(),
  resolveInvitationTenant: vi.fn(),
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
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['raw token', { token: 'invite-token' }],
    ['legacy continuation', { continuationToken: 'signed-continuation' }],
    ['missing credential', {}],
  ])('fails closed for %s without reading session or mutating tenant data', async (_name, body) => {
    const app = makeApp(registerLegacyInvitationRoutes)
    const res = await app.request(
      'https://xid.dev/auth/invitation/accept',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      makeEnv(),
      execCtx,
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invitation_invalid' })
    expect(resolveInvitationTenant).not.toHaveBeenCalled()
    expect(createTenantDb).not.toHaveBeenCalled()
    expect(loadInvitationPreview).not.toHaveBeenCalled()
  })
})
