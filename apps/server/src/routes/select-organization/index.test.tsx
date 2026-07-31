// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

const routerState = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as { authz_request_id?: string; redirect_to?: string },
}))

const authState = vi.hoisted(() => ({
  organizations: [] as Array<{ id: string; name: string; slug: string }>,
  setActiveOrganization: vi.fn(async () => true),
  signOut: vi.fn(async () => undefined),
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((copy, part, index) => copy + part + String(values[index] ?? ''), ''),
  }),
}))

vi.mock('@tanstack/react-router', () => ({
  createLazyRoute: () => (options: unknown) => options,
  useSearch: () => routerState.search,
}))

vi.mock('../../lib/router', () => ({
  useNavigate: () => routerState.navigate,
}))

vi.mock('../../lib/auth-context', () => ({
  useAuth: () => ({
    organizations: authState.organizations,
    setActiveOrganization: authState.setActiveOrganization,
    signOut: authState.signOut,
  }),
}))

vi.mock('../../lib/google-analytics-funnel', () => ({
  trackOrganizationSelected: vi.fn(),
}))

vi.mock('../../components/layout', () => ({
  AuthLayout: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) => (
    <>
      {children}
      {footer}
    </>
  ),
}))

vi.mock('../../components/RequireAuth', () => ({
  RequireAuth: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('../../components/ui', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div role="alert">{children}</div>,
  Button: ({
    children,
    isLoading: _isLoading,
    fullWidth: _fullWidth,
    variant: _variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    children: ReactNode
    isLoading?: boolean
    fullWidth?: boolean
    variant?: string
  }) => <button {...props}>{children}</button>,
  PageHeader: ({ title, lead }: { title: ReactNode; lead?: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {lead}
    </header>
  ),
  Spinner: ({ label }: { label?: string }) => <span>{label ?? 'Loading'}</span>,
}))

import { SelectOrganizationPage } from './index'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

async function renderPage(): Promise<{
  container: HTMLDivElement
  root: ReturnType<typeof createRoot>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<SelectOrganizationPage />)
  })
  return { container, root }
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text),
  )
  if (!button) throw new Error(`Expected button containing "${text}"`)
  return button
}

describe('SelectOrganizationPage', () => {
  beforeEach(() => {
    routerState.search = {}
    routerState.navigate.mockClear()
    authState.organizations = []
    authState.setActiveOrganization.mockClear()
    authState.setActiveOrganization.mockResolvedValue(true)
    authState.signOut.mockClear()
  })

  it('offers a Create organization CTA when the user belongs to no organization', async () => {
    const { container, root } = await renderPage()

    expect(container.textContent).toContain('You do not belong to any organizations yet.')

    await act(async () => {
      buttonWithText(container, 'Create organization').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })

    expect(routerState.navigate).toHaveBeenCalledWith('/create-organization')

    await act(async () => root.unmount())
    container.remove()
  })

  it('signs out from the footer exit to switch accounts', async () => {
    const { container, root } = await renderPage()

    await act(async () => {
      buttonWithText(container, 'Sign out and use a different account').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })

    expect(authState.signOut).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    container.remove()
  })

  it('activates the chosen organization and navigates to the safe redirect', async () => {
    authState.organizations = [
      { id: 'org_1', name: 'Acme', slug: 'acme' },
      { id: 'org_2', name: 'Globex', slug: 'globex' },
    ]
    const { container, root } = await renderPage()

    await act(async () => {
      buttonWithText(container, 'Globex').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(authState.setActiveOrganization).toHaveBeenCalledWith('org_2')
    expect(routerState.navigate).toHaveBeenCalledWith('/console', { replace: true })

    await act(async () => root.unmount())
    container.remove()
  })
})
