// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

const routerState = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, string>,
}))

const authState = vi.hoisted(() => ({
  signOut: vi.fn(),
  refresh: vi.fn(async () => {}),
}))

const mutationState = vi.hoisted(() => ({
  captured: [] as {
    onSuccess?: (result: unknown, variables?: unknown, context?: unknown) => unknown
  }[],
}))

const factorsState = vi.hoisted(() => ({
  factors: [] as { type: 'totp' | 'backup_codes' | 'sms' | 'passkey'; remaining?: number }[],
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join('') }),
}))

vi.mock('@tanstack/react-router', () => ({
  createLazyRoute: () => (options: unknown) => options,
  useSearch: () => routerState.search,
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  Link: ({ to, children }: { to: unknown; children: ReactNode }) => (
    <a href={typeof to === 'string' ? to : `${(to as { pathname?: string }).pathname ?? ''}`}>
      {children}
    </a>
  ),
  useNavigate: () => routerState.navigate,
}))

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: (typeof mutationState.captured)[number]) => {
    mutationState.captured.push(options)
    return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isSuccess: false }
  },
}))

vi.mock('../../components/layout', () => ({
  AuthLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('../../components/hosted/use-hosted-auth-config', () => ({
  useHostedAuthConfig: () => ({
    config: { context: { organizationName: 'Northwind', applicationName: 'Fleet Planner' } },
  }),
}))

vi.mock('../../components/ui', () => ({
  Notice: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Icon: () => null,
  Button: ({
    children,
    onClick,
    type,
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button type={type === 'submit' ? 'submit' : 'button'} onClick={onClick}>
      {children}
    </button>
  ),
  Spinner: () => <span>Loading</span>,
}))

vi.mock('../../lib/auth-context', () => ({
  useAuth: () => ({
    api: { post: vi.fn() },
    refresh: authState.refresh,
    signOut: authState.signOut,
    user: null,
  }),
}))

vi.mock('../../lib/google-analytics-funnel', () => ({
  trackMfaComplete: vi.fn(),
}))

vi.mock('@xid-kit/web-ui/api-error-message', () => ({
  apiErrorDescriptor: (classification: { code: string }) => ({ id: classification.code }),
  useApiErrorMessage: () => (error: { code: string }) => error.code,
}))

vi.mock('../../lib/default-landing', () => ({
  useDefaultLandingPath: () => '/console',
}))

vi.mock('../account/queries', () => ({
  useMfaFactorsQuery: () => ({
    data: factorsState.factors,
    isPending: false,
    error: null,
    refetch: vi.fn(),
    isRefetching: false,
  }),
}))

import { Route } from './index'

const MfaPage = (Route as unknown as { component: () => ReactNode }).component

async function renderPage(): Promise<{
  container: HTMLDivElement
  root: ReturnType<typeof createRoot>
  text: string
}> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<MfaPage />)
  })
  return { container, root, text: container.textContent ?? '' }
}

async function unmount(
  container: HTMLDivElement,
  root: ReturnType<typeof createRoot>,
): Promise<void> {
  await act(async () => root.unmount())
  container.remove()
}

function buttonNamed(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === text,
  )
}

describe('MfaPage', () => {
  beforeEach(() => {
    routerState.navigate.mockClear()
    authState.signOut.mockClear()
    authState.refresh.mockClear()
    mutationState.captured.length = 0
    routerState.search = {}
    factorsState.factors = []
    globalThis.localStorage.clear()
  })

  it('opens the authenticator challenge by default and lets the user switch accounts', async () => {
    factorsState.factors = [{ type: 'totp' }, { type: 'backup_codes', remaining: 7 }]

    const { container, root, text } = await renderPage()

    expect(text).toContain('Enter the code from your authenticator app')
    expect(text).toContain('Try another way')
    await act(async () => {
      buttonNamed(container, 'Sign in as someone else')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    expect(authState.signOut).toHaveBeenCalledTimes(1)
    await unmount(container, root)
  })

  it('lists every method on the chooser with the remaining backup code count', async () => {
    routerState.search = { method: 'choose' }
    factorsState.factors = [
      { type: 'passkey' },
      { type: 'totp' },
      { type: 'backup_codes', remaining: 7 },
    ]

    const { container, root, text } = await renderPage()

    expect(text).toContain('Choose another way to verify')
    expect(text).toContain('Use a passkey')
    expect(text).toContain('Authenticator app')
    expect(text).toContain('7 codes left')
    await unmount(container, root)
  })

  it('opens the method this browser used last', async () => {
    globalThis.localStorage.setItem('xid.lastMfaMethod', 'backup')
    factorsState.factors = [{ type: 'totp' }, { type: 'backup_codes', remaining: 3 }]

    const { container, root, text } = await renderPage()

    expect(text).toContain('Enter a backup code')
    await unmount(container, root)
  })

  it('shows the passkey challenge when it is the only method', async () => {
    factorsState.factors = [{ type: 'passkey' }]

    const { container, root, text } = await renderPage()

    expect(text).toContain('Verify with your passkey')
    expect(text).not.toContain('Try another way')
    await unmount(container, root)
  })

  it('never offers a text message code for step-up', async () => {
    routerState.search = { step_up: '1' }
    factorsState.factors = [{ type: 'sms' }]

    const { container, root, text } = await renderPage()

    expect(text).toContain('No way to verify on this account')
    expect(text).not.toContain('Text me a code')
    await unmount(container, root)
  })

  it('cancels a step-up back to where the user came from', async () => {
    routerState.search = { step_up: '1', method: 'totp', redirect_to: '/account/security' }
    factorsState.factors = [{ type: 'totp' }]

    const { container, root } = await renderPage()
    await act(async () => {
      buttonNamed(container, 'Cancel')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(routerState.navigate).toHaveBeenCalledWith('/account/security', { replace: true })
    await unmount(container, root)
  })

  it.each([
    ['an external redirect_to', 'https://evil.example.com/phish', '/console'],
    ['a protocol-relative redirect_to', '//evil.example.com', '/console'],
    ['an internal redirect target', '/account/security', '/account/security'],
    [
      'the stashed authorization request',
      '/authorize?authz_request_id=authz_1&client_id=app_1',
      '/authorize?authz_request_id=authz_1&client_id=app_1',
    ],
  ])('resumes safely after the challenge for %s', async (_name, redirectTo, expected) => {
    routerState.search = { method: 'totp', redirect_to: redirectTo }
    factorsState.factors = [{ type: 'totp' }]

    const { container, root } = await renderPage()
    await act(async () => {
      await mutationState.captured[0]?.onSuccess?.({ ok: true, value: {} })
    })

    expect(routerState.navigate).toHaveBeenCalledWith(expected, { replace: true })
    expect(globalThis.localStorage.getItem('xid.lastMfaMethod')).toBe('totp')
    await unmount(container, root)
  })
})
