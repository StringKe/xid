import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { sha256Hex } from '@xid-kit/crypto'
import type { XidHonoEnv } from '../../lib/types'
import { createTenantBoundInvitationToken } from '../../lib/invitation-token'

vi.mock('@xid-kit/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/crypto')>()
  return {
    ...actual,
    sha256Hex: vi.fn().mockResolvedValue('hashed-token'),
  }
})

const invitationsFindOne = vi.fn()
const invitationsUpdate = vi.fn()
const organizationsFindOne = vi.fn()
const membershipsFindOne = vi.fn()
const resolveTenantContextByIdInInstance = vi.hoisted(() => vi.fn())

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  resolveTenantContextByIdInInstance,
  schema: {
    invitations: { tokenHash: 'tokenHash', id: 'id', status: 'status' },
    organizations: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
    memberships: { userId: 'userId' },
    userEmails: { id: 'id', userId: 'userId' },
    users: { id: 'id', primaryEmailId: 'primaryEmailId' },
  },
}))

vi.mock('../../v1/shared', () => ({
  emitWebhookAsync: vi.fn(),
}))

import { createTenantDb } from '@xid-kit/db'
import {
  acceptInvitation,
  acceptInvitationByToken,
  assertInvitationEmailMatches,
  invitationAcceptContinuePath,
  loadInvitationPreview,
  resolveInvitationTenant,
} from '../invitations'
import { postAuthRedirectPath } from '../../lib/mfa-session'

function makeDb() {
  return {
    invitations: { findOne: invitationsFindOne, update: invitationsUpdate },
    organizations: { findOne: organizationsFindOne },
    forOrg: () => ({
      memberships: { findOne: membershipsFindOne },
    }),
  }
}

describe('loadInvitationPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    membershipsFindOne.mockResolvedValue({
      id: 'membership-1',
      role: 'member',
      status: 'active',
    })
    vi.mocked(createTenantDb).mockReturnValue(makeDb() as never)
  })

  it('returns invalid for empty token', async () => {
    const db = makeDb()
    const preview = await loadInvitationPreview(db as never, '   ')
    expect(preview.status).toBe('invalid')
  })

  it('returns pending with org name for valid invitation', async () => {
    const db = makeDb()
    const expiresAt = new Date(Date.now() + 86_400_000)
    invitationsFindOne.mockResolvedValue({
      id: 'inv-1',
      email: 'user@example.com',
      orgId: 'org-1',
      role: 'admin',
      status: 'pending',
      expiresAt,
      tokenHash: 'hashed-token',
      usedCount: 0,
    })
    organizationsFindOne.mockResolvedValue({
      id: 'org-1',
      name: 'Acme',
      slug: 'acme',
      status: 'active',
      deletedAt: null,
    })

    const preview = await loadInvitationPreview(db as never, 'raw-token')
    expect(preview.status).toBe('pending')
    expect(preview.orgName).toBe('Acme')
    expect(preview.email).toBe('user@example.com')
    expect(sha256Hex).toHaveBeenCalledWith('raw-token')
  })
})

describe('assertInvitationEmailMatches', () => {
  it('rejects mismatched email', async () => {
    await expect(
      assertInvitationEmailMatches(
        {
          email: 'invited@example.com',
        } as never,
        {
          email: 'other@example.com',
          verified: true,
          verificationStatus: 'verified',
        },
      ),
    ).rejects.toMatchObject({ code: 'invitation_email_mismatch' })
  })
})

describe('acceptInvitation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates membership and marks invitation accepted', async () => {
    const db = makeDb()
    const expiresAt = new Date(Date.now() + 86_400_000)
    const batch = vi.fn().mockResolvedValue([
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } },
    ])
    const prepare = vi.fn((_sql: string) => {
      const statement = {
        bind: vi.fn(() => statement),
      }
      return statement
    })
    const result = await acceptInvitation({
      db: db as never,
      env: { DB: { batch, prepare } as unknown as D1Database } as Env,
      tenantId: 'tenant-1',
      invitation: {
        id: 'inv-1',
        tokenHash: 'hashed-token',
        orgId: 'org-1',
        email: 'user@example.com',
        role: 'member',
        status: 'pending',
        expiresAt,
        usedCount: 0,
      } as never,
      userId: 'user-1',
      userEmail: {
        email: 'user@example.com',
        verified: true,
        verificationStatus: 'verified',
      },
    })

    expect(result.orgId).toBe('org-1')
    expect(prepare).toHaveBeenCalledTimes(3)
    expect(batch).toHaveBeenCalledTimes(1)
  })
})

describe('invitationAcceptContinuePath', () => {
  it('builds console org URL with orgId and orgName', () => {
    expect(invitationAcceptContinuePath('org-1', 'Acme')).toBe(
      '/console/org?orgId=org-1&orgName=Acme',
    )
  })
})

