// provider JWKS 未知 kid 时的受限速强制刷新。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyWithProviderJwks } from '../social-jwks'
import { makeKv, setupProviderJwt } from './social-test-helpers'

const JWKS_URI = 'https://login.example.com/keys'
const ISSUER = 'https://login.example.com'
const AUDIENCE = 'client-1'

async function rotatedProvider() {
  const old = await setupProviderJwt({
    issuer: ISSUER,
    audience: AUDIENCE,
    nonce: 'n',
    kid: 'old-kid',
  })
  const rotated = await setupProviderJwt({
    issuer: ISSUER,
    audience: AUDIENCE,
    nonce: 'n',
    kid: 'new-kid',
  })
  return { oldJwks: old.jwks, newJwks: rotated.jwks, newToken: rotated.idToken }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('verifyWithProviderJwks', () => {
  it('refetches the JWKS once and verifies when the cached set lacks the token kid', async () => {
    const { oldJwks, newJwks, newToken } = await rotatedProvider()
    const cache = makeKv()
    await cache.put(`provider_jwks:${JWKS_URI}`, JSON.stringify(oldJwks))
    const fetchMock = vi.fn(async () => Response.json(newJwks))
    vi.stubGlobal('fetch', fetchMock)

    const verified = await verifyWithProviderJwks({
      env: { CACHE: cache } as unknown as Env,
      jwksUri: JWKS_URI,
      idToken: newToken,
      audience: AUDIENCE,
    })

    expect(verified.header.kid).toBe('new-kid')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await cache.get(`provider_jwks:${JWKS_URI}`)).toBe(JSON.stringify(newJwks))
  })

  it('does not refetch again inside the minimum refresh interval', async () => {
    const { oldJwks, newToken } = await rotatedProvider()
    const cache = makeKv()
    await cache.put(`provider_jwks:${JWKS_URI}`, JSON.stringify(oldJwks))
    await cache.put(`provider_jwks_refresh:${JWKS_URI}`, String(Date.now()))
    const fetchMock = vi.fn(async () => Response.json(oldJwks))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      verifyWithProviderJwks({
        env: { CACHE: cache } as unknown as Env,
        jwksUri: JWKS_URI,
        idToken: newToken,
        audience: AUDIENCE,
      }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects after one refresh when the provider still does not publish the kid', async () => {
    const { oldJwks, newToken } = await rotatedProvider()
    const cache = makeKv()
    await cache.put(`provider_jwks:${JWKS_URI}`, JSON.stringify(oldJwks))
    const fetchMock = vi.fn(async () => Response.json(oldJwks))
    vi.stubGlobal('fetch', fetchMock)
    const env = { CACHE: cache } as unknown as Env

    await expect(
      verifyWithProviderJwks({ env, jwksUri: JWKS_URI, idToken: newToken, audience: AUDIENCE }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' })
    await expect(
      verifyWithProviderJwks({ env, jwksUri: JWKS_URI, idToken: newToken, audience: AUDIENCE }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not refresh for a bad signature with a known kid', async () => {
    const { newJwks } = await rotatedProvider()
    const forged = await setupProviderJwt({
      issuer: ISSUER,
      audience: AUDIENCE,
      nonce: 'n',
      kid: 'new-kid',
    })
    const cache = makeKv()
    await cache.put(`provider_jwks:${JWKS_URI}`, JSON.stringify(newJwks))
    const fetchMock = vi.fn(async () => Response.json(newJwks))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      verifyWithProviderJwks({
        env: { CACHE: cache } as unknown as Env,
        jwksUri: JWKS_URI,
        idToken: forged.idToken,
        audience: AUDIENCE,
      }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches and caches the JWKS on a cache miss without a second request', async () => {
    const { newJwks, newToken } = await rotatedProvider()
    const cache = makeKv()
    const fetchMock = vi.fn(async () => Response.json(newJwks))
    vi.stubGlobal('fetch', fetchMock)

    await verifyWithProviderJwks({
      env: { CACHE: cache } as unknown as Env,
      jwksUri: JWKS_URI,
      idToken: newToken,
      audience: AUDIENCE,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await cache.get(`provider_jwks:${JWKS_URI}`)).toBe(JSON.stringify(newJwks))
  })
})
