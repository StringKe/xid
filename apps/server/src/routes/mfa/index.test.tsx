// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InputHTMLAttributes, ReactNode } from 'react'

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
  factors: [] as { type: 'totp' | 'backup_codes' | 'sms' | 'passkey' }[],
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

vi.mock('../../lib/motion', () => ({
  motion: {
    div: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  },
  springDefault: {},
}))

vi.mock('../../components/layout', () => ({
  AuthLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
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
    api: { post: vi.fn() },
    refresh: authState.refresh,
    signOut: authState.signOut,
  }),
}))

vi.mock('../../lib/google-analytics-funnel', () => ({
  trackMfaComplete: vi.fn(),
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

const MfaPage = (
  Route as unknown as {
    component: () => ReactNode
  }
).component

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

describe('MfaPage challenge exits', () => {
  beforeEach(() => {
    routerState.navigate.mockClear()
    authState.signOut.mockClear()
    authState.refresh.mockClear()
    mutationState.captured.length = 0
    routerState.search = {}
    factorsState.factors = []
  })

  it('shows Cancel and sign out on the method selector and signs out on click', async () => {
    factorsState.factors = [{ type: 'totp' }, { type: 'backup_codes' }]

    const { container, root, text } = await renderPage()

    expect(text).toContain('Two-factor authentication')
    const cancelButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Cancel and sign out',
    )
    expect(cancelButton).toBeDefined()

    await act(async () => {
      cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(authState.signOut).toHaveBeenCalledTimes(1)
    await unmount(container, root)
  })

  it('shows Cancel and sign out on the TOTP challenge', async () => {
    routerState.search = { method: 'totp' }
    factorsState.factors = [{ type: 'totp' }]

    const { container, root, text } = await renderPage()

    expect(text).toContain('Authenticator code')
    expect(text).toContain('Cancel and sign out')
    await unmount(container, root)
  })

  it('shows Cancel and sign out on the backup code challenge', async () => {
    routerState.search = { method: 'backup' }
    factorsState.factors = [{ type: 'totp' }, { type: 'backup_codes' }]

    const { container, root, text } = await renderPage()

    expect(text).toContain('Backup code')
    expect(text).toContain('Cancel and sign out')
    await unmount(container, root)
  })

  it('shows Cancel and sign out on the passkey challenge', async () => {
    routerState.search = { method: 'passkey' }
    factorsState.factors = [{ type: 'passkey' }]

    const { container, root, text } = await renderPage()

    expect(text).toContain('Passkey verification')
    expect(text).toContain('Cancel and sign out')
    await unmount(container, root)
  })

  it('falls back to /console for an external redirect target', async () => {
    routerState.search = { method: 'totp' }
    factorsState.factors = [{ type: 'totp' }]

    const { container, root } = await renderPage()

    await act(async () => {
      await mutationState.captured[0]?.onSuccess?.({
        ok: true,
        value: { redirectTo: 'https://evil.example.com/phish' },
      })
    })

    expect(routerState.navigate).toHaveBeenCalledWith('/console', { replace: true })
    await unmount(container, root)
  })

  it('falls back to /console for a protocol-relative redirect_to param', async () => {
    routerState.search = { method: 'totp', redirect_to: '//evil.example.com' }
    factorsState.factors = [{ type: 'totp' }]

    const { container, root } = await renderPage()

    await act(async () => {
      await mutationState.captured[0]?.onSuccess?.({ ok: true, value: {} })
    })

    expect(routerState.navigate).toHaveBeenCalledWith('/console', { replace: true })
    await unmount(container, root)
  })

  it('keeps a legitimate internal redirect target', async () => {
    routerState.search = { method: 'totp', redirect_to: '/account/security' }
    factorsState.factors = [{ type: 'totp' }]

    const { container, root } = await renderPage()

    await act(async () => {
      await mutationState.captured[0]?.onSuccess?.({ ok: true, value: {} })
    })

    expect(routerState.navigate).toHaveBeenCalledWith('/account/security', { replace: true })
    await unmount(container, root)
  })
})
