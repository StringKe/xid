// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const routerState = vi.hoisted(() => ({
  navigate: vi.fn(),
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@tanstack/react-router', () => ({
  createLazyRoute: () => (options: unknown) => options,
  useNavigate: () => routerState.navigate,
  useSearch: () => ({ token: 'signed-token' }),
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: { ok: true, email: 'owner@example.com', redirectUrl: '/sign-in?intent=sign-up' },
    error: null,
    isPending: false,
    isSuccess: true,
  }),
  useMutation: vi.fn(),
}))

vi.mock('../../components/layout', () => ({
  AuthLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('../../components/ui', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  PageHeader: ({ title }: { title: ReactNode }) => <h1>{title}</h1>,
  Spinner: () => <span>Loading</span>,
}))

vi.mock('../../lib/auth-context', () => ({
  useAuth: () => ({
    api: { post: vi.fn() },
    refresh: vi.fn(),
  }),
}))

vi.mock('../../lib/google-analytics-funnel', () => ({
  trackEmailVerified: vi.fn(),
}))

vi.mock('../../lib/router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => routerState.navigate,
}))

import { Route } from './index'

const VerifyEmailPage = (
  Route as unknown as {
    component: () => ReactNode
  }
).component

describe('VerifyEmailPage sign-up redirect', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('appends verified + login_hint to the sign-in target while replacing history', async () => {
    vi.useFakeTimers()
    routerState.navigate.mockClear()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<VerifyEmailPage />)
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(routerState.navigate).toHaveBeenCalledWith(
      '/sign-in?intent=sign-up&verified=1&login_hint=owner%40example.com',
      { replace: true },
    )

    await act(async () => root.unmount())
    container.remove()
  })
})
