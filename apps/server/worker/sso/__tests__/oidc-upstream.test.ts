// oidc-upstream.ts discovery 信任规则与 oidc-provider-jwks.ts 的 KV 缓存、限速强制刷新。

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@xid-kit/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/crypto')>()
  return { ...actual, importJwkForVerify: vi.fn().mockResolvedValue({} as CryptoKey) }
})

import { isAppError } from '../../lib/errors'
import { fetchDiscovery } from '../oidc-upstream'
import { createProviderKeyLoader } from '../oidc-provider-jwks'

const DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration'
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs'

function discoveryDoc(overrides: Record<string, unknown> = {}) {
  return {
    issuer: 'https://accounts.google.com',
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    jwks_uri: JWKS_URI,
    ...overrides,
  }
}

function mockFetchJson(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(body))
}

function makeKv(): KVNamespace & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value)
    }),
  } as unknown as KVNamespace & { values: Map<string, string> }
}

function jwks(kid: string) {
  return { keys: [{ kty: 'RSA', kid, alg: 'RS256', use: 'sig', n: 'x', e: 'AQAB' }] }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetchDiscovery trust', () => {
  it('accepts token and jwks endpoints on hosts other than the issuer', async () => {
    mockFetchJson(discoveryDoc())

    const discovery = await fetchDiscovery(DISCOVERY_URL, false)

    expect(discovery.token_endpoint).toBe('https://oauth2.googleapis.com/token')
  })

  it('rejects an issuer on a different origin from the discovery URL', async () => {
    mockFetchJson(discoveryDoc({ issuer: 'https://evil.example.com' }))

    await expect(fetchDiscovery(DISCOVERY_URL, false)).rejects.toSatisfy(
      (err: unknown) => isAppError(err) && err.longMessage === 'OIDC discovery trust mismatch',
    )
  })

  it('rejects a non-HTTPS endpoint', async () => {
    mockFetchJson(discoveryDoc({ token_endpoint: 'http://oauth2.googleapis.com/token' }))

    await expect(fetchDiscovery(DISCOVERY_URL, false)).rejects.toSatisfy(
      (err: unknown) => isAppError(err) && err.longMessage === 'OIDC discovery endpoint untrusted',
    )
  })

  it('rejects a private network endpoint', async () => {
    mockFetchJson(discoveryDoc({ jwks_uri: 'https://10.0.0.5/certs' }))

    await expect(fetchDiscovery(DISCOVERY_URL, false)).rejects.toSatisfy(
      (err: unknown) => isAppError(err) && err.longMessage === 'OIDC discovery endpoint untrusted',
    )
  })
})

describe('createProviderKeyLoader', () => {
  it('serves keys from KV without refetching', async () => {
    const cache = makeKv()
    cache.values.set(`provider_jwks:${JWKS_URI}`, JSON.stringify(jwks('cached')))
    const gFetch = vi.spyOn(globalThis, 'fetch')

    const keys = await createProviderKeyLoader({
      cache,
      jwksUri: JWKS_URI,
      permitsLoopbackHttp: false,
    })(false)

    expect(keys?.keys.map((k) => k.kid)).toEqual(['cached'])
    expect(gFetch).not.toHaveBeenCalled()
  })

  it('fetches and caches the JWKS on a miss', async () => {
    const cache = makeKv()
    mockFetchJson(jwks('fresh'))

    await createProviderKeyLoader({ cache, jwksUri: JWKS_URI, permitsLoopbackHttp: false })(false)

    expect(cache.put).toHaveBeenCalledWith(`provider_jwks:${JWKS_URI}`, expect.any(String), {
      expirationTtl: 3600,
    })
  })

  it('forced refresh bypasses the cache once and is throttled afterwards', async () => {
    const cache = makeKv()
    cache.values.set(`provider_jwks:${JWKS_URI}`, JSON.stringify(jwks('old')))
    const gFetch = mockFetchJson(jwks('rotated'))
    const load = createProviderKeyLoader({ cache, jwksUri: JWKS_URI, permitsLoopbackHttp: false })

    const first = await load(true)
    const second = await load(true)

    expect(first?.keys.map((k) => k.kid)).toEqual(['rotated'])
    expect(second).toBeNull()
    expect(gFetch).toHaveBeenCalledTimes(1)
    expect(cache.put).toHaveBeenCalledWith(
      `provider_jwks_refresh:${JWKS_URI}`,
      expect.any(String),
      {
        expirationTtl: 60,
      },
    )
  })
})
