// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

const routerState = vi.hoisted(() => ({ navigate: vi.fn(), search: {} as { token?: string } }))
const authState = vi.hoisted(() => ({
  post: vi.fn(),
  refresh: vi.fn(async () => undefined),
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
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
    fullWidth: _fullWidth,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { fullWidth?: boolean }) => (
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

vi.mock('../../lib/router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => routerState.navigate,
}))

import { MagicLinkPage } from './index'

describe('MagicLinkPage explicit confirmation', () => {
  beforeEach(() => {
    routerState.navigate.mockReset()
    routerState.search = {}
    authState.post.mockReset()
    authState.refresh.mockClear()
    globalThis.sessionStorage.clear()
    globalThis.history.replaceState({}, '', '/magic-link#token=signed-magic-link')
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  it('does not verify on mount and consumes only after confirmation', async () => {
    authState.post.mockResolvedValue({ ok: true, value: { redirectUrl: '/console' } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MagicLinkPage />
        </QueryClientProvider>,
      )
    })

    expect(globalThis.location.hash).toBe('')
    expect(authState.post).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Confirm sign in')

    const button = container.querySelector('button')
    if (!button) throw new Error('confirmation button missing')
    await act(async () => button.click())

    expect(authState.post).toHaveBeenCalledWith('/auth/magic-link/verify', {
      token: 'signed-magic-link',
    })
    expect(authState.refresh).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    queryClient.clear()
    container.remove()
  })

  it('renders a branded recovery state without exposing JSON when the token is missing', async () => {
    globalThis.history.replaceState({}, '', '/magic-link')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MagicLinkPage />
        </QueryClientProvider>,
      )
    })

    expect(authState.post).not.toHaveBeenCalled()
    expect(container.textContent).toContain('No magic-link token found')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/sign-in')
    expect(container.textContent).not.toContain('{"code"')

    await act(async () => root.unmount())
    queryClient.clear()
    container.remove()
  })
})
