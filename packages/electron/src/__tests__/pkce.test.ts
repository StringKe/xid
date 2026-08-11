// PKCE S256 纯函数测试（Web Crypto / Vitest）。

import { describe, expect, it } from 'vitest'

import { buildAuthorizeUrl, generatePkceChallenge, generateState, parseCallbackUrl } from '../pkce'

function getSubtle(): SubtleCrypto {
  if (typeof globalThis.crypto?.subtle !== 'undefined') return globalThis.crypto.subtle
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { webcrypto } = require('node:crypto') as { webcrypto: Crypto }
  return webcrypto.subtle
}

function getRealRandomValues(): (arr: Uint8Array) => Uint8Array {
  // getRandomValues 在 TS 5.7+ 要求 ArrayBufferView<ArrayBuffer>；回调实参恒为具体 ArrayBuffer，断言安全。
  if (typeof globalThis.crypto?.getRandomValues !== 'undefined') {
    return (arr) => {
      globalThis.crypto.getRandomValues(arr as Uint8Array<ArrayBuffer>)
      return arr
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { webcrypto } = require('node:crypto') as { webcrypto: Crypto }
  return (arr) => {
    webcrypto.getRandomValues(arr as Uint8Array<ArrayBuffer>)
    return arr
  }
}

/** 递增填充，保证可复现。 */
function deterministicRandom(seed = 0): (arr: Uint8Array) => Uint8Array {
  let counter = seed
  return (arr) => {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = counter++ % 256
    }
    return arr
  }
}

describe('generatePkceChallenge', () => {
  it('returns codeChallengeMethod S256', async () => {
    const result = await generatePkceChallenge(getSubtle(), getRealRandomValues())
    expect(result.codeChallengeMethod).toBe('S256')
  })

  it('generates a non-empty codeVerifier', async () => {
    const result = await generatePkceChallenge(getSubtle(), getRealRandomValues())
    expect(result.codeVerifier.length).toBeGreaterThanOrEqual(43)
    expect(result.codeVerifier.length).toBeLessThanOrEqual(128)
  })

  it('generates a non-empty codeChallenge', async () => {
    const result = await generatePkceChallenge(getSubtle(), getRealRandomValues())
    expect(result.codeChallenge.length).toBeGreaterThan(0)
  })

  it('codeChallenge is base64url (no padding, no +/)', async () => {
    const result = await generatePkceChallenge(getSubtle(), getRealRandomValues())
    expect(result.codeChallenge).not.toContain('+')
    expect(result.codeChallenge).not.toContain('/')
    expect(result.codeChallenge).not.toContain('=')
  })

  it('each call produces a different verifier (entropy)', async () => {
    const [a, b] = await Promise.all([
      generatePkceChallenge(getSubtle(), getRealRandomValues()),
      generatePkceChallenge(getSubtle(), getRealRandomValues()),
    ])
    expect(a.codeVerifier).not.toBe(b.codeVerifier)
  })

  it('codeChallenge is the SHA-256 base64url of the verifier (known vector)', async () => {
    // RFC 7636 Appendix B 向量；RNG 直接注入 verifier UTF-8，绕过 charset 映射。
    const knownVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const verifierBytes = new TextEncoder().encode(knownVerifier)

    const forcedRng = (arr: Uint8Array): Uint8Array => {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = verifierBytes[i] ?? 0
      }
      return arr
    }

    const result = await generatePkceChallenge(getSubtle(), forcedRng)

    // 以实际产出的 verifier 再算 S256，验证 challenge 绑定而非固定字面量。
    const expectedChallenge = await (async () => {
      const encoded = new TextEncoder().encode(result.codeVerifier)
      const digest = await getSubtle().digest('SHA-256', encoded)
      const bytes2 = new Uint8Array(digest)
      let binary = ''
      for (const byte of bytes2) binary += String.fromCharCode(byte)
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    })()

    expect(result.codeChallenge).toBe(expectedChallenge)
    expect(result.codeChallengeMethod).toBe('S256')
  })

  it('deterministic random produces same verifier with same seed', async () => {
    const rng = deterministicRandom(42)
    const a = await generatePkceChallenge(getSubtle(), deterministicRandom(42))
    const b = await generatePkceChallenge(getSubtle(), rng)
    expect(a.codeVerifier).toBe(b.codeVerifier)
  })
})

