import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sha256Hex } from '@xid-kit/crypto'

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
const membershipsInsert = vi.fn()
const membershipsUpdate = vi.fn()

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    invitations: { tokenHash: 'tokenHash', id: 'id', status: 'status' },
    organizations: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
    memberships: { userId: 'userId', id: 'id', status: 'status' },
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
} from '../invitations'
import { postAuthRedirectPath } from '../../lib/mfa-session'

function makeDb() {
  const orgDb = {
    memberships: {
      findOne: membershipsFindOne,
      insert: membershipsInsert,
      update: membershipsUpdate,
    },
  }
  return {
    invitations: { findOne: invitationsFindOne, update: invitationsUpdate },
    organizations: { findOne: organizationsFindOne },
    forOrg: () => orgDb,
  }
}

describe('loadInvitationPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
        'other@example.com',
      ),
    ).rejects.toMatchObject({ code: 'invitation_email_mismatch' })
  })
})

describe('acceptInvitation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    membershipsFindOne.mockResolvedValue(null)
    membershipsInsert.mockResolvedValue(undefined)
    invitationsUpdate.mockResolvedValue([{ id: 'inv-1', status: 'accepted' }])
  })

  it('creates membership and marks invitation accepted', async () => {
    const db = makeDb()
    const expiresAt = new Date(Date.now() + 86_400_000)
    const result = await acceptInvitation({
      db: db as never,
      env: {} as Env,
      tenantId: 'tenant-1',
      invitation: {
        id: 'inv-1',
        orgId: 'org-1',
        email: 'user@example.com',
        role: 'member',
        status: 'pending',
        expiresAt,
        usedCount: 0,
      } as never,
      userId: 'user-1',
      userEmail: 'user@example.com',
    })

    expect(result.orgId).toBe('org-1')
    expect(membershipsInsert).toHaveBeenCalled()
    expect(invitationsUpdate).toHaveBeenCalled()
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
        userEmail: 'user@example.com',
      }),
    ).rejects.toMatchObject({ code: 'invitation_invalid' })
    expect(membershipsInsert).not.toHaveBeenCalled()
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
