// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

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

const authConfigState = vi.hoisted(() => ({
  data: undefined as { turnstileSiteKey: string | null } | undefined,
  isPending: false,
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@tanstack/react-router', () => ({
  createLazyRoute: () => (options: unknown) => options,
  useSearch: () => routerState.search,
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  Link: ({ to, children }: { to: unknown; children: ReactNode }) => (
    <a href={typeof to === 'string' ? to : ''}>{children}</a>
  ),
  useNavigate: () => routerState.navigate,
  useLocation: () => ({ pathname: routerState.pathname }),
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: authConfigState.data,
    isPending: authConfigState.isPending,
    error: null,
  }),
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
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Input: ({
    inputSize: _size,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & { inputSize?: string }) => <input {...props} />,
  Notice: ({ title, children }: { title?: ReactNode; children?: ReactNode }) => (
    <div role="alert">
      {title}
      {children}
    </div>
  ),
  PasswordField: ({ label, error }: { label: ReactNode; error?: ReactNode }) => (
    <label>
      {label}
      <input type="password" />
      {error}
    </label>
  ),
  Spinner: () => <span>Loading</span>,
}))

vi.mock('../../lib/auth-context', () => ({
  useAuth: () => ({
    api: { post: vi.fn(), get: vi.fn() },
    refresh: vi.fn(async () => {}),
  }),
}))

vi.mock('../sign-up/PasswordStrength', () => ({
  scorePassword: () => 0,
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

vi.mock('@xid-kit/web-ui/api-error-message', () => ({
  useApiErrorMessage: () => (error: { code: string }) => `api-error:${error.code}`,
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
    authConfigState.data = undefined
    authConfigState.isPending = false
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

  it('disables reset-link delivery until Turnstile is ready', async () => {
    authConfigState.data = { turnstileSiteKey: 'site-key' }

    const { container, root } = await renderPage()

    const submit = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Send reset link'),
    )
    expect(submit?.disabled).toBe(true)
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
    expect(globalThis.sessionStorage.getItem('xid.password-reset.token')).toBeNull()
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

  it('keeps application continuation when returning to sign in', async () => {
    routerState.search = {
      client_id: 'app-1',
      authz_request_id: 'authz-1',
      login_hint: 'user@example.com',
    }

    const { container, root, html } = await renderPage()

    expect(html).toContain(
      'href="/sign-in?client_id=app-1&amp;authz_request_id=authz-1&amp;login_hint=user%40example.com"',
    )
    await unmount(container, root)
  })

  it('shows the security check message only for captcha errors', async () => {
    const { container, root } = await renderPage()

    await act(async () => {
      await mutationState.captured[0]?.onSuccess?.({
        ok: false,
        error: { code: 'server_error', message: 'boom' },
      })
    })
    expect(container.textContent).toContain('api-error:server_error')
    expect(container.textContent).not.toContain("The security check didn't finish")

    await act(async () => {
      await mutationState.captured[0]?.onSuccess?.({
        ok: false,
        error: { code: 'captcha_failed', message: 'captcha' },
      })
    })
    expect(container.textContent).toContain("The security check didn't finish")
    await unmount(container, root)
  })

  it('titles the first password after email proof as account setup', async () => {
    routerState.search = { token: 'setup-token', setup: '1' }
    routerState.pathname = '/reset-password'
    globalThis.history.replaceState({}, '', '/reset-password?setup=1&token=setup-token')

    const { container, root, text } = await renderPage()

    expect(text).toContain('Set your password')
    expect(text).not.toContain('Choose a new password')
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
    expect(container.textContent).toContain('This password appeared in a data breach')
    await unmount(container, root)
  })
})
