// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { Result } from '@xid-kit/types'
import type { ApiClient } from '../../lib/api'

const passkeyCalls = vi.hoisted(
  (): Array<{ enabled: boolean; organizationId?: string | null }> => [],
)
const postCalls = vi.hoisted((): Array<{ path: string; body: unknown }> => [])
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
      get: async <T,>() => failure<T>(),
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
  usePasskeySignIn: (options: { enabled: boolean; organizationId?: string | null }) => {
    passkeyCalls.push({ enabled: options.enabled, organizationId: options.organizationId })
    return {
      support: 'no',
      conditionalRunning: false,
      isVerifying: false,
      error: null,
      triggerButton: vi.fn(),
    }
  },
}))

import { buildSocialAuthorizeUrl, useSignIn } from './useSignIn'

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
      signUpIntent: true,
      identifier: 'owner@example.com',
      organizationId: undefined,
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
      signUpIntent: false,
      identifier: '',
      organizationId: undefined,
      turnstileToken: null,
    })

    expect(url.searchParams.get('continue')).toBe('/account')
    expect(url.searchParams.has('intent')).toBe(false)
  })
})

describe('useSignIn passkey policy gate', () => {
  it('does not enable passkey conditional UI when default Hosted Auth disables passkey', () => {
    passkeyCalls.length = 0
    routerState.search = {}
    const queryClient = new QueryClient()

    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <Capture />
      </QueryClientProvider>,
    )

    expect(passkeyCalls).toEqual([{ enabled: false, organizationId: null }])
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

    expect(passkeyCalls).toEqual([{ enabled: false, organizationId: 'org_selected' }])
  })
})

describe('useSignIn rememberMe', () => {
  it('密码提交 body 带 rememberMe:默认 false,勾选后 true', async () => {
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
