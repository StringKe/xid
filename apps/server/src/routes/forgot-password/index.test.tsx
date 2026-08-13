// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InputHTMLAttributes, ReactNode } from 'react'

const routerState = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, string>,
  pathname: '/forgot-password',
}))

const mutationState = vi.hoisted(() => ({
  captured: [] as {
    onSuccess?: (result: unknown, variables?: unknown, context?: unknown) => unknown
  }[],
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@tanstack/react-router', () => ({
  createLazyRoute: () => (options: unknown) => options,
  useSearch: () => routerState.search,
}))

vi.mock('../../lib/router', () => ({
  Link: ({ to, children }: { to: unknown; children: ReactNode }) => (
    <a href={typeof to === 'string' ? to : ''}>{children}</a>
  ),
  useNavigate: () => routerState.navigate,
  useLocation: () => ({ pathname: routerState.pathname }),
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isPending: false, error: null }),
  useMutation: (options: (typeof mutationState.captured)[number]) => {
    mutationState.captured.push(options)
    return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isSuccess: false }
  },
}))

vi.mock('../../components/layout', () => ({
  AuthLayout: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) => (
    <>
      {children}
      {footer}
    </>
  ),
}))

vi.mock('../../components/ui', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  PageHeader: ({ title }: { title: ReactNode }) => <h1>{title}</h1>,
  Spinner: () => <span>Loading</span>,
}))

vi.mock('../../lib/auth-context', () => ({
  useAuth: () => ({
    api: { post: vi.fn(), get: vi.fn() },
    refresh: vi.fn(async () => {}),
  }),
}))

vi.mock('../sign-up/PasswordStrength', () => ({
  PasswordStrength: () => null,
}))

vi.mock('../../lib/google-analytics-funnel', () => ({
  trackPasswordResetRequest: vi.fn(),
}))

vi.mock('./reset-success', () => ({
  handleResetPasswordSuccess: vi.fn(),
}))

vi.mock('../sign-in/auth-config', () => ({
  DEFAULT_PUBLIC_AUTH_CONFIG: { turnstileSiteKey: null },
}))

vi.mock('../sign-in/useTurnstile', () => ({
  useTurnstile: () => ({ containerRef: { current: null } }),
}))

import { Route } from './index'

const ForgotPasswordPage = (
  Route as unknown as {
    component: () => ReactNode
  }
).component

async function renderPage(): Promise<{
  container: HTMLDivElement
  root: ReturnType<typeof createRoot>
  html: string
  text: string
}> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<ForgotPasswordPage />)
  })
  return { container, root, html: container.innerHTML, text: container.textContent ?? '' }
}

async function unmount(
  container: HTMLDivElement,
  root: ReturnType<typeof createRoot>,
): Promise<void> {
  await act(async () => root.unmount())
  container.remove()
}

describe('ForgotPasswordPage navigation links', () => {
  beforeEach(() => {
    routerState.navigate.mockClear()
    mutationState.captured.length = 0
    routerState.search = {}
    routerState.pathname = '/forgot-password'
    globalThis.sessionStorage.clear()
    globalThis.history.replaceState({}, '', '/forgot-password')
  })

  it('shows Back to sign in on the request step', async () => {
    const { container, root, html, text } = await renderPage()

    expect(text).toContain('Reset your password')
    expect(text).toContain('Back to sign in')
    expect(html).toContain('href="/sign-in"')
    await unmount(container, root)
  })

  it('keeps organization and locale context when returning to sign in', async () => {
    routerState.search = { organization_id: 'org-1', locale: 'en' }
    globalThis.history.replaceState({}, '', '/forgot-password?organization_id=org-1&locale=en')

    const { container, root, html } = await renderPage()

    expect(html).toContain('href="/sign-in?organization_id=org-1&amp;locale=en"')
    await unmount(container, root)
  })

  it('shows Back to sign in on the reset step', async () => {
    routerState.search = { token: 'reset-token' }
    routerState.pathname = '/reset-password'
    globalThis.history.replaceState({}, '', '/reset-password?token=reset-token')
    const { container, root, html, text } = await renderPage()

    expect(text).toContain('Choose a new password')
    expect(text).toContain('Back to sign in')
    expect(html).toContain('href="/sign-in"')
    await unmount(container, root)
  })

  it('offers Request a new reset link when the token is invalid or expired', async () => {
    routerState.search = { token: 'expired-token' }
    routerState.pathname = '/reset-password'
    globalThis.history.replaceState({}, '', '/reset-password?token=expired-token')
    const { container, root } = await renderPage()

    await act(async () => {
      await mutationState.captured[0]?.onSuccess?.({
        ok: false,
        error: { code: 'token_expired', message: 'expired' },
      })
    })

    expect(container.textContent).toContain('Request a new reset link')
    expect(container.innerHTML).toContain('href="/forgot-password"')
    await unmount(container, root)
  })

  it('keeps recovery context when requesting another link', async () => {
    routerState.search = {
      token: 'expired-token',
      organization_id: 'org-1',
      locale: 'en',
    }
    routerState.pathname = '/reset-password'
    globalThis.history.replaceState(
      {},
      '',
      '/reset-password?token=expired-token&organization_id=org-1&locale=en',
    )
    const { container, root } = await renderPage()

    await act(async () => {
      await mutationState.captured[0]?.onSuccess?.({
        ok: false,
        error: { code: 'token_expired', message: 'expired' },
      })
    })

    expect(container.innerHTML).toContain(
      'href="/forgot-password?organization_id=org-1&amp;locale=en"',
    )
    await unmount(container, root)
  })

  it('does not offer the reset-link exit for other errors', async () => {
    routerState.search = { token: 'valid-token' }
    routerState.pathname = '/reset-password'
    globalThis.history.replaceState({}, '', '/reset-password?token=valid-token')
    const { container, root } = await renderPage()

    await act(async () => {
      await mutationState.captured[0]?.onSuccess?.({
        ok: false,
        error: { code: 'password_breached', message: 'breached' },
      })
    })

    expect(container.textContent).not.toContain('Request a new reset link')
    await unmount(container, root)
  })
})
