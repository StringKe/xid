// email-verify-token 单元测试:JWT 验签与 jti 一次性消费。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { verifyJwt } from '@xid-kit/crypto'
import { createTenantDb } from '@xid-kit/db'
import type { TenantVar } from '../../lib/types'
import { buildVerifyKeySet } from '../../oidc/shared'
import { consumeEmailVerifyToken, verifyEmailVerifyJwt } from '../email-verify-token'

vi.mock('@xid-kit/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/crypto')>()
  return { ...actual, verifyJwt: vi.fn(), sha256Hex: vi.fn().mockResolvedValue('hash_jti') }
})

vi.mock('../../oidc/shared', () => ({
  buildVerifyKeySet: vi.fn().mockResolvedValue({ keys: [] }),
  loadActiveSigner: vi.fn(),
}))

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    verificationTokens: {
      tokenHash: 'tokenHash',
      userId: 'userId',
      purpose: 'purpose',
      consumedAt: 'consumedAt',
      expiresAt: 'expiresAt',
    },
  },
}))

const TENANT = {
  tenantId: 'tenant_1',
  issuer: 'https://tenant_1.xid.dev',
  rpId: 'tenant_1.xid.dev',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
} as TenantVar

describe('verifyEmailVerifyJwt', () => {
  beforeEach(() => {
    vi.mocked(verifyJwt).mockReset()
  })

  it('returns jti, userId, and exact email hash when JWT verifies', async () => {
    const emailHash = 'a'.repeat(64)
    vi.mocked(verifyJwt).mockResolvedValue({
      ok: true,
      value: {
        payload: {
          sub: 'user_1',
          jti: 'jti_abc',
          purpose: 'email_verification',
          email_hash: emailHash,
          intent: 'sign-up',
        },
        header: { alg: 'ES256', kid: 'k1' },
      },
    })
    await expect(verifyEmailVerifyJwt(TENANT, 'jwt.token.sig')).resolves.toEqual({
      jti: 'jti_abc',
      userId: 'user_1',
      emailHash,
      intent: 'sign-up',
      applicationClientId: null,
      continuePath: '/create-organization',
      invitationId: null,
    })
    expect(buildVerifyKeySet).toHaveBeenCalledWith(TENANT)
  })

  it('accepts a canonical invitation locator without preserving a raw invitation path', async () => {
    const emailHash = 'a'.repeat(64)
    vi.mocked(verifyJwt).mockResolvedValue({
      ok: true,
      value: {
        payload: {
          sub: 'user_1',
          jti: 'jti_abc',
          purpose: 'email_verification',
          email_hash: emailHash,
          intent: 'sign-up',
          continue_path: '/console',
          invitation_id: 'invitation_1',
        },
        header: { alg: 'ES256', kid: 'k1' },
      },
    })

    await expect(verifyEmailVerifyJwt(TENANT, 'jwt.token.sig')).resolves.toEqual({
      jti: 'jti_abc',
      userId: 'user_1',
      emailHash,
      intent: 'sign-up',
      continuePath: '/console',
      applicationClientId: null,
      invitationId: 'invitation_1',
    })
  })

  it.each([
    {
      name: 'client-bound product sign-up',
      flow: {
        intent: 'sign-up',
        continue_path: '/authorize?authz_request_id=req_1&client_id=client_1',
        client_id: 'client_1',
      },
    },
    {
      name: 'Application sign-up without client binding',
      flow: {
        intent: 'application-sign-up',
        continue_path: '/authorize?authz_request_id=req_1',
      },
    },
    {
      name: 'mismatched Application client binding',
      flow: {
        intent: 'application-sign-up',
        continue_path: '/authorize?authz_request_id=req_1&client_id=other_client',
        client_id: 'client_1',
      },
    },
    {
      name: 'unbound authorize continuation',
      flow: {
        intent: 'sign-in',
        continue_path: '/authorize?authz_request_id=req_1',
      },
    },
    {
      name: 'raw invitation capability path',
      flow: {
        intent: 'sign-up',
        continue_path: '/accept-invitation?token=raw-secret',
        invitation_id: 'invitation_1',
      },
    },
  ])('rejects an invalid signed flow contract: $name', async ({ flow }) => {
    vi.mocked(verifyJwt).mockResolvedValue({
      ok: true,
      value: {
        payload: {
          sub: 'user_1',
          jti: 'jti_abc',
          purpose: 'email_verification',
          email_hash: 'a'.repeat(64),
          ...flow,
        },
        header: { alg: 'ES256', kid: 'k1' },
      },
    })

    await expect(verifyEmailVerifyJwt(TENANT, 'jwt.token.sig')).rejects.toMatchObject({
      code: 'token_invalid',
    })
  })

  it('rejects a token without the exact email_hash target', async () => {
    vi.mocked(verifyJwt).mockResolvedValue({
      ok: true,
      value: {
        payload: { sub: 'user_1', jti: 'jti_abc', purpose: 'email_verification' },
        header: { alg: 'ES256', kid: 'k1' },
      },
    })
    await expect(verifyEmailVerifyJwt(TENANT, 'jwt.token.sig')).rejects.toMatchObject({
      code: 'token_invalid',
    })
  })

  it('throws token_expired when verifyJwt reports expiry', async () => {
    vi.mocked(verifyJwt).mockResolvedValue({
      ok: false,
      error: { reason: 'expired' },
    })
    await expect(verifyEmailVerifyJwt(TENANT, 'jwt.token.sig')).rejects.toMatchObject({
      code: 'token_expired',
    })
  })

  it('throws token_invalid for wrong purpose or missing claims', async () => {
    vi.mocked(verifyJwt).mockResolvedValue({
      ok: true,
      value: { payload: { sub: 'user_1', jti: 'jti', purpose: 'magic_link' }, header: {} },
    })
    await expect(verifyEmailVerifyJwt(TENANT, 'jwt.token.sig')).rejects.toMatchObject({
      code: 'token_invalid',
    })
  })

  it('throws token_invalid for malformed email_hash', async () => {
    vi.mocked(verifyJwt).mockResolvedValue({
      ok: true,
      value: {
        payload: {
          sub: 'user_1',
          jti: 'jti',
          purpose: 'email_verification',
          email_hash: 'not-a-hash',
        },
        header: {},
      },
    })
    await expect(verifyEmailVerifyJwt(TENANT, 'jwt.token.sig')).rejects.toMatchObject({
      code: 'token_invalid',
    })
  })

  it('throws token_invalid for an unsupported signed intent', async () => {
    vi.mocked(verifyJwt).mockResolvedValue({
      ok: true,
      value: {
        payload: {
          sub: 'user_1',
          jti: 'jti',
          purpose: 'email_verification',
          email_hash: 'a'.repeat(64),
          intent: 'admin',
        },
        header: {},
      },
    })
    await expect(verifyEmailVerifyJwt(TENANT, 'jwt.token.sig')).rejects.toMatchObject({
      code: 'token_invalid',
    })
  })
})

