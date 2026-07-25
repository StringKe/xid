// Tests for useSignIn RN hook -- CSRF guard, cancel, and error state paths.
// Uses @testing-library/react renderHook so useState dispatches are fully functional.

import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'

import { XidRnContext } from '../xid-rn-context'
import type { XidRnContextValue } from '../xid-rn-context'
import { useSignIn } from '../use-sign-in'
import type { TokenCache } from '../token-cache'
import type { BrowserInterface } from '../browser-interface'
import { pendingAuthorizationKey } from '../token-exchange'

const ISSUER = 'https://xid.dev'
const CLIENT_ID = 'client_test'
const REDIRECT_URI = 'myapp://auth/callback'

function makeTokenCache(): TokenCache & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    getToken: vi.fn(async (key: string) => store.get(key) ?? null),
    saveToken: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    deleteToken: vi.fn(async (key: string) => {
      store.delete(key)
    }),
  }
}

function makeRnCtx(cache: TokenCache, browser: BrowserInterface): XidRnContextValue {
  return {
    tokenCache: cache,
    browser,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scopes: ['openid', 'profile', 'email'] as const,
    isLoaded: true,
    session: null,
    restoreSession: async () => null,
    getAccessToken: async () => null,
    clearSession: async () => undefined,
  }
}

function makeWrapper(
  rnCtx: XidRnContextValue,
): ({ children }: { children: ReactNode }) => ReactNode {
  return ({ children }) => <XidRnContext.Provider value={rnCtx}>{children}</XidRnContext.Provider>
}

describe('useSignIn initial state', () => {
  it('starts with idle state', () => {
    const cache = makeTokenCache()
    const browser: BrowserInterface = { openAuthSession: vi.fn() }

    const { result } = renderHook(() => useSignIn(), {
      wrapper: makeWrapper(makeRnCtx(cache, browser)),
    })

    expect(result.current.signInState.status).toBe('idle')
  })

  it('exposes signIn and handleRedirect functions', () => {
    const cache = makeTokenCache()
    const browser: BrowserInterface = { openAuthSession: vi.fn() }

    const { result } = renderHook(() => useSignIn(), {
      wrapper: makeWrapper(makeRnCtx(cache, browser)),
    })

    expect(typeof result.current.signIn).toBe('function')
    expect(typeof result.current.handleRedirect).toBe('function')
  })
})

describe('handleRedirect CSRF guard', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sets error state when redirect state does not match stored state', async () => {
    const cache = makeTokenCache()
    await cache.saveToken(pendingAuthorizationKey('stored_state_abc'), 'verifier_xyz')

    const browser: BrowserInterface = { openAuthSession: vi.fn() }
    const { result } = renderHook(() => useSignIn(), {
      wrapper: makeWrapper(makeRnCtx(cache, browser)),
    })

    await act(async () => {
      await result.current.handleRedirect(`${REDIRECT_URI}?code=auth_code&state=tampered_state`)
    })

    expect(result.current.signInState.status).toBe('error')
    if (result.current.signInState.status === 'error') {
      expect(result.current.signInState.error.message).toContain('PKCE verifier missing')
    }
  })

  it('sets error state when authorization code is missing', async () => {
    const cache = makeTokenCache()
    await cache.saveToken(pendingAuthorizationKey('state_123'), 'verifier_123')

    const browser: BrowserInterface = { openAuthSession: vi.fn() }
    const { result } = renderHook(() => useSignIn(), {
      wrapper: makeWrapper(makeRnCtx(cache, browser)),
    })

    await act(async () => {
      await result.current.handleRedirect(`${REDIRECT_URI}?state=state_123`)
    })

    expect(result.current.signInState.status).toBe('error')
    if (result.current.signInState.status === 'error') {
      expect(result.current.signInState.error.message).toContain('missing authorization code')
    }
  })

  it('sets error state when OAuth error parameter is present', async () => {
    const cache = makeTokenCache()
    await cache.saveToken(pendingAuthorizationKey('state_error'), 'verifier_error')
    const browser: BrowserInterface = { openAuthSession: vi.fn() }

    const { result } = renderHook(() => useSignIn(), {
      wrapper: makeWrapper(makeRnCtx(cache, browser)),
    })

    await act(async () => {
      await result.current.handleRedirect(`${REDIRECT_URI}?error=access_denied&state=state_error`)
    })

    expect(result.current.signInState.status).toBe('error')
    if (result.current.signInState.status === 'error') {
      expect(result.current.signInState.error.message).toContain('OAuth error')
    }
  })

  it('sets error state when pkce verifier is missing from cache', async () => {
    const cache = makeTokenCache()
    // Correct state but no verifier stored.

    const browser: BrowserInterface = { openAuthSession: vi.fn() }
    const { result } = renderHook(() => useSignIn(), {
      wrapper: makeWrapper(makeRnCtx(cache, browser)),
    })

    await act(async () => {
      await result.current.handleRedirect(`${REDIRECT_URI}?code=auth_code&state=correct_state`)
    })

    expect(result.current.signInState.status).toBe('error')
    if (result.current.signInState.status === 'error') {
      expect(result.current.signInState.error.message).toContain('PKCE verifier missing')
    }
  })
})

