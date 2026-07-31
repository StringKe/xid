import { exportPublicJwk, signJwt, type PublicJwk } from '@xid-kit/crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { verifyNativeIdToken } from '../id-token'

const CLIENT_ID = 'client_native'
const KID = 'kid_native'

let signingKey: CryptoKey
let publicJwk: PublicJwk

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  signingKey = pair.privateKey
  publicJwk = await exportPublicJwk(pair.publicKey, KID, 'ES256')
})

async function mintIdToken(issuer: string, claims: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt(
    {
      header: { alg: 'ES256', kid: KID },
      payload: {
        iss: issuer,
        sub: 'user_native',
        aud: CLIENT_ID,
        exp: now + 3600,
        iat: now,
        nonce: 'nonce_expected',
        ...claims,
      },
    },
    signingKey,
  )
}

function jwksFetcher(): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
}

describe('verifyNativeIdToken', () => {
  it('verifies the signature and exact authorization nonce', async () => {
    const issuer = 'https://native-nonce.xid.dev'
    const idToken = await mintIdToken(issuer)

    await expect(
      verifyNativeIdToken(idToken, {
        issuer,
        clientId: CLIENT_ID,
        expectedNonce: 'nonce_expected',
        fetcher: jwksFetcher(),
      }),
    ).resolves.toMatchObject({
      iss: issuer,
      sub: 'user_native',
      aud: CLIENT_ID,
      nonce: 'nonce_expected',
    })
  })

  it('rejects a nonce mismatch or a missing nonce', async () => {
    const issuer = 'https://native-nonce-rejection.xid.dev'
    const mismatched = await mintIdToken(issuer)
    const missing = await mintIdToken(issuer, { nonce: undefined })
    const fetcher = jwksFetcher()

    await expect(
      verifyNativeIdToken(mismatched, {
        issuer,
        clientId: CLIENT_ID,
        expectedNonce: 'nonce_other',
        fetcher,
      }),
    ).rejects.toThrow('nonce mismatch')
    await expect(
      verifyNativeIdToken(missing, {
        issuer,
        clientId: CLIENT_ID,
        expectedNonce: 'nonce_expected',
        fetcher,
      }),
    ).rejects.toThrow('nonce mismatch')
  })

  it('requires azp when the ID token has multiple audiences', async () => {
    const issuer = 'https://native-azp.xid.dev'
    const withoutAzp = await mintIdToken(issuer, {
      aud: [CLIENT_ID, 'other_client'],
    })
    const withAzp = await mintIdToken(issuer, {
      aud: [CLIENT_ID, 'other_client'],
      azp: CLIENT_ID,
    })
    const fetcher = jwksFetcher()

    await expect(
      verifyNativeIdToken(withoutAzp, {
        issuer,
        clientId: CLIENT_ID,
        expectedNonce: 'nonce_expected',
        fetcher,
      }),
    ).rejects.toThrow('azp mismatch')
    await expect(
      verifyNativeIdToken(withAzp, {
        issuer,
        clientId: CLIENT_ID,
        expectedNonce: 'nonce_expected',
        fetcher,
      }),
    ).resolves.toMatchObject({ azp: CLIENT_ID })
  })
})
