import { sha256Hex } from '@xid-kit/crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@xid-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/db')>()
  return {
    ...actual,
    createTenantDb: vi.fn(),
    resolveTenantContextByIdInInstance: vi.fn(),
  }
})

vi.mock('../../auth/hosted-policy', () => ({
  assertEmailAllowed: vi.fn(),
  assertMethodAllowed: vi.fn(),
}))

vi.mock('../../auth/invitations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth/invitations')>()
  return {
    ...actual,
    requirePendingInvitationByToken: vi.fn(),
    resolveInvitationTenant: vi.fn(),
  }
})

vi.mock('../invitation-claim-token', () => ({
  signInvitationEmailClaim: vi.fn(),
  verifyInvitationEmailClaimJwt: vi.fn(),
}))

vi.mock('../token-tenant', () => ({
  resolveTokenTenant: vi.fn(),
}))

vi.mock('../shared', () => ({
  enforceSendRateLimit: vi.fn().mockResolvedValue(undefined),
  requestIp: vi.fn().mockReturnValue('203.0.113.10'),
  requestUserAgent: vi.fn().mockReturnValue('vitest'),
  verifyTurnstile: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/mfa-session', () => ({
  resolvePostAuthMfaGate: vi.fn().mockResolvedValue({}),
}))

vi.mock('../../lib/session', () => ({
  ACTIVE_SESSION_STATUS: 'active',
  PENDING_MFA_SESSION_STATUS: 'pending_mfa',
  PENDING_MFA_SETUP_SESSION_STATUS: 'pending_mfa_setup',
  issueSession: vi.fn(),
  readSessionForTenant: vi.fn(),
  revokeSessionByIdentity: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../v1/shared', () => ({
  emitWebhookAsync: vi.fn(),
}))

import { createTenantDb, resolveTenantContextByIdInInstance, type schema } from '@xid-kit/db'
import { assertMethodAllowed } from '../../auth/hosted-policy'
import { requirePendingInvitationByToken, resolveInvitationTenant } from '../../auth/invitations'
import { AppError } from '../../lib/errors'
import { resolvePostAuthMfaGate } from '../../lib/mfa-session'
import { issueSession, readSessionForTenant } from '../../lib/session'
import { emitWebhookAsync } from '../../v1/shared'
import { handleInvitationClaimStart, handleInvitationClaimVerify } from '../invitation-claim'
import { signInvitationEmailClaim, verifyInvitationEmailClaimJwt } from '../invitation-claim-token'
import { resolveTokenTenant } from '../token-tenant'
import { execCtx, makeApp, makeEnv, makeSession, makeTenant } from './helpers'

type InvitationRow = typeof schema.invitations.$inferSelect
type BoundStatement = {
  sql: string
  params: unknown[]
  run: ReturnType<typeof vi.fn>
}

function tenantContext() {
  return {
    ...makeTenant('tenant-1'),
    instanceId: 'instance-1',
  }
}

function invitation(overrides: Partial<InvitationRow> = {}): InvitationRow {
  const now = Date.now()
  return {
    id: 'invitation-1',
    tenantId: 'tenant-1',
    orgId: 'org-1',
    email: 'invitee@example.com',
    role: 'member',
    tokenHash: 'stored-raw-invitation-hash',
    tokenVersion: 'locator_v1',
    inviteType: 'email',
    maxUses: null,
    usedCount: 0,
    status: 'pending',
    invitedByUserId: 'inviter-1',
    acceptedByUserId: null,
    emailClaimTokenHash: null,
    emailClaimEmailHash: null,
    emailClaimExpiresAt: null,
    emailClaimConsumedAt: null,
    emailClaimConsumptionId: null,
    emailClaimUserId: null,
    emailClaimRecoveryHash: null,
    emailClaimSessionId: null,
    emailClaimSessionReservedAt: null,
    emailClaimFinalizationId: null,
    displacedUserId: null,
    displacedEmailId: null,
    expiresAt: new Date(now + 86_400_000),
    createdAt: new Date(now - 1_000),
    updatedAt: new Date(now - 1_000),
    ...overrides,
  }
}

