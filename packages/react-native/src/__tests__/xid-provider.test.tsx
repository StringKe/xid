import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { BrowserInterface } from '../browser-interface'
import type { TokenCache } from '../token-cache'
import { saveTokenSet } from '../token-exchange'
import { XidProvider } from '../xid-provider'
import { useXidRnContext } from '../xid-rn-context'

vi.mock('@xid-kit/react', () => ({
  XidProvider: ({ children }: { children: ReactNode }) => children,
}))

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
      publishableKey="pk_test"
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
      refreshToken: 'rt.persisted',
      idToken: null,
      expiresIn: 3600,
    })

    const first = renderHook(() => useXidRnContext(), { wrapper: makeWrapper(cache) })
    await waitFor(() => expect(first.result.current.isLoaded).toBe(true))
    expect(first.result.current.session?.accessToken).toBe('at.persisted')
    first.unmount()

    const second = renderHook(() => useXidRnContext(), { wrapper: makeWrapper(cache) })
    await waitFor(() => expect(second.result.current.isLoaded).toBe(true))
    expect(second.result.current.session?.accessToken).toBe('at.persisted')
  })
})
