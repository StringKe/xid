// getAuth / requireAuth server helper 单元测试。
// 覆盖:Authorization header / cookie 认证路径、sessionStorage fallback、
// requireAuth redirect 行为、负路径(无 token、过期 token)。
import { describe, it, expect } from 'vitest'

import { getAuth, requireAuth } from '../server'
import type { AuthObject } from '../types'
import { makeEs256Key, mintAccessToken, mintExpiredToken } from './test-keys'

// ---- helpers ----

function makeRequest(url: string, headers?: Record<string, string>): Request {
  return new Request(url, { headers })
}

// ---- getAuth: Authorization header path ----

describe('getAuth via Authorization: Bearer header', () => {
  it('returns authenticated AuthObject for valid token in Authorization header', async () => {
    const key = await makeEs256Key('kid_auth_header')
    const token = await mintAccessToken(key)

    const request = makeRequest('https://app.example.com/dashboard', {
      authorization: `Bearer ${token}`,
    })
    const auth = await getAuth(request, { jwtKey: key.publicJwk })

    expect(auth.userId).toBe('user_test')
    expect(auth.sessionId).toBe('sess_test')
    expect(auth.claims).toBeTruthy()
  })

  it('returns unauthenticated when no Authorization header present', async () => {
    const key = await makeEs256Key('kid_no_header')
    const request = makeRequest('https://app.example.com/dashboard')
    const auth = await getAuth(request, { jwtKey: key.publicJwk })

    expect(auth.userId).toBeNull()
    expect(auth.sessionId).toBeNull()
  })

  it('returns unauthenticated for expired token in Authorization header', async () => {
    const key = await makeEs256Key('kid_expired')
    const expired = await mintExpiredToken(key)

    const request = makeRequest('https://app.example.com/dashboard', {
      authorization: `Bearer ${expired}`,
    })
    const auth = await getAuth(request, { jwtKey: key.publicJwk })

    expect(auth.userId).toBeNull()
  })
})

// ---- getAuth: explicit application JWT cookie path ----

describe('getAuth via application JWT cookie', () => {
  it('returns authenticated AuthObject for valid token in an explicitly named cookie', async () => {
    const key = await makeEs256Key('kid_cookie')
    const token = await mintAccessToken(key)

    const request = makeRequest('https://app.example.com/dashboard', {
      cookie: `__Host-app.xid.jwt=${encodeURIComponent(token)}`,
    })
    const auth = await getAuth(request, {
      jwtKey: key.publicJwk,
      jwtCookieName: '__Host-app.xid.jwt',
    })

    expect(auth.userId).toBe('user_test')
  })

  it('returns unauthenticated for expired token in cookie', async () => {
    const key = await makeEs256Key('kid_cookie_expired')
    const expired = await mintExpiredToken(key)

    const request = makeRequest('https://app.example.com/dashboard', {
      cookie: `__Host-app.xid.jwt=${encodeURIComponent(expired)}`,
    })
    const auth = await getAuth(request, {
      jwtKey: key.publicJwk,
      jwtCookieName: '__Host-app.xid.jwt',
    })

    expect(auth.userId).toBeNull()
  })

  it('does not try to verify a Core opaque refresh cookie locally', async () => {
    const key = await makeEs256Key('kid_opaque')
    const request = makeRequest('https://app.example.com/dashboard', {
      cookie: '__Host-xid.rt.sess_test=opaque-refresh',
    })

    const auth = await getAuth(request, { jwtKey: key.publicJwk })

    expect(auth.userId).toBeNull()
  })

  it('exchanges a Core opaque cookie when the same-origin endpoint is configured', async () => {
    const key = await makeEs256Key('kid_opaque_exchange')
    const token = await mintAccessToken(key)
    const request = makeRequest('https://app.example.com/dashboard', {
      cookie: '__Host-xid.rt.sess_test=opaque-refresh',
    })

    const auth = await getAuth(request, {
      jwtKey: key.publicJwk,
      sessionTokenExchange: {
        endpoint: '/v1/sessions/token',
        fetcher: (async () => Response.json({ token })) as typeof fetch,
      },
    })

    expect(auth.userId).toBe('user_test')
    expect(auth.sessionId).toBe('sess_test')
  })
})

// ---- getAuth: sessionStorage fallback ----

