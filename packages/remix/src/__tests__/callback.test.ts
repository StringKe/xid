// handleCallback unit tests: OAuth callback processing core logic paths.
// @remix-run/node redirect is a peer dep (not installed); vi.mock injects a minimal implementation.
// token endpoint calls are intercepted via vi.stubGlobal fetch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock @remix-run/node redirect (peer dep, provided by consumer at runtime).
vi.mock('@remix-run/node', () => ({
  redirect: (url: string, init?: { headers?: Record<string, string> | Headers }) => {
    const headers = new Headers(
      init?.headers instanceof Headers
        ? Object.fromEntries(init.headers.entries())
        : (init?.headers ?? {}),
    )
    return new Response(null, {
      status: 302,
      headers: { location: url, ...Object.fromEntries(headers.entries()) },
    })
  },
}))

const { handleCallback } = await import('../callback')
import type { XidSession, XidSessionStorage } from '../types'
import { XID_SESSION_ACCESS_TOKEN_KEY, XID_SESSION_REFRESH_TOKEN_KEY } from '../types'

// ---- helpers ----

type SessionStore = Map<string, string>

function makeTestSession(store: SessionStore): XidSession {
  return {
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, value)
    },
    unset: (key) => {
      store.delete(key)
    },
    has: (key) => store.has(key),
    get data() {
      return Object.fromEntries(store.entries())
    },
  }
}

function makeTestSessionStorage(store: SessionStore): XidSessionStorage {
  return {
    async getSession(_cookie) {
      return makeTestSession(store)
    },
    async commitSession(_session) {
      return '__xid_session=committed; HttpOnly; SameSite=Lax'
    },
    async destroySession(_session) {
      return '__xid_session=; Max-Age=0'
    },
  }
}

const VALID_TOKEN_RESPONSE = {
  access_token: 'at.valid',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'rt.valid',
}

function mockFetchSuccess(body: unknown = VALID_TOKEN_RESPONSE): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
}

function mockFetchError(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
}

function mockFetchNetworkError(): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---- success path ----
// All success paths include state + code_verifier in session (both are required).

describe('handleCallback success path', () => {
  it('uses the Core root /token endpoint by default', async () => {
    mockFetchSuccess()
    const store: SessionStore = new Map([
      ['xid:oauth_state', 'state_default_endpoint'],
      ['xid:code_verifier', 'cv_default_endpoint'],
    ])
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request(
      'https://app.example.com/auth/callback?code=auth_code_123&state=state_default_endpoint',
    )
    await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
    })

    expect(fetch).toHaveBeenCalledWith(
      'https://xid.dev/token',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('uses an explicit token endpoint override', async () => {
    mockFetchSuccess()
    const store: SessionStore = new Map([
      ['xid:oauth_state', 'state_custom_endpoint'],
      ['xid:code_verifier', 'cv_custom_endpoint'],
    ])
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request(
      'https://app.example.com/auth/callback?code=auth_code_123&state=state_custom_endpoint',
    )
    await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
      tokenEndpoint: 'https://identity.example.com/token',
    })

    expect(fetch).toHaveBeenCalledWith(
      'https://identity.example.com/token',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('exchanges code, writes tokens to session, and redirects to defaultReturnTo', async () => {
    mockFetchSuccess()
    const store: SessionStore = new Map([
      ['xid:oauth_state', 'state_abc'],
      ['xid:code_verifier', 'cv_abc'],
    ])
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request(
      'https://app.example.com/auth/callback?code=auth_code_123&state=state_abc',
    )
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
      defaultReturnTo: '/dashboard',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.response.status).toBe(302)
    expect(result.response.headers.get('location')).toBe('/dashboard')
  })

  it('stores access_token and refresh_token in session after exchange', async () => {
    mockFetchSuccess()
    const store: SessionStore = new Map([
      ['xid:oauth_state', 'st1'],
      ['xid:code_verifier', 'cv1'],
    ])
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request(
      'https://app.example.com/auth/callback?code=auth_code_123&state=st1',
    )
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
    })

    expect(result.ok).toBe(true)
    expect(store.get(XID_SESSION_ACCESS_TOKEN_KEY)).toBe('at.valid')
    expect(store.get(XID_SESSION_REFRESH_TOKEN_KEY)).toBe('rt.valid')
  })

  it('redirects to return_to query param when it is a relative path', async () => {
    mockFetchSuccess()
    const store: SessionStore = new Map([
      ['xid:oauth_state', 'st2'],
      ['xid:code_verifier', 'cv2'],
    ])
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request(
      'https://app.example.com/auth/callback?code=c&state=st2&return_to=%2Fprofile',
    )
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
      defaultReturnTo: '/dashboard',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.response.headers.get('location')).toBe('/profile')
  })

  it('redirects to session-stored return_to when query param absent', async () => {
    mockFetchSuccess()
    const store: SessionStore = new Map([
      ['xid:oauth_state', 'st3'],
      ['xid:code_verifier', 'cv3'],
      ['xid:return_to', '/orders'],
    ])
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request('https://app.example.com/auth/callback?code=c&state=st3')
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
      defaultReturnTo: '/dashboard',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.response.headers.get('location')).toBe('/orders')
  })

  it('falls back to / when no return_to and no defaultReturnTo', async () => {
    mockFetchSuccess()
    const store: SessionStore = new Map([
      ['xid:oauth_state', 'st4'],
      ['xid:code_verifier', 'cv4'],
    ])
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request('https://app.example.com/auth/callback?code=c&state=st4')
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.response.headers.get('location')).toBe('/')
  })
})

