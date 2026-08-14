// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

const routerState = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as { token?: string },
}))

const authState = vi.hoisted(() => ({
  post: vi.fn(),
  refresh: vi.fn(async () => undefined),
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@tanstack/react-router', () => ({
  createLazyRoute: () => (options: unknown) => options,
  useSearch: () => routerState.search,
}))

vi.mock('../../components/layout', () => ({
  AuthLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('../../components/ui', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div role="alert">{children}</div>,
  Button: ({
    children,
    isLoading: _loading,
    fullWidth: _fullWidth,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean; fullWidth?: boolean }) => (
    <button {...props}>{children}</button>
  ),
  PageHeader: ({ title, lead }: { title: ReactNode; lead?: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {lead}
    </header>
  ),
  Spinner: () => <span>Loading</span>,
}))

vi.mock('../../lib/auth-context', () => ({
  useAuth: () => ({ api: { post: authState.post }, refresh: authState.refresh }),
}))

vi.mock('../../lib/google-analytics-funnel', () => ({
  trackEmailVerified: vi.fn(),
}))

vi.mock('../../lib/router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => routerState.navigate,
}))

import { Route } from './index'

const VerifyEmailPage = (Route as unknown as { component: () => ReactNode }).component

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

describe('VerifyEmailPage explicit confirmation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    routerState.navigate.mockReset()
    routerState.search = {}
    authState.post.mockReset()
    authState.refresh.mockClear()
    globalThis.sessionStorage.clear()
    globalThis.history.replaceState({}, '', '/verify-email#token=signed-token')
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('scrubs the fragment and waits for a user click before consuming the token', async () => {
    authState.post.mockResolvedValue({
      ok: true,
      value: { ok: true, email: 'owner@example.com', redirectUrl: '/sign-in?intent=sign-up' },
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <VerifyEmailPage />
        </QueryClientProvider>,
      )
    })

    expect(globalThis.location.hash).toBe('')
    expect(authState.post).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Confirm your email')

    const button = container.querySelector('button')
    if (!button) throw new Error('confirmation button missing')
    await act(async () => button.click())
    await flush()

    expect(authState.post).toHaveBeenCalledWith('/auth/verify-email', { token: 'signed-token' })
    expect(authState.refresh).toHaveBeenCalledOnce()

    await act(async () => vi.advanceTimersByTime(2000))
    expect(routerState.navigate).toHaveBeenCalledWith(
      '/sign-in?intent=sign-up&verified=1&login_hint=owner%40example.com',
      { replace: true },
    )

    await act(async () => root.unmount())
    queryClient.clear()
    container.remove()
  })

  it('clears a rejected credential without stacking the missing-token state', async () => {
    authState.post.mockResolvedValue({
      ok: false,
      error: { code: 'token_invalid', message: 'invalid', httpStatus: 400 },
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <VerifyEmailPage />
        </QueryClientProvider>,
      )
    })
    const button = container.querySelector('button')
    if (!button) throw new Error('confirmation button missing')
    await act(async () => button.click())
    await flush()

    expect(globalThis.sessionStorage.getItem('xid.verify-email.token')).toBeNull()
    expect(container.textContent).toContain(
      'This verification link is invalid or has already been used.',
    )
    expect(container.textContent).not.toContain('No verification token found')

    await act(async () => root.unmount())
    queryClient.clear()
    container.remove()
  })

  it('retains the credential and offers retry for a transient failure', async () => {
    authState.post.mockResolvedValue({
      ok: false,
      error: { code: 'server_error', message: 'unavailable', httpStatus: 500 },
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <VerifyEmailPage />
        </QueryClientProvider>,
      )
    })
    const confirm = container.querySelector('button')
    if (!confirm) throw new Error('confirmation button missing')
    await act(async () => confirm.click())
    await flush()
    await act(async () => vi.runOnlyPendingTimers())
    await flush()

    expect(globalThis.sessionStorage.getItem('xid.verify-email.token')).toBe('signed-token')
    expect(container.textContent).toContain('Something went wrong. Please try again.')
    expect(
      Array.from(container.querySelectorAll('button')).map((button) => button.textContent),
    ).toEqual(['Try again'])

    await act(async () => root.unmount())
    queryClient.clear()
    container.remove()
  })
})
