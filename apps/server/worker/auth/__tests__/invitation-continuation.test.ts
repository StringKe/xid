import { base64UrlDecodeToString, signJwt } from '@xid-kit/crypto'
import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { INVITATION_AUTH_CONTINUATION_TTL_MS } from '../../lib/ttl'
import type { TenantVar, XidHonoEnv } from '../../lib/types'
import {
  invitationAuthContinuationPath,
  issueInvitationAuthContinuation,
  verifyInvitationAuthContinuation,
} from '../invitation-continuation'
import { resolveTokenTenant } from '../../me-auth/token-tenant'
import { buildVerifyKeySet, loadActiveSigner } from '../../oidc/shared'
import { execCtx, makeApp, makeEnv, makeTenant } from '../../me-auth/__tests__/helpers'

vi.mock('../../me-auth/token-tenant', () => ({
  resolveTokenTenant: vi.fn(),
}))

vi.mock('../../oidc/shared', () => ({
  buildVerifyKeySet: vi.fn(),
  loadActiveSigner: vi.fn(),
}))

const KID = 'kid-invitation-continuation'
const USER_ID = 'user-1'
const SESSION_ID = 'session-1'
const INVITATION_ID = 'invitation-1'

let keyPair: CryptoKeyPair

function decodePayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('missing JWT payload')
  return JSON.parse(base64UrlDecodeToString(payload)) as Record<string, unknown>
}

async function verifyWithRequestContext(tenant: TenantVar, token: string): Promise<Response> {
  const app = makeApp(
    (hono) => {
      hono.get('/verify', async (c) => {
        const continuation = await verifyInvitationAuthContinuation(c as Context<XidHonoEnv>, token)
        return c.json({
          tenantId: continuation.tenant.tenantId,
          userId: continuation.userId,
          sessionId: continuation.sessionId,
          invitationId: continuation.invitationId,
        })
      })
    },
    { tenant },
  )
  return app.request('https://tenant-1.xid.dev/verify', {}, makeEnv(), execCtx)
}

async function signClaims(
  tenant: TenantVar,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt(
    {
      header: { alg: 'ES256', kid: KID },
      payload: {
        iss: tenant.issuer,
        sub: USER_ID,
        jti: 'continuation-jti',
        iat: now,
        exp: now + INVITATION_AUTH_CONTINUATION_TTL_MS / 1000,
        purpose: 'invitation_auth_continuation',
        tenant_id: tenant.tenantId,
        sid: SESSION_ID,
        invitation_id: INVITATION_ID,
        ...overrides,
      },
    },
    keyPair.privateKey,
  )
}

describe('invitation auth continuation', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    vi.mocked(loadActiveSigner).mockResolvedValue({
      kid: KID,
      alg: 'ES256',
      privateKey: keyPair.privateKey,
    })
    vi.mocked(buildVerifyKeySet).mockResolvedValue({
      keys: [{ kid: KID, alg: 'ES256', publicKey: keyPair.publicKey }],
    })
  })

  it('signs the tenant, user, session, invitation, purpose, and bounded lifetime claims', async () => {
    const tenant = makeTenant() as unknown as TenantVar
    const env = makeEnv()

    const token = await issueInvitationAuthContinuation({
      env,
      tenant,
      userId: USER_ID,
      sessionId: SESSION_ID,
      invitationId: INVITATION_ID,
    })

    const payload = decodePayload(token)
    expect(payload).toEqual(
      expect.objectContaining({
        iss: tenant.issuer,
        sub: USER_ID,
        purpose: 'invitation_auth_continuation',
        tenant_id: tenant.tenantId,
        sid: SESSION_ID,
        invitation_id: INVITATION_ID,
        jti: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      }),
    )
    expect(Number(payload.exp) - Number(payload.iat)).toBe(
      INVITATION_AUTH_CONTINUATION_TTL_MS / 1000,
    )
    expect(loadActiveSigner).toHaveBeenCalledWith(tenant, env.KEK)
  })

  it('verifies the signature and returns the exact tenant, user, session, and invitation binding', async () => {
    const tenant = makeTenant() as unknown as TenantVar
    vi.mocked(resolveTokenTenant).mockResolvedValue(tenant)
    const token = await signClaims(tenant)

    const response = await verifyWithRequestContext(tenant, token)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      tenantId: tenant.tenantId,
      userId: USER_ID,
      sessionId: SESSION_ID,
      invitationId: INVITATION_ID,
    })
    expect(resolveTokenTenant).toHaveBeenCalledWith(expect.anything(), token, 'invitation_invalid')
    expect(buildVerifyKeySet).toHaveBeenCalledWith(tenant)
  })

  it.each([
    ['wrong issuer', { iss: 'https://tenant-other.xid.dev' }],
    ['wrong tenant', { tenant_id: 'tenant-other' }],
    ['wrong purpose', { purpose: 'magic_link' }],
    ['missing user', { sub: undefined }],
    ['missing session', { sid: undefined }],
    ['missing invitation', { invitation_id: undefined }],
  ])('rejects a validly signed token with %s binding', async (_name, overrides) => {
    const tenant = makeTenant() as unknown as TenantVar
    vi.mocked(resolveTokenTenant).mockResolvedValue(tenant)
    const token = await signClaims(tenant, overrides)

    const response = await verifyWithRequestContext(tenant, token)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'invitation_invalid' })
  })

  it('rejects a token signed by a key outside the tenant verification set', async () => {
    const tenant = makeTenant() as unknown as TenantVar
    vi.mocked(resolveTokenTenant).mockResolvedValue(tenant)
    const foreignPair = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(
      {
        header: { alg: 'ES256', kid: KID },
        payload: {
          iss: tenant.issuer,
          sub: USER_ID,
          iat: now,
          exp: now + INVITATION_AUTH_CONTINUATION_TTL_MS / 1000,
          purpose: 'invitation_auth_continuation',
          tenant_id: tenant.tenantId,
          sid: SESSION_ID,
          invitation_id: INVITATION_ID,
        },
      },
      foreignPair.privateKey,
    )

    const response = await verifyWithRequestContext(tenant, token)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'invitation_invalid' })
  })

  it('encodes the token as the only invitation continuation query parameter', () => {
    expect(invitationAuthContinuationPath('header.payload/signature+value')).toBe(
      '/accept-invitation?continuation_token=header.payload%2Fsignature%2Bvalue',
    )
  })
})
