// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const postResponses = vi.hoisted(() => new Map<string, unknown>())

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

vi.mock('@lingui/react/macro', () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join('') }),
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
        if (postResponses.has(path)) return { ok: true, value: postResponses.get(path) as T }
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
      conditionalAvailable: false,
      conditionalRunning: false,
      isVerifying: false,
      error: null,
      triggerButton: vi.fn(),
      triggerEarlierButton: vi.fn(),
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

  it('keeps enterprise SSO discovery out of an invitation flow', async () => {
    const { captured, cleanup } = await renderSignIn({
      continue: '/accept-invitation?token=tenant-bound-token',
      login_hint: 'dana@corp.example.com',
    })
    try {
      expect(captured.value?.[0].enabledMethods).not.toContain('enterprise-sso')

      await act(async () => {
        captured.value?.[1].submitIdentifier()
      })
      await act(async () => {
        await vi.waitFor(() => expect(captured.value?.[0].step).toBe('methods'))
      })

      expect(postCalls.map((call) => call.path)).not.toContain('/sso/hrd')
    } finally {
      await cleanup()
    }
  })

  it('discovers the enterprise connection for an email and shows the redirect transition', async () => {
    postResponses.set('/sso/hrd', {
      connectionId: 'conn_1',
      protocol: 'oidc',
      organizationId: 'tenant-1',
      displayName: 'Okta',
      organizationName: 'Northwind',
    })
    const { captured, cleanup } = await renderSignIn({ login_hint: 'dana@northwind.com' })
    try {
      expect(captured.value?.[0].enabledMethods).toContain('enterprise-sso')

      await act(async () => {
        captured.value?.[1].submitIdentifier()
      })
      await act(async () => {
        await vi.waitFor(() => expect(captured.value?.[0].step).toBe('sso'))
      })

      expect(postCalls.find((call) => call.path === '/sso/hrd')?.body).toMatchObject({
        email: 'dana@northwind.com',
      })
      expect(captured.value?.[0].ssoTarget).toMatchObject({
        connectionName: 'Okta',
        organizationName: 'Northwind',
        domain: 'northwind.com',
      })
      expect(captured.value?.[0].ssoTarget?.url).toContain('/sso/oidc/conn_1/authorize')
    } finally {
      postResponses.clear()
      await cleanup()
    }
  })

  it('asks for an identifier before leaving the first step', async () => {
    const { captured, cleanup } = await renderSignIn({})
    try {
      await act(async () => {
        captured.value?.[1].submitIdentifier()
      })

      expect(captured.value?.[0].error).toBe('identifier_required')
      expect(captured.value?.[0].step).toBe('identifier')
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
        captured?.[1].chooseMethod('otp-email')
      })
      await act(async () => {
        captured?.[1].requestOtp()
        captured?.[1].verifyOtp('123456')
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
        captured?.[1].requestOtp()
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

// Node 开启 webstorage 时会用自己的 localStorage 覆盖 jsdom 的实现,这里固定成内存存储。
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  }
}

describe('useSignIn second step', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function renderSecondStep(input: {
    search: Record<string, string | undefined>
    config: PublicHostedAuthConfig
  }) {
    authConfigState.config = input.config
    postCalls.length = 0
    routerState.search = input.search
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
      await vi.waitFor(() => expect(captured.value?.[0].configSettled).toBe(true))
    })
    const cleanup = async (): Promise<void> => {
      await act(async () => root.unmount())
      container.remove()
      routerState.search = {}
      authConfigState.config = null
    }
    return { captured, cleanup }
  }

  const otpAndPassword: PublicHostedAuthConfig = {
    ...DEFAULT_PUBLIC_AUTH_CONFIG,
    methods: {
      ...DEFAULT_PUBLIC_AUTH_CONFIG.methods,
      password: { enabled: true, allowLogin: true, allowUserCreation: false },
    },
  }

  it('defaults to an emailed code and sends it as soon as the second step opens', async () => {
    postResponses.set('/auth/otp/email/send', { ok: true })
    const { captured, cleanup } = await renderSecondStep({
      search: { login_hint: 'dana@northwind.com' },
      config: otpAndPassword,
    })
    try {
      await act(async () => {
        captured.value?.[1].submitIdentifier()
      })
      await act(async () => {
        await vi.waitFor(() => expect(captured.value?.[0].otpSentAt).not.toBeNull())
      })

      expect(captured.value?.[0].method).toBe('otp-email')
      expect(captured.value?.[0].methods).toEqual(['otp-email', 'magic-link', 'password'])
      expect(postCalls.at(-1)).toMatchObject({
        path: '/auth/otp/email/send',
        body: { email: 'dana@northwind.com' },
      })
    } finally {
      postResponses.clear()
      await cleanup()
    }
  })

  it('waits for the Turnstile token without showing a send in progress, then reports the code as sent', async () => {
    postResponses.set('/auth/otp/email/send', { ok: true })
    const { captured, cleanup } = await renderSecondStep({
      search: { login_hint: 'dana@northwind.com' },
      config: { ...otpAndPassword, turnstileSiteKey: 'site-key' },
    })
    try {
      await act(async () => {
        captured.value?.[1].submitIdentifier()
      })
      await act(async () => {
        await vi.waitFor(() => expect(captured.value?.[0].step).toBe('methods'))
      })

      expect(captured.value?.[0].isSendingOtp).toBe(false)
      expect(captured.value?.[0].isLoading).toBe(false)
      expect(captured.value?.[0].otpSendStatus).toBe('sending')
      expect(postCalls.map((call) => call.path)).not.toContain('/auth/otp/email/send')

      await act(async () => {
        captured.value?.[1].setTurnstileToken('turnstile-token-1')
      })
      await act(async () => {
        await vi.waitFor(() => expect(captured.value?.[0].otpSendStatus).toBe('sent'))
      })

      expect(postCalls.at(-1)).toMatchObject({
        path: '/auth/otp/email/send',
        body: { turnstileToken: 'turnstile-token-1' },
      })
      expect(captured.value?.[0].turnstileReady).toBe(false)
      expect(captured.value?.[0].isSendingOtp).toBe(false)
    } finally {
      postResponses.clear()
      await cleanup()
    }
  })

  it('opens the method this browser used last without sending a code', async () => {
    globalThis.localStorage.setItem('xid.lastAuthMethod', 'password')
    const { captured, cleanup } = await renderSecondStep({
      search: { login_hint: 'dana@northwind.com' },
      config: otpAndPassword,
    })
    try {
      await act(async () => {
        captured.value?.[1].submitIdentifier()
      })
      await act(async () => {
        await vi.waitFor(() => expect(captured.value?.[0].step).toBe('methods'))
      })

      expect(captured.value?.[0].method).toBe('password')
      expect(postCalls.map((call) => call.path)).not.toContain('/auth/otp/email/send')
    } finally {
      await cleanup()
    }
  })

  it('marks a resent code so the page can say the previous one stopped working', async () => {
    postResponses.set('/auth/otp/email/send', { ok: true })
    const { captured, cleanup } = await renderSecondStep({
      search: { login_hint: 'dana@northwind.com' },
      config: otpAndPassword,
    })
    try {
      await act(async () => {
        captured.value?.[1].submitIdentifier()
      })
      await act(async () => {
        await vi.waitFor(() => expect(captured.value?.[0].otpSentAt).not.toBeNull())
      })
      expect(captured.value?.[0].otpResent).toBe(false)

      await act(async () => {
        captured.value?.[1].requestOtp()
      })
      await act(async () => {
        await vi.waitFor(() => expect(captured.value?.[0].otpResent).toBe(true))
      })
    } finally {
      postResponses.clear()
      await cleanup()
    }
  })

  it('returns to the first step and forgets the sent code when the identifier changes', async () => {
    postResponses.set('/auth/otp/email/send', { ok: true })
    const { captured, cleanup } = await renderSecondStep({
      search: { login_hint: 'dana@northwind.com' },
      config: otpAndPassword,
    })
    try {
      await act(async () => {
        captured.value?.[1].submitIdentifier()
      })
      await act(async () => {
        await vi.waitFor(() => expect(captured.value?.[0].otpSentAt).not.toBeNull())
      })
      await act(async () => {
        captured.value?.[1].changeIdentifier()
      })

      expect(captured.value?.[0].step).toBe('identifier')
      expect(captured.value?.[0].otpSentAt).toBeNull()
      expect(routerState.navigate).toHaveBeenCalledWith('/sign-in', { replace: true })
    } finally {
      postResponses.clear()
      await cleanup()
    }
  })

  it('shows the organization picker when the root entry finds several organizations', async () => {
    const { captured, cleanup } = await renderSecondStep({
      search: { login_hint: 'dana@northwind.com' },
      config: {
        ...DEFAULT_PUBLIC_AUTH_CONFIG,
        resolution: {
          status: 'ambiguous',
          matchedBy: 'email',
          matches: [
            { organizationId: 'o1', slug: 'ops', name: 'Operations', issuer: 'https://xid.dev' },
            { organizationId: 'o2', slug: 'fin', name: 'Finance', issuer: 'https://xid.dev' },
          ],
        },
      },
    })
    try {
      expect(captured.value?.[0].step).toBe('organization')
    } finally {
      await cleanup()
    }
  })
})