describe('tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createTenantDb).mockReturnValue(makeDb() as never)
  })

  it('does not expose invitation from another tenant context', async () => {
    invitationsFindOne.mockResolvedValue(null)
    const db = makeDb()
    const preview = await loadInvitationPreview(db as never, 'cross-tenant-token')
    expect(preview.status).toBe('invalid')
    expect(invitationsFindOne).toHaveBeenCalled()
  })

  it('accept rejects token not visible in current tenant context', async () => {
    invitationsFindOne.mockResolvedValue(null)
    const db = makeDb()
    await expect(
      acceptInvitationByToken({
        db: db as never,
        env: {} as Env,
        tenantId: 'tenant-a',
        rawToken: 'cross-tenant-token',
        userId: 'user-1',
        userEmail: {
          email: 'user@example.com',
          verified: true,
          verificationStatus: 'verified',
        },
      }),
    ).rejects.toMatchObject({ code: 'invitation_invalid' })
  })

  it('prioritizes the bound locator over a signed-in tenant, then requires a scoped tokenHash match', async () => {
    const target = {
      tenantId: 'tenant-invite',
      instanceId: 'instance-1',
      issuer: 'https://xid.dev',
      rpId: 'tenant-invite.xid.dev',
      signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
      policy: {},
    }
    resolveTenantContextByIdInInstance.mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: target },
    })
    invitationsFindOne.mockResolvedValue({
      id: 'inv-1',
      tenantId: 'tenant-invite',
      tokenHash: 'hashed-token',
    })
    vi.mocked(createTenantDb).mockReturnValue(makeDb() as never)
    const token = createTenantBoundInvitationToken('tenant-invite')
    const signedInTenant = {
      ...target,
      tenantId: 'tenant-a',
      rpId: 'tenant-a.xid.dev',
    }
    const app = new Hono<XidHonoEnv>()
    app.use('*', async (c, next) => {
      c.set('tenant', signedInTenant as never)
      await next()
    })
    app.get('/probe', async (c) => {
      const tenant = await resolveInvitationTenant(c, token)
      return c.json({ tenantId: tenant?.tenantId ?? null })
    })
    const env = { DB: {} as D1Database } as Env

    const res = await app.request('https://xid.dev/probe', {}, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tenantId: 'tenant-invite' })
    expect(resolveTenantContextByIdInInstance).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      'tenant-invite',
      'instance-1',
    )
    expect(createTenantDb).toHaveBeenCalledWith(env.DB, target)
    expect(sha256Hex).toHaveBeenCalledWith(token)
  })

  it('allows a legacy token only through an already concrete Tenant scoped lookup', async () => {
    const current = {
      tenantId: 'tenant-a',
      instanceId: 'instance-1',
      issuer: 'https://xid.dev',
      rpId: 'tenant-a.xid.dev',
      signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
      policy: {},
    }
    invitationsFindOne.mockResolvedValue({
      id: 'legacy-invitation',
      tenantId: 'tenant-a',
      tokenHash: 'hashed-token',
      tokenVersion: 'legacy',
      status: 'revoked',
    })
    vi.mocked(createTenantDb).mockReturnValue(makeDb() as never)
    const app = new Hono<XidHonoEnv>()
    app.use('*', async (c, next) => {
      c.set('tenant', current as never)
      await next()
    })
    app.get('/probe', async (c) => {
      const tenant = await resolveInvitationTenant(c, 'legacy-opaque-token')
      return c.json({ tenantId: tenant?.tenantId ?? null })
    })
    const env = { DB: {} as D1Database } as Env

    const res = await app.request('https://tenant-a.xid.dev/probe', {}, env)

    expect(await res.json()).toEqual({ tenantId: 'tenant-a' })
    expect(createTenantDb).toHaveBeenCalledWith(env.DB, current)
    expect(resolveTenantContextByIdInInstance).not.toHaveBeenCalled()
  })

  it('rejects a legacy token at the unresolved Instance root without a global hash lookup', async () => {
    const root = {
      tenantId: 'default',
      instanceId: 'instance-1',
      issuer: 'https://xid.dev',
      rpId: 'xid.dev',
      signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
      policy: {},
      resolution: {
        kind: 'instance_entry' as const,
        primaryDomain: 'xid.dev',
        unresolvedRoot: true,
      },
    }
    const app = new Hono<XidHonoEnv>()
    app.use('*', async (c, next) => {
      c.set('tenant', root as never)
      await next()
    })
    app.get('/probe', async (c) => {
      const tenant = await resolveInvitationTenant(c, 'legacy-opaque-token')
      return c.json({ tenantId: tenant?.tenantId ?? null })
    })

    const res = await app.request('https://xid.dev/probe', {}, { DB: {} as D1Database } as Env)

    expect(await res.json()).toEqual({ tenantId: null })
    expect(createTenantDb).not.toHaveBeenCalled()
    expect(resolveTenantContextByIdInInstance).not.toHaveBeenCalled()
  })
})

describe('postAuthRedirectPath', () => {
  it('prefers invitation accept path', () => {
    expect(
      postAuthRedirectPath({
        invitationToken: 'abc',
        intent: 'sign-up',
        continueParam: '/console',
      }),
    ).toBe('/accept-invitation?token=abc')
  })

  it('routes sign-up intent to create organization', () => {
    expect(postAuthRedirectPath({ intent: 'sign-up' })).toBe('/create-organization')
  })
})