function recordingD1() {
  const statements: BoundStatement[] = []
  const prepare = vi.fn((sql: string) => ({
    bind(...params: unknown[]) {
      const statement: BoundStatement = {
        sql,
        params,
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      }
      statements.push(statement)
      return statement
    },
  }))
  const batch = vi.fn()
  return {
    db: { prepare, batch } as unknown as D1Database,
    prepare,
    batch,
    statements,
  }
}

function post(
  app: ReturnType<typeof makeApp>,
  env: Env,
  path: string,
  body: Record<string, unknown>,
) {
  return app.request(
    `https://xid.dev${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
    execCtx,
  )
}

function registerClaimRoutes(
  app: Parameters<typeof makeApp>[0] extends (app: infer T) => void ? T : never,
) {
  app.post('/auth/invitation/claim', handleInvitationClaimStart)
  app.post('/auth/invitation/claim/verify', handleInvitationClaimVerify)
}

function mockTargetTenantResolution() {
  const tenant = tenantContext()
  vi.mocked(resolveTenantContextByIdInInstance).mockResolvedValue({
    ok: true,
    value: { status: 'resolved', tenant },
  } as never)
  return tenant
}

describe('invitation Email claim proof-first contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolvePostAuthMfaGate).mockResolvedValue({})
    mockTargetTenantResolution()
  })

  it('persists only claim hashes and sends the claim capability in the email URL fragment', async () => {
    const rawInvitationToken = 'raw-invitation-capability'
    const rawClaimToken = 'signed-email-claim'
    const claimUrl = 'https://tenant-1.xid.dev/accept-invitation#claim_token=signed-email-claim'
    const tenant = tenantContext()
    const row = invitation()
    const d1 = recordingD1()
    const emailSend = vi.fn().mockResolvedValue(undefined)
    const env = { ...makeEnv({ emailSend }), DB: d1.db }

    vi.mocked(resolveInvitationTenant).mockResolvedValue(tenant as never)
    vi.mocked(requirePendingInvitationByToken).mockResolvedValue(row)
    vi.mocked(createTenantDb).mockReturnValue({
      organizations: {
        findOne: vi.fn().mockResolvedValue({
          id: row.orgId,
          status: 'active',
          deletedAt: null,
        }),
      },
    } as unknown as ReturnType<typeof createTenantDb>)
    vi.mocked(signInvitationEmailClaim).mockResolvedValue({
      token: rawClaimToken,
      tokenHash: 'claim-token-hash',
      emailHash: 'claim-email-hash',
      expiresAt: new Date(Date.now() + 900_000),
      verifyUrl: claimUrl,
    })

    const app = makeApp(registerClaimRoutes, { tenant: tenant as never })
    const response = await post(app, env, '/auth/invitation/claim', {
      token: rawInvitationToken,
      turnstileToken: null,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(d1.statements).toHaveLength(1)
    expect(d1.statements[0]?.sql).toContain('email_claim_token_hash')
    expect(d1.statements[0]?.params).not.toContain(rawInvitationToken)
    expect(d1.statements[0]?.params).not.toContain(rawClaimToken)
    expect(d1.batch).not.toHaveBeenCalled()

    expect(emailSend).toHaveBeenCalledOnce()
    const message = emailSend.mock.calls[0]?.[0] as {
      type: string
      recipient: string
      payload: { token: string; link: string }
    }
    const deliveredUrl = new URL(message.payload.link)
    expect(message.type).toBe('verify_email')
    expect(message.recipient).toBe(row.email)
    expect(message.payload.token).toBe(rawClaimToken)
    expect(deliveredUrl.search).toBe('')
    expect(new URLSearchParams(deliveredUrl.hash.slice(1)).get('claim_token')).toBe(rawClaimToken)
    expect(message.payload.link).not.toContain(rawInvitationToken)
  })

  it.each(['legacy-opaque-token', 'malformed-token'])(
    'keeps an unresolved %s claim start opaque and side-effect free',
    async (rawToken) => {
      const d1 = recordingD1()
      const emailSend = vi.fn()
      const env = { ...makeEnv({ emailSend }), DB: d1.db }
      vi.mocked(resolveInvitationTenant).mockResolvedValue(null)

      const app = makeApp(registerClaimRoutes, { tenant: tenantContext() as never })
      const response = await post(app, env, '/auth/invitation/claim', {
        token: rawToken,
        turnstileToken: null,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(createTenantDb).not.toHaveBeenCalled()
      expect(d1.prepare).not.toHaveBeenCalled()
      expect(d1.batch).not.toHaveBeenCalled()
      expect(emailSend).not.toHaveBeenCalled()
    },
  )

  it('fails closed on a recovery key mismatch before user, session, or D1 mutations', async () => {
    const tenant = tenantContext()
    const jti = 'claim-jti'
    const emailHash = await sha256Hex('invitee@example.com')
    const tokenHash = await sha256Hex(jti)
    const recoveryHash = await sha256Hex('correct-recovery-key-that-is-long-enough')
    const row = invitation({
      status: 'accepted',
      acceptedByUserId: 'claim-user-1',
      emailClaimTokenHash: tokenHash,
      emailClaimEmailHash: emailHash,
      emailClaimConsumedAt: new Date(),
      emailClaimConsumptionId: 'consumption-1',
      emailClaimUserId: 'claim-user-1',
      emailClaimRecoveryHash: recoveryHash,
      emailClaimSessionId: 'claim-session-1',
    })
    const invitationsFindOne = vi.fn().mockResolvedValue(row)
    const usersFindOne = vi.fn()
    const d1 = recordingD1()
    const env = { ...makeEnv(), DB: d1.db }

    vi.mocked(resolveTokenTenant).mockResolvedValue(tenant as never)
    vi.mocked(verifyInvitationEmailClaimJwt).mockResolvedValue({
      invitationId: row.id,
      jti,
      emailHash,
    })
    vi.mocked(createTenantDb).mockReturnValue({
      invitations: { findOne: invitationsFindOne },
      users: { findOne: usersFindOne },
    } as unknown as ReturnType<typeof createTenantDb>)

    const app = makeApp(registerClaimRoutes, { tenant: tenant as never })
    const response = await post(app, env, '/auth/invitation/claim/verify', {
      token: 'signed-email-claim',
      recoveryKey: 'wrong-recovery-key-that-is-long-enough',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'token_invalid' })
    expect(usersFindOne).not.toHaveBeenCalled()
    expect(readSessionForTenant).not.toHaveBeenCalled()
    expect(issueSession).not.toHaveBeenCalled()
    expect(d1.prepare).not.toHaveBeenCalled()
    expect(d1.batch).not.toHaveBeenCalled()
  })

  it('re-checks login policy after a concurrent acceptance and reuses its session idempotently', async () => {
    const tenant = tenantContext()
    const jti = 'claim-jti'
    const recoveryKey = 'accepted-recovery-key-that-is-long-enough'
    const emailHash = await sha256Hex('invitee@example.com')
    const tokenHash = await sha256Hex(jti)
    const recoveryHash = await sha256Hex(recoveryKey)
    const initialRow = invitation({
      status: 'claim_verified',
      emailClaimTokenHash: tokenHash,
      emailClaimEmailHash: emailHash,
      emailClaimConsumedAt: new Date(),
      emailClaimConsumptionId: 'consumption-1',
      emailClaimUserId: 'claim-user-1',
      emailClaimRecoveryHash: recoveryHash,
      emailClaimSessionId: 'claim-session-1',
      emailClaimSessionReservedAt: new Date(),
    })
    const row = invitation({
      status: 'accepted',
      acceptedByUserId: 'claim-user-1',
      emailClaimTokenHash: tokenHash,
      emailClaimEmailHash: emailHash,
      emailClaimConsumedAt: new Date(),
      emailClaimConsumptionId: 'consumption-1',
      emailClaimUserId: 'claim-user-1',
      emailClaimRecoveryHash: recoveryHash,
      emailClaimSessionId: 'claim-session-1',
      emailClaimSessionReservedAt: new Date(),
    })
    const session = makeSession('claim-user-1', 'claim-session-1')
    const sessionsUpdate = vi.fn().mockResolvedValue([{ id: session.sessionId }])
    const d1 = recordingD1()
    const auditSend = vi.fn()
    const env = { ...makeEnv({ auditSend }), DB: d1.db }

    vi.mocked(resolveTokenTenant).mockResolvedValue(tenant as never)
    vi.mocked(verifyInvitationEmailClaimJwt).mockResolvedValue({
      invitationId: row.id,
      jti,
      emailHash,
    })
    vi.mocked(readSessionForTenant).mockResolvedValue(session)
    vi.mocked(createTenantDb).mockReturnValue({
      invitations: {
        findOne: vi.fn().mockResolvedValueOnce(initialRow).mockResolvedValue(row),
      },
      users: {
        findOne: vi.fn().mockResolvedValue({
          id: 'claim-user-1',
          status: 'active',
          deletedAt: null,
          mergedIntoUserId: null,
          provisionedBy: 'invitation_email_claim',
          primaryEmailId: 'claim-email-1',
        }),
      },
      userEmails: {
        findOne: vi.fn().mockResolvedValue({
          id: 'claim-email-1',
          userId: 'claim-user-1',
          email: row.email,
          verified: true,
          verificationStatus: 'verified',
          verifiedAt: new Date(),
          isPrimary: true,
          ownershipProof: 'invitation_email_claim_v1',
          ownershipProofCeremonyId: row.id,
          ownershipProvenAt: new Date(),
        }),
      },
      organizations: {
        findOne: vi.fn().mockResolvedValue({
          id: row.orgId,
          name: 'Acme',
          slug: 'acme',
          status: 'active',
          deletedAt: null,
        }),
      },
      sessions: {
        findOne: vi.fn().mockResolvedValue(session),
        update: sessionsUpdate,
      },
      forOrg: vi.fn().mockReturnValue({
        memberships: {
          findOne: vi.fn().mockResolvedValue({
            id: 'membership-1',
            userId: 'claim-user-1',
            status: 'active',
          }),
        },
      }),
    } as unknown as ReturnType<typeof createTenantDb>)

    const app = makeApp(registerClaimRoutes, { tenant: tenant as never })
    const response = await post(app, env, '/auth/invitation/claim/verify', {
      token: 'signed-email-claim',
      recoveryKey,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      redirectUrl: '/console/org?orgId=org-1&orgName=Acme',
    })
    expect(sessionsUpdate).toHaveBeenCalledOnce()
    expect(assertMethodAllowed).toHaveBeenCalledWith(tenant, 'magicLink', 'user_creation')
    expect(assertMethodAllowed).toHaveBeenCalledWith(tenant, 'magicLink', 'login')
    expect(issueSession).not.toHaveBeenCalled()
    expect(d1.prepare).not.toHaveBeenCalled()
    expect(d1.batch).not.toHaveBeenCalled()
    expect(auditSend).not.toHaveBeenCalled()
    expect(emitWebhookAsync).not.toHaveBeenCalled()
  })

  it('checks target policy before staging a pending proof', async () => {
    const tenant = tenantContext()
    const jti = 'claim-jti'
    const emailHash = await sha256Hex('invitee@example.com')
    const row = invitation({
      emailClaimTokenHash: await sha256Hex(jti),
      emailClaimEmailHash: emailHash,
      emailClaimExpiresAt: new Date(Date.now() + 900_000),
    })
    const d1 = recordingD1()
    const env = { ...makeEnv(), DB: d1.db }

    vi.mocked(resolveTokenTenant).mockResolvedValue(tenant as never)
    vi.mocked(verifyInvitationEmailClaimJwt).mockResolvedValue({
      invitationId: row.id,
      jti,
      emailHash,
    })
    vi.mocked(createTenantDb).mockReturnValue({
      invitations: { findOne: vi.fn().mockResolvedValue(row) },
    } as unknown as ReturnType<typeof createTenantDb>)
    vi.mocked(assertMethodAllowed).mockImplementationOnce(() => {
      throw new AppError('invalid_request')
    })

    const app = makeApp(registerClaimRoutes, { tenant: tenant as never })
    const response = await post(app, env, '/auth/invitation/claim/verify', {
      token: 'signed-email-claim',
      recoveryKey: 'policy-denied-recovery-key-long-enough',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'invalid_request' })
    expect(d1.prepare).not.toHaveBeenCalled()
    expect(d1.batch).not.toHaveBeenCalled()
    expect(readSessionForTenant).not.toHaveBeenCalled()
    expect(issueSession).not.toHaveBeenCalled()
    expect(emitWebhookAsync).not.toHaveBeenCalled()
  })
})