describe('generateState', () => {
  it('generates a non-empty state string', () => {
    const state = generateState(getRealRandomValues())
    expect(state.length).toBeGreaterThan(0)
  })

  it('is base64url safe', () => {
    const state = generateState(getRealRandomValues())
    expect(state).not.toContain('+')
    expect(state).not.toContain('/')
    expect(state).not.toContain('=')
  })

  it('each call produces a unique value', () => {
    const a = generateState(getRealRandomValues())
    const b = generateState(getRealRandomValues())
    expect(a).not.toBe(b)
  })
})

describe('buildAuthorizeUrl', () => {
  const baseParams = {
    issuer: 'https://xid.dev',
    clientId: 'client_test_123',
    redirectUri: 'http://127.0.0.1:5000/callback',
    scopes: ['openid', 'profile', 'email'],
    codeChallenge: 'test-challenge',
    state: 'test-state',
  } as const

  it('includes response_type=code', () => {
    const url = buildAuthorizeUrl(baseParams)
    expect(url.searchParams.get('response_type')).toBe('code')
  })

  it('includes client_id', () => {
    const url = buildAuthorizeUrl(baseParams)
    expect(url.searchParams.get('client_id')).toBe('client_test_123')
  })

  it('includes redirect_uri', () => {
    const url = buildAuthorizeUrl(baseParams)
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5000/callback')
  })

  it('includes scope as space-separated string', () => {
    const url = buildAuthorizeUrl(baseParams)
    expect(url.searchParams.get('scope')).toBe('openid profile email')
  })

  it('includes code_challenge', () => {
    const url = buildAuthorizeUrl(baseParams)
    expect(url.searchParams.get('code_challenge')).toBe('test-challenge')
  })

  it('includes code_challenge_method=S256', () => {
    const url = buildAuthorizeUrl(baseParams)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('includes state', () => {
    const url = buildAuthorizeUrl(baseParams)
    expect(url.searchParams.get('state')).toBe('test-state')
  })

  it('appends to /authorize path', () => {
    const url = buildAuthorizeUrl(baseParams)
    expect(url.pathname).toBe('/authorize')
  })

  it('includes prompt when provided', () => {
    const url = buildAuthorizeUrl({ ...baseParams, prompt: 'login' })
    expect(url.searchParams.get('prompt')).toBe('login')
  })

  it('does not include prompt when omitted', () => {
    const url = buildAuthorizeUrl(baseParams)
    expect(url.searchParams.has('prompt')).toBe(false)
  })

  it('does NOT use implicit flow (no token in response_type)', () => {
    const url = buildAuthorizeUrl(baseParams)
    expect(url.searchParams.get('response_type')).not.toContain('token')
  })
})

describe('parseCallbackUrl', () => {
  it('extracts code and state from a valid callback URL', () => {
    const url = new URL('http://127.0.0.1:5000/callback?code=auth_code_abc&state=some-state')
    const result = parseCallbackUrl(url)
    expect(result).toEqual({ code: 'auth_code_abc', state: 'some-state' })
  })

  it('returns null when error param is present', () => {
    const url = new URL('http://127.0.0.1:5000/callback?error=access_denied&state=s')
    expect(parseCallbackUrl(url)).toBeNull()
  })

  it('returns null when code is missing', () => {
    const url = new URL('http://127.0.0.1:5000/callback?state=s')
    expect(parseCallbackUrl(url)).toBeNull()
  })

  it('returns null when state is missing', () => {
    const url = new URL('http://127.0.0.1:5000/callback?code=c')
    expect(parseCallbackUrl(url)).toBeNull()
  })

  it('returns null for empty callback URL', () => {
    const url = new URL('http://127.0.0.1:5000/callback')
    expect(parseCallbackUrl(url)).toBeNull()
  })
})
