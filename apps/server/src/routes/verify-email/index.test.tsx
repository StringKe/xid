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
    data: { ok: true, redirectUrl: '/sign-in?intent=sign-up' },
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

  it('separates the sign-in path and intent search while replacing history', async () => {
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

    expect(routerState.navigate).toHaveBeenCalledWith({
      to: '/sign-in',
      search: { intent: 'sign-up' },
      replace: true,
    })

    await act(async () => root.unmount())
    container.remove()
  })
})
