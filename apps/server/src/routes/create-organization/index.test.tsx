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
  },
  post: vi.fn(),
  refresh: vi.fn(async () => undefined),
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
  useAuth: () => ({
    api: { post: authState.post },
    refresh: authState.refresh,
    user: authState.user,
  }),
}))

vi.mock('../../lib/google-analytics-funnel', () => ({
  trackOrganizationCreated: vi.fn(),
}))

vi.mock('../../components/layout', () => ({
  AuthLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
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
    authState.post.mockReset()
    authState.refresh.mockClear()
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
})