describe('signIn flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sets cancelled state when browser session is cancelled', async () => {
    const cache = makeTokenCache()
    const browser: BrowserInterface = {
      openAuthSession: vi.fn().mockResolvedValue({ type: 'cancel' }),
    }

    const { result } = renderHook(() => useSignIn(), {
      wrapper: makeWrapper(makeRnCtx(cache, browser)),
    })

    await act(async () => {
      await result.current.signIn()
    })

    expect(result.current.signInState.status).toBe('cancelled')
  })

  it('sets error state when browser.openAuthSession throws', async () => {
    const cache = makeTokenCache()
    const browser: BrowserInterface = {
      openAuthSession: vi.fn().mockRejectedValue(new Error('No browser available')),
    }

    const { result } = renderHook(() => useSignIn(), {
      wrapper: makeWrapper(makeRnCtx(cache, browser)),
    })

    await act(async () => {
      await result.current.signIn()
    })

    expect(result.current.signInState.status).toBe('error')
    if (result.current.signInState.status === 'error') {
      expect(result.current.signInState.error.message).toContain('No browser available')
    }
  })

  it('stores pkce verifier and state before opening browser', async () => {
    const cache = makeTokenCache()
    const browser: BrowserInterface = {
      openAuthSession: vi.fn().mockResolvedValue({ type: 'cancel' }),
    }

    const { result } = renderHook(() => useSignIn(), {
      wrapper: makeWrapper(makeRnCtx(cache, browser)),
    })

    await act(async () => {
      await result.current.signIn()
    })

    expect(cache.saveToken).toHaveBeenCalledWith(
      expect.stringMatching(/^xid\.pending_authorization\./),
      expect.any(String),
    )
  })

  it('两次 pending authorization 乱序回调使用各自 verifier 且重复回调只消费一次', async () => {
    const cache = makeTokenCache()
    const browser: BrowserInterface = { openAuthSession: vi.fn() }
    const exchangedVerifiers: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body))
        exchangedVerifiers.push(body.get('code_verifier') ?? '')
        return new Response(
          JSON.stringify({ access_token: `access_${body.get('code')}`, expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    await cache.saveToken(pendingAuthorizationKey('state_first'), 'verifier_first')
    await cache.saveToken(pendingAuthorizationKey('state_second'), 'verifier_second')

    const { result } = renderHook(() => useSignIn(), {
      wrapper: makeWrapper(makeRnCtx(cache, browser)),
    })

    await act(async () => {
      await result.current.handleRedirect(`${REDIRECT_URI}?code=second&state=state_second`)
      await result.current.handleRedirect(`${REDIRECT_URI}?code=first&state=state_first`)
    })

    expect(exchangedVerifiers).toEqual(['verifier_second', 'verifier_first'])

    await act(async () => {
      await result.current.handleRedirect(`${REDIRECT_URI}?code=first-replay&state=state_first`)
    })

    expect(exchangedVerifiers).toEqual(['verifier_second', 'verifier_first'])
  })
})
