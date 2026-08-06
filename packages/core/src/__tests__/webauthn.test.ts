import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  b64urlToBytes,
  bytesToB64url,
  createPasskeyCredential,
  registrationOptionsToPublicKey,
  type PasskeyRegistrationOptions,
} from '../webauthn'

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeOptions(
  overrides: Partial<PasskeyRegistrationOptions> = {},
): PasskeyRegistrationOptions {
  return {
    challenge: bytesToB64url(new Uint8Array([1, 2, 3, 4])),
    rp: { id: 'tenant.xid.dev', name: 'https://tenant.xid.dev' },
    user: {
      id: bytesToB64url(new TextEncoder().encode('user_1')),
      name: 'user_1',
      displayName: 'user_1',
    },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    ...overrides,
  }
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

describe('base64url codecs', () => {
  it('round-trips arbitrary bytes including - and _ code points', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255])
    expect(b64urlToBytes(bytesToB64url(bytes))).toEqual(bytes)
  })

  it('encodes without padding or +// characters', () => {
    const encoded = bytesToB64url(new Uint8Array([251, 255, 190]))
    expect(encoded).not.toMatch(/[+/=]/)
    expect(b64urlToBytes(encoded)).toEqual(new Uint8Array([251, 255, 190]))
  })
})

describe('registrationOptionsToPublicKey', () => {
  it('decodes challenge, user.id and excludeCredentials.id to bytes', () => {
    const options = makeOptions({
      excludeCredentials: [{ id: bytesToB64url(new Uint8Array([5, 6])), type: 'public-key' }],
    })

    const publicKey = registrationOptionsToPublicKey(options)

    expect(publicKey.challenge).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(publicKey.user.id).toEqual(new TextEncoder().encode('user_1'))
    expect(publicKey.excludeCredentials?.[0]?.id).toEqual(new Uint8Array([5, 6]))
    expect(publicKey.rp).toEqual({ id: 'tenant.xid.dev', name: 'https://tenant.xid.dev' })
  })
})

describe('createPasskeyCredential', () => {
  it('serializes the attestation into the register/verify body shape', async () => {
    const create = vi.fn().mockResolvedValue(makeAttestationCredential())
    stubCredentialsCreate(create)

    const result = await createPasskeyCredential(makeOptions(), { deviceName: 'Laptop' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      id: 'cred_1',
      rawId: bytesToB64url(new Uint8Array([9, 8, 7])),
      response: {
        clientDataJSON: bytesToB64url(new Uint8Array([11, 12])),
        attestationObject: bytesToB64url(new Uint8Array([13, 14, 15])),
      },
      transports: ['internal'],
      deviceName: 'Laptop',
    })
    const createInput = create.mock.calls[0]?.[0] as {
      publicKey: PublicKeyCredentialCreationOptions
    }
    expect(createInput.publicKey.challenge).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('maps a user cancellation (NotAllowedError) to an expected failure', async () => {
    stubCredentialsCreate(() => Promise.reject(new DOMException('cancelled', 'NotAllowedError')))

    const result = await createPasskeyCredential(makeOptions())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('access_denied')
  })

  it('maps a null credential to the same expected failure', async () => {
    stubCredentialsCreate(() => Promise.resolve(null))

    const result = await createPasskeyCredential(makeOptions())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('access_denied')
  })

  it('reports unsupported when the browser has no credentials API', async () => {
    vi.stubGlobal('navigator', {})

    const result = await createPasskeyCredential(makeOptions())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not_implemented')
  })

  it('rethrows unexpected DOMExceptions instead of swallowing them', async () => {
    stubCredentialsCreate(() => Promise.reject(new DOMException('boom', 'SecurityError')))

    await expect(createPasskeyCredential(makeOptions())).rejects.toMatchObject({
      name: 'SecurityError',
    })
  })
})
