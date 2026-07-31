// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InputHTMLAttributes, ReactNode } from 'react'

const routerState = vi.hoisted(() => ({
  navigate: vi.fn(),
}))

const authState = vi.hoisted(() => ({
  user: {
    id: 'user_1',
    email: 'owner@example.com',
    emailVerified: false,
    name: null,
    imageUrl: null,
    locale: null,
    hasMfa: false,
    instanceManager: false,
    provisioned_by: undefined as string | undefined,
  },
  post: vi.fn(),
  refresh: vi.fn(async () => undefined),
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
}))

vi.mock('../../lib/router', () => ({
  useNavigate: () => routerState.navigate,
}))

vi.mock('../../lib/auth-context', () => ({
  isGuestUser: (user: { provisioned_by?: string } | null | undefined) =>
    user?.provisioned_by === 'anonymous',
  useAuth: () => ({
    api: { post: authState.post },
    refresh: authState.refresh,
    signOut: authState.signOut,
    user: authState.user,
  }),
}))

vi.mock('../../lib/google-analytics-funnel', () => ({
  trackOrganizationCreated: vi.fn(),
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
    ...props
  }: {
    children: ReactNode
    isLoading?: boolean
  }) => <button {...props}>{children}</button>,
  Field: ({
    label,
    hint,
    children,
  }: {
    label: ReactNode
    hint?: ReactNode
    children: ReactNode
  }) => (
    <label>
      {label}
      {children}
      {hint}
    </label>
  ),
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  PageHeader: ({ title, lead }: { title: ReactNode; lead?: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {lead}
    </header>
  ),
}))

import { CreateOrganizationPage } from './index'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderPage(): Promise<{
  container: HTMLDivElement
  root: ReturnType<typeof createRoot>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<CreateOrganizationPage />)
  })
  return { container, root }
}

describe('CreateOrganizationPage', () => {
  beforeEach(() => {
    authState.user.email = 'owner@example.com'
    authState.user.provisioned_by = undefined
    authState.post.mockReset()
    authState.refresh.mockClear()
    authState.signOut.mockClear()
    routerState.navigate.mockClear()
  })

  it('prefills and locks an email already attached to the session user', async () => {
    const { container, root } = await renderPage()
    const email = container.querySelector<HTMLInputElement>('input[name="email"]')

    expect(email?.value).toBe('owner@example.com')
    expect(email?.readOnly).toBe(true)
    expect(email?.required).toBe(true)

    await act(async () => root.unmount())
    container.remove()
  })

  it('accepts a guest email and includes it in organization creation', async () => {
    authState.user.email = ''
    authState.user.provisioned_by = 'anonymous'
    authState.post.mockResolvedValue({
      ok: true,
      value: {
        id: 'org_1',
        slug: 'acme',
        name: 'Acme',
        role: 'owner',
        redirectUrl: '/console/org?orgId=org_1',
      },
    })
    const { container, root } = await renderPage()
    const email = container.querySelector<HTMLInputElement>('input[name="email"]')
    const name = container.querySelector<HTMLInputElement>('input[name="organization-name"]')
    const slug = container.querySelector<HTMLInputElement>('input[name="organization-slug"]')
    const form = container.querySelector('form')
    if (!email || !name || !slug || !form) throw new Error('Expected organization form fields')

    expect(email.readOnly).toBe(false)
    expect(container.textContent).toContain(
      'Verify this address to secure your account. You can recover your account with it after verifying.',
    )

    await act(async () => {
      setInputValue(email, 'guest@example.com')
      setInputValue(name, 'Acme')
      setInputValue(slug, 'acme')
    })
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(authState.post).toHaveBeenCalledWith('/v1/organizations/self', {
      email: 'guest@example.com',
      name: 'Acme',
      slug: 'acme',
    })
    expect(authState.refresh).toHaveBeenCalledOnce()
    expect(routerState.navigate).toHaveBeenCalledWith('/console/org?orgId=org_1', { replace: true })

    await act(async () => root.unmount())
    container.remove()
  })

  it('derives the slug from the organization name until the slug is edited manually', async () => {
    const { container, root } = await renderPage()
    const name = container.querySelector<HTMLInputElement>('input[name="organization-name"]')
    const slug = container.querySelector<HTMLInputElement>('input[name="organization-slug"]')
    if (!name || !slug) throw new Error('Expected organization form fields')

    await act(async () => {
      setInputValue(name, 'Acme Inc')
    })
    expect(slug.value).toBe('acme-inc')

    await act(async () => {
      setInputValue(slug, 'custom-slug')
    })
    await act(async () => {
      setInputValue(name, 'Acme Incorporated')
    })
    expect(slug.value).toBe('custom-slug')

    await act(async () => root.unmount())
    container.remove()
  })

  it('signs out from the footer exit to switch accounts', async () => {
    const { container, root } = await renderPage()
    const exit = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Sign out and use a different account'),
    )
    if (!exit) throw new Error('Expected footer sign-out exit')

    await act(async () => {
      exit.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(authState.signOut).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    container.remove()
  })
})
