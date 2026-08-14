// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { Result } from '@xid-kit/types'
import type { ApiClient } from '../../lib/api'
import type { PublicHostedAuthConfig } from './auth-config'

const passkeyCalls = vi.hoisted(
  (): Array<{
    enabled: boolean
    organizationId?: string | null
    turnstileToken: string | null
  }> => [],
)
const postCalls = vi.hoisted((): Array<{ path: string; body: unknown }> => [])
const authConfigState = vi.hoisted(() => ({
  config: null as PublicHostedAuthConfig | null,
}))
const routerState = vi.hoisted(() => ({
  search: {} as Record<string, string | undefined>,
  navigate: vi.fn(),
}))

function failure<T>(): Result<T> {
  return {
    ok: false,
    error: { code: 'unauthorized', message: 'Authentication is required.', httpStatus: 401 },
  }
}

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => routerState.search,
}))

vi.mock('../../lib/router', () => ({
  useNavigate: () => routerState.navigate,
}))

vi.mock('../../lib/auth-context', () => ({
  useAuth: () => ({
    api: {
      get: async <T,>() =>
        authConfigState.config
          ? ({ ok: true, value: authConfigState.config as T } satisfies Result<T>)
          : failure<T>(),
      post: async <T,>(path: string, body?: unknown) => {
        postCalls.push({ path, body })
        return failure<T>()
      },
      patch: async <T,>() => failure<T>(),
      del: async <T,>() => failure<T>(),
      request: async <T,>() => failure<T>(),
    } satisfies ApiClient,
    refresh: vi.fn(),
  }),
}))

vi.mock('./usePasskeySignIn', () => ({
  usePasskeySignIn: (options: {
    enabled: boolean
    organizationId?: string | null
    turnstileToken: string | null
  }) => {
    passkeyCalls.push({
      enabled: options.enabled,
      organizationId: options.organizationId,
      turnstileToken: options.turnstileToken,
    })
    return {
      support: 'no',
      conditionalRunning: false,
      isVerifying: false,
      error: null,
      triggerButton: vi.fn(),
    }
  },
}))

import {
  buildAuthConfigPath,
  buildSocialAuthorizeUrl,
  enabledSignInMethodsForIntent,
  useSignIn,
} from './useSignIn'
import { DEFAULT_PUBLIC_AUTH_CONFIG } from './auth-config'

function Capture(): ReactNode {
  useSignIn()
  return null
}

describe('social OAuth authorize URL', () => {
  it('routes sign-up through organization creation and preserves the intent', () => {
    const url = buildSocialAuthorizeUrl({
      origin: 'https://xid.dev',
      provider: 'github',
      hostedReturn: '/console',
      intent: 'sign-up',
      identifier: 'owner@example.com',
      organizationId: undefined,
      invitationToken: null,
      turnstileToken: null,
    })

    expect(url.pathname).toBe('/auth/github/authorize')
    expect(url.searchParams.get('continue')).toBe('/create-organization')
    expect(url.searchParams.get('intent')).toBe('sign-up')
  })

  it('keeps the hosted return and omits the intent for normal sign-in', () => {
    const url = buildSocialAuthorizeUrl({
      origin: 'https://xid.dev',
      provider: 'github',
      hostedReturn: '/account',
      intent: null,
      identifier: '',
      organizationId: undefined,
      invitationToken: null,
      turnstileToken: null,
    })

    expect(url.searchParams.get('continue')).toBe('/account')
    expect(url.searchParams.has('intent')).toBe(false)
  })

  it('preserves the invitation capability through social sign-in', () => {
    const url = buildSocialAuthorizeUrl({
      origin: 'https://xid.dev',
      provider: 'github',
      hostedReturn: '/accept-invitation?token=tenant-bound-token',
      intent: null,
      identifier: 'invitee@example.com',
      organizationId: undefined,
      invitationToken: 'tenant-bound-token',
      turnstileToken: null,
    })

    expect(url.searchParams.get('continue')).toBe('/accept-invitation?token=tenant-bound-token')
    expect(url.searchParams.get('invitation_token')).toBe('tenant-bound-token')
  })

  it('passes the single-use Turnstile token to social authorization', () => {
    const url = buildSocialAuthorizeUrl({
      origin: 'https://xid.dev',
      provider: 'github',
      hostedReturn: '/console',
      intent: null,
      identifier: '',
      organizationId: undefined,
      invitationToken: null,
      turnstileToken: 'turnstile-token-1',
    })

    expect(url.searchParams.get('turnstile')).toBe('turnstile-token-1')
  })
})

describe('Hosted Auth config URL', () => {
  it('preserves root sign-up and invitation flow context for Tenant resolution', () => {
    expect(
      buildAuthConfigPath({
        loginHint: 'invitee@example.com',
        organizationId: null,
        intent: 'sign-up',
        invitationToken: 'tenant-bound-token',
      }),
    ).toBe(
      '/auth/config?login_hint=invitee%40example.com&intent=sign-up&invitation_token=tenant-bound-token',
    )
  })

  it('preserves OAuth authorization context so guest capability stays unavailable', () => {
    expect(
      buildAuthConfigPath({
        loginHint: null,
        organizationId: null,
        intent: null,
        invitationToken: null,
        authzRequestId: 'authz-1',
      }),
    ).toBe('/auth/config?authz_request_id=authz-1')
  })
})

