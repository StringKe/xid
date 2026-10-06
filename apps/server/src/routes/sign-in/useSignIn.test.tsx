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
    flowFields?: Record<string, string>
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
const postErrorState = vi.hoisted(() => ({ code: 'unauthorized' as string }))

function failure<T>(): Result<T> {
  return {
    ok: false,
    error: { code: 'unauthorized', message: 'Authentication is required.', httpStatus: 401 },
  }
}

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => routerState.search,
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
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
        if (postErrorState.code === 'unauthorized') return failure<T>()
        return {
          ok: false,
          error: { code: postErrorState.code, message: '', httpStatus: 409 },
        } as Result<T>
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
    flowFields: Record<string, string>
  }) => {
    passkeyCalls.push({
      enabled: options.enabled,
      organizationId: options.organizationId,
      turnstileToken: options.turnstileToken,
      flowFields: options.flowFields,
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

    expect(passkeyCalls).toEqual([
      expect.objectContaining({ enabled: false, organizationId: null, turnstileToken: null }),
    ])
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
      expect.objectContaining({
        enabled: false,
        organizationId: 'org_selected',
        turnstileToken: null,
      }),
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

describe('useSignIn federated entry', () => {
  async function renderSignIn(search: Record<string, string | undefined>) {
    authConfigState.config = {
      ...DEFAULT_PUBLIC_AUTH_CONFIG,
      methods: {
        ...DEFAULT_PUBLIC_AUTH_CONFIG.methods,
        enterpriseSso: {
          ...DEFAULT_PUBLIC_AUTH_CONFIG.methods.enterpriseSso,
          enabled: true,
          allowLogin: true,
          domainDiscovery: true,
        },
      },
    }
    postCalls.length = 0
    routerState.search = search
    ;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
    const queryClient = new QueryClient()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const captured: { value: ReturnType<typeof useSignIn> | null } = { value: null }
    function Host(): ReactNode {
      captured.value = useSignIn()
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
      await vi.waitFor(() => expect(captured.value?.[0].authConfig).toBe(authConfigState.config))
    })
    const cleanup = async (): Promise<void> => {
      await act(async () => root.unmount())
      container.remove()
      routerState.search = {}
      authConfigState.config = null
    }
    return { captured, cleanup }
  }

  it('keeps enterprise SSO and social entries out of an invitation flow', async () => {
    const { captured, cleanup } = await renderSignIn({
      continue: '/accept-invitation?token=tenant-bound-token',
    })
    try {
      expect(captured.value?.[0].enabledMethods).not.toContain('enterprise-sso')

      await act(async () => {
        captured.value?.[1].submitEnterpriseSso()
      })

      expect(postCalls.map((call) => call.path)).not.toContain('/sso/hrd')
    } finally {
      await cleanup()
    }
  })

  it('offers enterprise SSO outside an invitation flow', async () => {
    const { captured, cleanup } = await renderSignIn({})
    try {
      expect(captured.value?.[0].enabledMethods).toContain('enterprise-sso')
    } finally {
      await cleanup()
    }
  })

  it('shows only allowlisted federated callback errors from the URL', async () => {
    const accepted = await renderSignIn({ error: 'cancelled' })
    try {
      expect(accepted.captured.value?.[0].error).toBe('cancelled')
    } finally {
      await accepted.cleanup()
    }
    const ignored = await renderSignIn({ error: 'invalid_credentials' })
    try {
      expect(ignored.captured.value?.[0].error).toBeNull()
    } finally {
      await ignored.cleanup()
    }
  })
})

describe('useSignIn application continuation', () => {
  it('sends the /authorize continuation with every credential method', async () => {
    authConfigState.config = null
    postCalls.length = 0
    passkeyCalls.length = 0
    routerState.search = {
      authz_request_id: 'authz-1',
      client_id: 'app-1',
      organization_id: 'tenant-1',
      intent: 'sign-in',
    }
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
    const expectedFlow = {
      continue: '/authorize?authz_request_id=authz-1&client_id=app-1',
      clientId: 'app-1',
      intent: 'sign-in',
    }

    try {
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

      await act(async () => {
        captured?.[1].submitPassword()
        captured?.[1].submitMagicLink()
      })
      await act(async () => {
        captured?.[1].setMethod('otp-email')
      })
      await act(async () => {
        captured?.[1].submitOtpRequest()
        captured?.[1].submitOtpVerify()
      })

      expect(postCalls.map((call) => call.path)).toEqual([
        '/auth/password/sign-in',
        '/auth/magic-link/send',
        '/auth/otp/email/send',
        '/auth/otp/email/verify',
      ])
      for (const call of postCalls) expect(call.body).toMatchObject(expectedFlow)
      expect(passkeyCalls.at(-1)?.flowFields).toEqual(expectedFlow)
    } finally {
      await act(async () => root.unmount())
      container.remove()
      routerState.search = {}
    }
  })
})

describe('useSignIn multi-organization identifier', () => {
  it('re-resolves the typed identifier through login_hint instead of showing a credential error', async () => {
    authConfigState.config = null
    postCalls.length = 0
    postErrorState.code = 'organization_selection_required'
    routerState.navigate.mockClear()
    routerState.search = { continue: '/account', organization_id: 'stale-org' }
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
        await vi.waitFor(() => expect(captured?.[0].turnstileReady).toBe(true))
      })
      await act(async () => {
        captured?.[1].setIdentifier(' multi@example.com ')
      })
      await act(async () => {
        captured?.[1].submitPassword()
      })

      expect(routerState.navigate).toHaveBeenCalledWith(
        '/sign-in?continue=%2Faccount&login_hint=multi%40example.com',
        { replace: true },
      )
      expect(captured?.[0].error).toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
      postErrorState.code = 'unauthorized'
      routerState.search = {}
    }
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
      // passkey 入口不随 Turnstile 状态拆除,hook 内部只拦截提交。
      expect(passkeyCalls.at(-1)).toMatchObject({ enabled: true, turnstileToken: null })

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
      expect(passkeyCalls.at(-1)).toMatchObject({
        enabled: true,
        turnstileToken: 'turnstile-token-1',
      })

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
