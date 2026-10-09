import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@xid-kit/webauthn', () => ({
  verifyAuthentication: vi.fn(),
}))

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    passkeyCredentials: {
      userId: 'userId',
      credentialId: 'credentialId',
      revokedAt: 'revokedAt',
    },
    sessions: { id: 'id' },
  },
}))

vi.mock('../../auth/passkey-helpers', () => ({
  PASSKEY_LIMIT: 10,
  CHALLENGE_TTL_MS: 420000,
  createChallenge: vi.fn().mockResolvedValue('dGVzdA'),
  consumeChallenge: vi.fn().mockResolvedValue('dGVzdA'),
  buildStoredCredential: vi.fn().mockReturnValue({ credentialId: new Uint8Array(1) }),
  persistSignCount: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../auth/mfa', () => ({
  issueStepUpToken: vi.fn().mockResolvedValue({ token: 'stepup.token.sig' }),
}))

import { base64UrlEncode } from '@xid-kit/crypto'
import { verifyAuthentication } from '@xid-kit/webauthn'
import { createTenantDb } from '@xid-kit/db'
import { createChallenge } from '../../auth/passkey-helpers'
import { issueStepUpToken } from '../../auth/mfa'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeSession, makeTenant } from './helpers'

function makeOAuthStateNs(pending: Record<string, string> | null): DurableObjectNamespace {
  return {
    idFromName: () => ({ toString: () => 'oauth-id' }) as DurableObjectId,
    get: () =>
      ({
        fetch: async (input: string | Request) => {
          const rawUrl = typeof input === 'string' ? input : input.url
          const url = new URL(rawUrl)
          if (url.pathname === '/store') return new Response(null, { status: 201 })
          if (!pending) return new Response('not found', { status: 404 })
          return new Response(JSON.stringify({ record: { pendingParams: pending } }), {
            status: 200,
          })
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
}

function passkeyDbMocks(
  overrides: { backedUp?: boolean; enterpriseAttestationVerified?: boolean } = {},
) {
  const sessionUpdate = vi.fn().mockResolvedValue(undefined)
  const credential = {
    id: 'pk_1',
    credentialId: 'cred_1',
    transports: [],
    deviceName: null,
    createdAt: new Date(),
    backedUp: overrides.backedUp ?? false,
  }
  vi.mocked(createTenantDb).mockReturnValue({
    passkeyCredentials: {
      findMany: vi.fn().mockResolvedValue([credential]),
      findOne: vi.fn().mockResolvedValue({
        userId: 'u_1',
        signCount: 0,
        coseAlg: -7,
        publicKey: new Uint8Array([1]),
        aaguid: new Uint8Array(16),
        attestationFmt: 'none',
        enterpriseAttestationVerified: overrides.enterpriseAttestationVerified ?? false,
      }),
    },
    sessions: { update: sessionUpdate },
  } as unknown as ReturnType<typeof createTenantDb>)
  return sessionUpdate
}

// passkey 仪式只在租户 rpId 主机上进行。
function post(app: ReturnType<typeof makeApp>, env: Env, path: string, body?: unknown) {
  return app.request(
    `https://${makeTenant().rpId}${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
    execCtx,
  )
}

describe('passkey MFA challenge routes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('POST /auth/mfa/passkey/options returns allowCredentials', async () => {
    vi.mocked(createTenantDb).mockReturnValue({
      passkeyCredentials: {
        findMany: vi.fn().mockResolvedValue([
          {
            credentialId: 'cred_1',
            transports: ['internal'],
            backedUp: false,
            credentialDeviceType: 'singleDevice',
            attestationFmt: 'none',
            enterpriseAttestationVerified: false,
          },
        ]),
      },
    } as unknown as ReturnType<typeof createTenantDb>)

    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const res = await post(app, makeEnv(), '/auth/mfa/passkey/options')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['challenge']).toBe('dGVzdA')
    expect(body['allowCredentials']).toEqual([
      { id: 'cred_1', type: 'public-key', transports: ['internal'] },
    ])
    expect(createChallenge).toHaveBeenCalled()
  })

  it('POST /auth/mfa/passkey/verify upgrades session after successful assertion', async () => {
    vi.mocked(verifyAuthentication).mockResolvedValue({
      ok: true,
      value: {
        signCount: 1,
        signCountAnomaly: false,
        userVerified: true,
        credentialBackedUp: false,
        credentialDeviceType: 'singleDevice',
      },
    } as never)

    const sessionUpdate = passkeyDbMocks()

    const app = makeApp(registerSessionAuthRoutes, {
      session: makeSession(),
      tenant: makeTenant() as unknown as import('../../lib/types').TenantVar,
    })
    const res = await post(app, makeEnv(), '/auth/mfa/passkey/verify', {
      rawId: 'cred_1',
      response: {
        clientDataJSON: 'Y2Q',
        authenticatorData: 'YWQ',
        signature: 'c2ln',
      },
    })
    expect(res.status).toBe(200)
    expect(sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ acr: 'urn:xid:aal2', aal: 2, status: 'active' }),
      expect.anything(),
    )
  })

  it('POST /auth/mfa/passkey/verify issues step-up cookie with passkey assurance', async () => {
    vi.mocked(verifyAuthentication).mockResolvedValue({
      ok: true,
      value: {
        signCount: 1,
        signCountAnomaly: false,
        userVerified: true,
        credentialBackedUp: false,
        credentialDeviceType: 'singleDevice',
      },
    } as never)
    passkeyDbMocks()

    const app = makeApp(registerSessionAuthRoutes, {
      session: makeSession(),
      tenant: makeTenant() as unknown as import('../../lib/types').TenantVar,
    })
    const res = await post(app, makeEnv(), '/auth/mfa/passkey/verify', {
      rawId: 'cred_1',
      stepUp: true,
      response: {
        clientDataJSON: 'Y2Q',
        authenticatorData: 'YWQ',
        signature: 'c2ln',
      },
    })
    expect(res.status).toBe(200)
    expect(issueStepUpToken).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'passkey',
        passkeyAssurance: expect.objectContaining({
          userVerified: true,
          credentialBackedUp: false,
          credentialDeviceType: 'singleDevice',
        }),
      }),
    )
    expect(res.headers.get('set-cookie')).toContain('__Host-xid.acr=')
  })

  it('POST /auth/mfa/passkey/verify caps device-bound passkey MFA at AAL2', async () => {
    vi.mocked(verifyAuthentication).mockResolvedValue({
      ok: true,
      value: {
        signCount: 1,
        signCountAnomaly: false,
        userVerified: true,
        credentialBackedUp: false,
        credentialDeviceType: 'singleDevice',
      },
    } as never)
    const sessionUpdate = passkeyDbMocks()
    const env = makeEnv({
      oauthStateNs: makeOAuthStateNs({
        acr_values: 'urn:xid:aal3',
      }),
    })
    const app = makeApp(registerSessionAuthRoutes, {
      session: makeSession(),
      tenant: makeTenant() as unknown as import('../../lib/types').TenantVar,
    })
    const res = await post(app, env, '/auth/mfa/passkey/verify', {
      rawId: 'cred_1',
      response: {
        clientDataJSON: 'Y2Q',
        authenticatorData: 'YWQ',
        signature: 'c2ln',
      },
    })
    expect(res.status).toBe(200)
    expect(sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ acr: 'urn:xid:aal2', aal: 2 }),
      expect.anything(),
    )
  })

  it('POST /auth/mfa/passkey/verify keeps a backed-up credential at AAL2', async () => {
    vi.mocked(verifyAuthentication).mockResolvedValue({
      ok: true,
      value: {
        signCount: 1,
        signCountAnomaly: false,
        userVerified: true,
        credentialBackedUp: true,
        credentialDeviceType: 'multiDevice',
      },
    } as never)
    const sessionUpdate = passkeyDbMocks({ backedUp: true })
    const env = makeEnv({
      oauthStateNs: makeOAuthStateNs({ acr_values: 'urn:xid:aal3' }),
    })
    const app = makeApp(registerSessionAuthRoutes, {
      session: makeSession(),
      tenant: makeTenant() as unknown as import('../../lib/types').TenantVar,
    })
    const res = await post(app, env, '/auth/mfa/passkey/verify', {
      rawId: 'cred_1',
      response: {
        clientDataJSON: 'Y2Q',
        authenticatorData: 'YWQ',
        signature: 'c2ln',
      },
    })
    expect(res.status).toBe(200)
    expect(sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ acr: 'urn:xid:aal2', aal: 2 }),
      expect.anything(),
    )
  })

  it('POST /auth/mfa/passkey/verify rejects any passkey as second factor after phr primary login', async () => {
    passkeyDbMocks()
    const app = makeApp(registerSessionAuthRoutes, {
      session: { ...makeSession(), status: 'pending_mfa', amr: ['phr'] },
      tenant: makeTenant() as unknown as import('../../lib/types').TenantVar,
    })

    const res = await post(app, makeEnv(), '/auth/mfa/passkey/verify', {
      rawId: 'cred_1',
      response: {
        clientDataJSON: 'Y2Q',
        authenticatorData: 'YWQ',
        signature: 'c2ln',
      },
    })

    expect(res.status).toBe(401)
    expect(verifyAuthentication).not.toHaveBeenCalled()
  })

  it('POST /auth/mfa/passkey/verify accepts step-up on an active passkey session', async () => {
    vi.mocked(verifyAuthentication).mockResolvedValue({
      ok: true,
      value: {
        signCount: 1,
        signCountAnomaly: false,
        userVerified: true,
        credentialBackedUp: true,
        credentialDeviceType: 'multiDevice',
      },
    } as never)
    passkeyDbMocks()
    const app = makeApp(registerSessionAuthRoutes, {
      session: { ...makeSession(), amr: ['phr'] },
      tenant: makeTenant() as unknown as import('../../lib/types').TenantVar,
    })

    const res = await post(app, makeEnv(), '/auth/mfa/passkey/verify', {
      rawId: 'cred_1',
      stepUp: true,
      response: {
        clientDataJSON: 'Y2Q',
        authenticatorData: 'YWQ',
        signature: 'c2ln',
      },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('__Host-xid.acr=')
  })

  it('POST /auth/mfa/passkey/verify rejects a userHandle that belongs to another user', async () => {
    vi.mocked(verifyAuthentication).mockResolvedValue({
      ok: true,
      value: {
        signCount: 1,
        signCountAnomaly: false,
        userVerified: true,
        credentialBackedUp: false,
        credentialDeviceType: 'singleDevice',
      },
    } as never)
    const sessionUpdate = passkeyDbMocks()
    const app = makeApp(registerSessionAuthRoutes, {
      session: makeSession(),
      tenant: makeTenant() as unknown as import('../../lib/types').TenantVar,
    })

    const res = await post(app, makeEnv(), '/auth/mfa/passkey/verify', {
      rawId: 'cred_1',
      response: {
        clientDataJSON: 'Y2Q',
        authenticatorData: 'YWQ',
        signature: 'c2ln',
        userHandle: base64UrlEncode(new TextEncoder().encode('u_other')),
      },
    })

    expect(res.status).toBe(401)
    expect(sessionUpdate).not.toHaveBeenCalled()
  })
})
