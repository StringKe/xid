import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'

import type { BrowserInterface } from '../browser-interface'
import type { TokenCache } from '../token-cache'
import { saveTokenSet } from '../token-exchange'
import { useAuth, useSession, useUser } from '../native-auth'
import { XidProvider } from '../xid-provider'
import { useXidRnContext } from '../xid-rn-context'

function makeCache(): TokenCache & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    getToken: async (key) => store.get(key) ?? null,
    saveToken: async (key, value) => {
      store.set(key, value)
    },
    deleteToken: async (key) => {
      store.delete(key)
    },
  }
}

function makeWrapper(cache: TokenCache): ({ children }: { children: ReactNode }) => ReactNode {
  const browser: BrowserInterface = { openAuthSession: async () => ({ type: 'cancel' }) }
  return ({ children }) => (
    <XidProvider
      tokenCache={cache}
      browser={browser}
      issuer="https://xid.dev"
      clientId="client_test"
      redirectUri="myapp://auth/callback"
    >
      {children}
    </XidProvider>
  )
}

describe('XidProvider cold start recovery', () => {
  it('restores persisted session after provider remount', async () => {
    const cache = makeCache()
    await saveTokenSet(cache, {
      accessToken: 'at.persisted',
      idToken: 'id.persisted',
      expiresIn: 3600,
      claims: {
        iss: 'https://xid.dev',
        sub: 'user_persisted',
        aud: 'client_test',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        sid: 'session_persisted',
        email: 'persisted@example.com',
      },
    })

    const first = renderHook(
      () => ({
        context: useXidRnContext(),
        auth: useAuth(),
        user: useUser(),
      }),
      { wrapper: makeWrapper(cache) },
    )
    await waitFor(() => expect(first.result.current.context.isLoaded).toBe(true))
    expect(first.result.current.context.session?.accessToken).toBe('at.persisted')
    expect(first.result.current.auth).toMatchObject({
      isSignedIn: true,
      userId: 'user_persisted',
      sessionId: 'session_persisted',
    })
    expect(first.result.current.user).toMatchObject({
      isSignedIn: true,
      user: { id: 'user_persisted', email: 'persisted@example.com' },
    })
    first.unmount()

    const second = renderHook(() => ({ context: useXidRnContext(), auth: useAuth() }), {
      wrapper: makeWrapper(cache),
    })
    await waitFor(() => expect(second.result.current.context.isLoaded).toBe(true))
    expect(second.result.current.context.session?.accessToken).toBe('at.persisted')
    expect(second.result.current.auth.isSignedIn).toBe(true)
  })

  it('does not expose an unverified token envelope as a signed-in session', async () => {
    const cache = makeCache()
    await saveTokenSet(cache, {
      accessToken: 'at.unverified',
      idToken: null,
      expiresIn: 3600,
    })

    const rendered = renderHook(
      () => ({
        auth: useAuth(),
        user: useUser(),
        session: useSession(),
      }),
      { wrapper: makeWrapper(cache) },
    )
    await waitFor(() => expect(rendered.result.current.auth.isLoaded).toBe(true))

    expect(rendered.result.current.auth.isSignedIn).toBe(false)
    expect(rendered.result.current.auth.session).toBeNull()
    await expect(rendered.result.current.auth.getToken()).resolves.toBeNull()
    expect(rendered.result.current.user.isSignedIn).toBe(false)
    expect(rendered.result.current.session.isSignedIn).toBe(false)
  })
})