describe('getAuth via sessionStorage fallback', () => {
  it('returns authenticated AuthObject when token found in sessionStorage', async () => {
    const key = await makeEs256Key('kid_ss')
    const token = await mintAccessToken(key)

    // Mock sessionStorage: getSession returns a session holding the token under default key.
    const mockSessionStorage = {
      async getSession(_cookie: string | null | undefined) {
        return {
          get: (k: string) => (k === 'xid:access_token' ? token : undefined),
        }
      },
    }

    const request = makeRequest('https://app.example.com/dashboard')
    const auth = await getAuth(request, {
      jwtKey: key.publicJwk,
      sessionStorage: mockSessionStorage,
    })

    expect(auth.userId).toBe('user_test')
  })

  it('returns unauthenticated when sessionStorage has no token', async () => {
    const key = await makeEs256Key('kid_ss_empty')
    const mockSessionStorage = {
      async getSession(_cookie: string | null | undefined) {
        return {
          get: (_k: string) => undefined,
        }
      },
    }

    const request = makeRequest('https://app.example.com/dashboard')
    const auth = await getAuth(request, {
      jwtKey: key.publicJwk,
      sessionStorage: mockSessionStorage,
    })

    expect(auth.userId).toBeNull()
  })

  it('returns unauthenticated when sessionStorage token is expired', async () => {
    const key = await makeEs256Key('kid_ss_exp')
    const expired = await mintExpiredToken(key)

    const mockSessionStorage = {
      async getSession(_cookie: string | null | undefined) {
        return {
          get: (k: string) => (k === 'xid:access_token' ? expired : undefined),
        }
      },
    }

    const request = makeRequest('https://app.example.com/dashboard')
    const auth = await getAuth(request, {
      jwtKey: key.publicJwk,
      sessionStorage: mockSessionStorage,
    })

    expect(auth.userId).toBeNull()
  })
})

// ---- getAuth: org claims extraction ----

describe('getAuth extracts org claims from token', () => {
  it('populates orgId/orgRole/orgPermissions from token claims', async () => {
    const key = await makeEs256Key('kid_org')
    const token = await mintAccessToken(key, {
      active_org_id: 'org_abc',
      org_role: 'admin',
      org_permissions: ['read:users', 'write:users'],
    })

    const request = makeRequest('https://app.example.com/dashboard', {
      authorization: `Bearer ${token}`,
    })
    const auth = await getAuth(request, { jwtKey: key.publicJwk })

    expect(auth.orgId).toBe('org_abc')
    expect(auth.orgRole).toBe('admin')
    expect(auth.orgPermissions).toEqual(['read:users', 'write:users'])
  })

  it('returns undefined orgId when no active_org_id in claims', async () => {
    const key = await makeEs256Key('kid_no_org')
    const token = await mintAccessToken(key)

    const request = makeRequest('https://app.example.com/dashboard', {
      authorization: `Bearer ${token}`,
    })
    const auth = await getAuth(request, { jwtKey: key.publicJwk })

    expect(auth.orgId).toBeUndefined()
    expect(auth.orgRole).toBeUndefined()
    expect(auth.orgPermissions).toBeUndefined()
  })
})

// ---- requireAuth ----

describe('requireAuth', () => {
  it('returns AuthObject for authenticated request', async () => {
    const key = await makeEs256Key('kid_require')
    const token = await mintAccessToken(key)

    const request = makeRequest('https://app.example.com/dashboard', {
      authorization: `Bearer ${token}`,
    })
    const auth = await requireAuth(request, { jwtKey: key.publicJwk })

    expect(auth.userId).toBe('user_test')
  })

  it('throws Response redirect with 302 for unauthenticated request', async () => {
    const key = await makeEs256Key('kid_require_unauth')
    const request = makeRequest('https://app.example.com/dashboard')

    let thrown: unknown
    try {
      await requireAuth(request, { jwtKey: key.publicJwk })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(Response)
    const res = thrown as Response
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/login')
  })

  it('includes return_to in redirect URL by default', async () => {
    const key = await makeEs256Key('kid_require_return')
    const request = makeRequest('https://app.example.com/protected/page')

    let thrown: unknown
    try {
      await requireAuth(request, { jwtKey: key.publicJwk })
    } catch (err) {
      thrown = err
    }

    const res = thrown as Response
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('return_to=')
    expect(location).toContain(encodeURIComponent('https://app.example.com/protected/page'))
  })

  it('redirects to custom path when specified', async () => {
    const key = await makeEs256Key('kid_require_custom')
    const request = makeRequest('https://app.example.com/dashboard')

    let thrown: unknown
    try {
      await requireAuth(request, { jwtKey: key.publicJwk }, { redirectPath: '/sign-in' })
    } catch (err) {
      thrown = err
    }

    const res = thrown as Response
    expect(res.headers.get('location')).toContain('/sign-in')
  })

  it('omits return_to when preserveReturnTo is false', async () => {
    const key = await makeEs256Key('kid_no_return')
    const request = makeRequest('https://app.example.com/dashboard')

    let thrown: unknown
    try {
      await requireAuth(request, { jwtKey: key.publicJwk }, { preserveReturnTo: false })
    } catch (err) {
      thrown = err
    }

    const res = thrown as Response
    const location = res.headers.get('location') ?? ''
    expect(location).not.toContain('return_to=')
  })

  it('AuthObject type guard: auth.userId is string after requireAuth', async () => {
    const key = await makeEs256Key('kid_type_guard')
    const token = await mintAccessToken(key)

    const request = makeRequest('https://app.example.com/dashboard', {
      authorization: `Bearer ${token}`,
    })
    const auth: AuthObject = await requireAuth(request, { jwtKey: key.publicJwk })

    // TypeScript 类型守卫:到这里 userId 必须是 string(不是 null)。
    const userId: string = auth.userId
    expect(typeof userId).toBe('string')
  })
})
