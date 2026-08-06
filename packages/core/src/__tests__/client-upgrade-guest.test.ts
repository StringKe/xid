import { afterEach, describe, expect, it, vi } from 'vitest'

import { XidClient } from '../client'
import type { PasskeyRegistrationOptions } from '../webauthn'
import { bytesToB64url } from '../webauthn'
import { makeFetch, makeState, makeUser } from './fixtures'

afterEach(() => {
  vi.unstubAllGlobals()
})

const OPTIONS: PasskeyRegistrationOptions = {
  challenge: bytesToB64url(new Uint8Array([1, 2, 3, 4])),
  rp: { id: 'tenant.xid.dev', name: 'https://tenant.xid.dev' },
  user: {
    id: bytesToB64url(new TextEncoder().encode('user_1')),
    name: 'user_1',
    displayName: 'user_1',
  },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
}

function makeAttestationCredential() {
  return {
    id: 'cred_1',
    rawId: new Uint8Array([9, 8, 7]).buffer,
    type: 'public-key',
    response: {
      clientDataJSON: new Uint8Array([11, 12]).buffer,
      attestationObject: new Uint8Array([13, 14, 15]).buffer,
      getTransports: () => ['internal'],
    },
  }
}

function stubCredentialsCreate(create: (input?: unknown) => Promise<unknown>) {
  vi.stubGlobal('navigator', { credentials: { create } })
  vi.stubGlobal('PublicKeyCredential', class {})
}

describe('XidClient.upgradeGuestWithPasskey', () => {
  it('runs options -> ceremony -> verify and reloads the converted user', async () => {
    let converted = false
    let verifyBody: unknown = null
    const fetcher = makeFetch({
      '/v1/me': () => ({
        status: 200,
        json: {
          data: makeState({
            user: makeUser(converted ? {} : { provisionedBy: 'anonymous' }),
          }),
        },
      }),
      '/auth/passkey/register/options': () => ({ status: 200, json: OPTIONS }),
      '/auth/passkey/register/verify': ({ body }) => {
        verifyBody = body
        converted = true
        return { status: 200, json: { ok: true } }
      },
    })
    const instance = new XidClient({ fetcher, now: () => 1000 })
    stubCredentialsCreate(vi.fn().mockResolvedValue(makeAttestationCredential()))
    await instance.load()
    expect(instance.isAnonymous).toBe(true)

    const result = await instance.upgradeGuestWithPasskey({ deviceName: 'Laptop' })

    expect(result.ok).toBe(true)
    expect(fetcher.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/me',
      'POST /auth/passkey/register/options',
      'POST /auth/passkey/register/verify',
      'GET /v1/me',
    ])
    expect(verifyBody).toMatchObject({
      id: 'cred_1',
      rawId: bytesToB64url(new Uint8Array([9, 8, 7])),
      transports: ['internal'],
      deviceName: 'Laptop',
    })
    expect(result.ok && result.value.user?.provisionedBy).toBeUndefined()
    expect(instance.isAnonymous).toBe(false)
  })

  it('rejects as an expected failure when the current user is not a guest', async () => {
    const fetcher = makeFetch({
      '/v1/me': () => ({ status: 200, json: { data: makeState() } }),
      '/auth/passkey/register/options': () => ({ status: 200, json: OPTIONS }),
    })
    const instance = new XidClient({ fetcher, now: () => 1000 })
    await instance.load()

    const result = await instance.upgradeGuestWithPasskey()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('validation_failed')
    expect(fetcher.calls.some((call) => call.path === '/auth/passkey/register/options')).toBe(false)
  })

  it('reports unsupported in oidc mode', async () => {
    const instance = new XidClient({
      mode: 'oidc',
      issuer: 'https://tenant.xid.dev',
      clientId: 'client_1',
      redirectUri: 'https://app.example/callback',
      fetcher: makeFetch({}),
      now: () => 1000,
    })

    const result = await instance.upgradeGuestWithPasskey()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('invalid_request')
  })

  it('maps a user cancellation to an expected failure without calling verify', async () => {
    const fetcher = makeFetch({
      '/v1/me': () => ({
        status: 200,
        json: { data: makeState({ user: makeUser({ provisionedBy: 'anonymous' }) }) },
      }),
      '/auth/passkey/register/options': () => ({ status: 200, json: OPTIONS }),
      '/auth/passkey/register/verify': () => ({ status: 200, json: { ok: true } }),
    })
    const instance = new XidClient({ fetcher, now: () => 1000 })
    stubCredentialsCreate(() => Promise.reject(new DOMException('cancelled', 'NotAllowedError')))
    await instance.load()

    const result = await instance.upgradeGuestWithPasskey()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('access_denied')
    expect(fetcher.calls.some((call) => call.path === '/auth/passkey/register/verify')).toBe(false)
  })
})