// ---- state/CSRF enforcement ----

describe('handleCallback state/CSRF validation', () => {
  it('rejects when state param is absent from the callback URL', async () => {
    const store: SessionStore = new Map([['xid:oauth_state', 'st_stored']])
    const sessionStorage = makeTestSessionStorage(store)

    // No state param in URL -- must be rejected even if session has a stored state.
    const request = new Request('https://app.example.com/auth/callback?code=c')
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/state mismatch/i)
  })

  it('rejects when state param is present but session state is missing', async () => {
    mockFetchSuccess()
    const store: SessionStore = new Map()
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request('https://app.example.com/auth/callback?code=c&state=incoming_state')
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/state mismatch/i)
  })

  it('rejects when state param does not match stored state', async () => {
    mockFetchSuccess()
    const store: SessionStore = new Map([['xid:oauth_state', 'correct_state']])
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request('https://app.example.com/auth/callback?code=c&state=wrong_state')
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/state mismatch/i)
  })

  it('proceeds when state matches stored session state', async () => {
    mockFetchSuccess()
    const store: SessionStore = new Map([
      ['xid:oauth_state', 'matching_state'],
      ['xid:code_verifier', 'cv_match'],
    ])
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request('https://app.example.com/auth/callback?code=c&state=matching_state')
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
    })

    expect(result.ok).toBe(true)
  })
})

// ---- PKCE enforcement ----

describe('handleCallback PKCE enforcement', () => {
  it('rejects when code_verifier is missing from session', async () => {
    mockFetchSuccess()
    // State matches but no code_verifier in session.
    const store: SessionStore = new Map([['xid:oauth_state', 'st_pkce']])
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request('https://app.example.com/auth/callback?code=c&state=st_pkce')
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/pkce/i)
  })

  it('includes code_verifier in the token exchange request', async () => {
    const capturedBodies: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init: RequestInit) => {
        capturedBodies.push(String(init.body))
        return Promise.resolve(
          new Response(JSON.stringify(VALID_TOKEN_RESPONSE), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }),
    )

    const store: SessionStore = new Map([
      ['xid:oauth_state', 'st_cv'],
      ['xid:code_verifier', 'verifier_xyz'],
    ])
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request('https://app.example.com/auth/callback?code=c&state=st_cv')
    await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
    })

    expect(capturedBodies[0]).toContain('code_verifier=verifier_xyz')
  })
})

// ---- open redirect protection ----

describe('handleCallback return_to open redirect prevention', () => {
  it('rejects absolute URL in return_to query param (falls back to /)', async () => {
    mockFetchSuccess()
    const store: SessionStore = new Map([
      ['xid:oauth_state', 'st_or'],
      ['xid:code_verifier', 'cv_or'],
    ])
    const sessionStorage = makeTestSessionStorage(store)

    const malicious = encodeURIComponent('https://evil.com/steal')
    const request = new Request(
      `https://app.example.com/auth/callback?code=c&state=st_or&return_to=${malicious}`,
    )
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
      defaultReturnTo: '/safe',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Must NOT redirect to evil.com; falls back to defaultReturnTo.
    expect(result.response.headers.get('location')).toBe('/safe')
    expect(result.response.headers.get('location')).not.toContain('evil.com')
  })

  it('rejects protocol-relative URL (//evil.com) in return_to', async () => {
    mockFetchSuccess()
    const store: SessionStore = new Map([
      ['xid:oauth_state', 'st_pr'],
      ['xid:code_verifier', 'cv_pr'],
    ])
    const sessionStorage = makeTestSessionStorage(store)

    const malicious = encodeURIComponent('//evil.com/path')
    const request = new Request(
      `https://app.example.com/auth/callback?code=c&state=st_pr&return_to=${malicious}`,
    )
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
      defaultReturnTo: '/safe',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.response.headers.get('location')).toBe('/safe')
  })
})

// ---- error paths ----

describe('handleCallback error paths', () => {
  it('returns error when authorization code is missing from URL', async () => {
    const store: SessionStore = new Map()
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request('https://app.example.com/auth/callback')
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/missing authorization code/i)
  })

  it('returns error when token endpoint returns HTTP error', async () => {
    mockFetchError(400, { error: 'invalid_grant', error_description: 'Code expired' })
    const store: SessionStore = new Map([
      ['xid:oauth_state', 'st_err'],
      ['xid:code_verifier', 'cv_err'],
    ])
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request('https://app.example.com/auth/callback?code=bad_code&state=st_err')
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Code expired')
  })

  it('returns error on token endpoint network failure', async () => {
    mockFetchNetworkError()
    const store: SessionStore = new Map([
      ['xid:oauth_state', 'st_nf'],
      ['xid:code_verifier', 'cv_nf'],
    ])
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request('https://app.example.com/auth/callback?code=net_fail&state=st_nf')
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/network error/i)
  })

  it('returns error when token response is missing access_token', async () => {
    mockFetchSuccess({ token_type: 'Bearer' })
    const store: SessionStore = new Map([
      ['xid:oauth_state', 'st_noat'],
      ['xid:code_verifier', 'cv_noat'],
    ])
    const sessionStorage = makeTestSessionStorage(store)

    const request = new Request('https://app.example.com/auth/callback?code=no_token&state=st_noat')
    const result = await handleCallback(request, {
      clientId: 'client_test_123',
      redirectUri: 'https://app.example.com/auth/callback',
      sessionStorage,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/missing access_token/i)
  })
})