describe('useSignIn passkey policy gate', () => {
  it('removes sign-in-only passkey from sign-up flows', () => {
    const config = {
      ...DEFAULT_PUBLIC_AUTH_CONFIG,
      methods: {
        ...DEFAULT_PUBLIC_AUTH_CONFIG.methods,
        password: { enabled: true, allowLogin: true, allowUserCreation: true },
        passkey: { enabled: true, allowLogin: true, allowUserCreation: true },
      },
    }

    expect(enabledSignInMethodsForIntent(config, 'sign-up')).toEqual([
      'password',
      'magic-link',
      'otp-email',
    ])
    expect(enabledSignInMethodsForIntent(config, null)).toContain('passkey')
  })

  it('does not enable passkey conditional UI when default Hosted Auth disables passkey', () => {
    passkeyCalls.length = 0
    routerState.search = {}
    const queryClient = new QueryClient()

    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <Capture />
      </QueryClientProvider>,
    )

    expect(passkeyCalls).toEqual([{ enabled: false, organizationId: null, turnstileToken: null }])
  })

  it('passes selected organization hint into passkey sign-in', () => {
    passkeyCalls.length = 0
    routerState.search = { organization_id: 'org_selected' }
    const queryClient = new QueryClient()

    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <Capture />
      </QueryClientProvider>,
    )

    expect(passkeyCalls).toEqual([
      { enabled: false, organizationId: 'org_selected', turnstileToken: null },
    ])
  })
})

describe('useSignIn rememberMe', () => {
  it('密码提交 body 带 rememberMe:默认 false,勾选后 true', async () => {
    authConfigState.config = null
    postCalls.length = 0
    routerState.search = {}
    ;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
    const queryClient = new QueryClient()
    const container = document.createElement('div')
    document.body.appendChild(container)
    let captured: ReturnType<typeof useSignIn> | null = null
    function Host(): ReactNode {
      captured = useSignIn()
      return null
    }
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Host />
        </QueryClientProvider>,
      )
    })
    await act(async () => {
      await vi.waitFor(() => expect(captured?.[0].turnstileReady).toBe(true))
    })

    expect(captured?.[0].rememberMe).toBe(false)

    await act(async () => {
      captured?.[1].submitPassword()
    })
    let lastCall = postCalls[postCalls.length - 1]
    expect(lastCall?.path).toBe('/auth/password/sign-in')
    expect(lastCall?.body).toMatchObject({ rememberMe: false })

    await act(async () => {
      captured?.[1].setRememberMe(true)
    })
    expect(captured?.[0].rememberMe).toBe(true)

    await act(async () => {
      captured?.[1].submitPassword()
    })
    lastCall = postCalls[postCalls.length - 1]
    expect(lastCall?.path).toBe('/auth/password/sign-in')
    expect(lastCall?.body).toMatchObject({ rememberMe: true })

    await act(async () => {
      root.unmount()
    })
  })
})

describe('useSignIn Turnstile action gate', () => {
  it('blocks protected actions until the configured widget produces a token', async () => {
    authConfigState.config = {
      ...DEFAULT_PUBLIC_AUTH_CONFIG,
      turnstileSiteKey: 'site-key',
      methods: {
        ...DEFAULT_PUBLIC_AUTH_CONFIG.methods,
        passkey: { enabled: true, allowLogin: true, allowUserCreation: false },
      },
    }
    postCalls.length = 0
    passkeyCalls.length = 0
    routerState.search = {}
    ;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
    const queryClient = new QueryClient()
    const container = document.createElement('div')
    document.body.appendChild(container)
    let captured: ReturnType<typeof useSignIn> | null = null
    function Host(): ReactNode {
      captured = useSignIn()
      return null
    }
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Host />
          </QueryClientProvider>,
        )
      })
      await act(async () => {
        await vi.waitFor(() => expect(captured?.[0].authConfig.turnstileSiteKey).toBe('site-key'))
      })

      expect(captured?.[0].turnstileReady).toBe(false)
      expect(passkeyCalls.at(-1)?.enabled).toBe(false)

      await act(async () => {
        captured?.[1].submitMagicLink()
        captured?.[1].submitPassword()
        captured?.[1].submitOtpRequest()
        captured?.[1].submitEnterpriseSso()
        captured?.[1].triggerPasskeyButton()
      })
      expect(postCalls).toEqual([])

      await act(async () => {
        captured?.[1].setTurnstileToken('turnstile-token-1')
      })
      expect(captured?.[0].turnstileReady).toBe(true)
      expect(passkeyCalls.at(-1)?.enabled).toBe(true)

      await act(async () => {
        captured?.[1].submitMagicLink()
      })
      expect(postCalls.at(-1)).toMatchObject({
        path: '/auth/magic-link/send',
        body: { turnstileToken: 'turnstile-token-1' },
      })
    } finally {
      await act(async () => root.unmount())
      container.remove()
      authConfigState.config = null
    }
  })
})