describe('consumeEmailVerifyToken', () => {
  it('marks token consumed and returns userId on first use', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const findOne = vi.fn().mockResolvedValue({
      userId: 'user_1',
      purpose: 'email_verification',
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60000),
    })
    const db = { verificationTokens: { findOne, update } }
    await expect(
      consumeEmailVerifyToken(db as ReturnType<typeof createTenantDb>, 'jti_1'),
    ).resolves.toBe('user_1')
    expect(update).toHaveBeenCalled()
  })

  it('rejects already consumed or expired tokens', async () => {
    const dbConsumed = {
      verificationTokens: {
        findOne: vi.fn().mockResolvedValue({
          userId: 'user_1',
          purpose: 'email_verification',
          consumedAt: new Date(),
          expiresAt: new Date(Date.now() + 60000),
        }),
        update: vi.fn(),
      },
    }
    await expect(
      consumeEmailVerifyToken(dbConsumed as ReturnType<typeof createTenantDb>, 'jti_1'),
    ).rejects.toMatchObject({ code: 'token_invalid' })

    const dbExpired = {
      verificationTokens: {
        findOne: vi.fn().mockResolvedValue({
          userId: 'user_1',
          purpose: 'email_verification',
          consumedAt: null,
          expiresAt: new Date(Date.now() - 1000),
        }),
        update: vi.fn(),
      },
    }
    await expect(
      consumeEmailVerifyToken(dbExpired as ReturnType<typeof createTenantDb>, 'jti_1'),
    ).rejects.toMatchObject({ code: 'token_expired' })
  })
})
