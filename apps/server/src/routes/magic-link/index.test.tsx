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

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

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

  it('does not reuse a stored credential on an unrelated history entry', async () => {
    globalThis.sessionStorage.setItem('xid.magic-link.token', 'stale-magic-link')
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

    expect(container.textContent).toContain('No magic-link token found')
    expect(container.textContent).not.toContain('Confirm sign in')
    expect(authState.post).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    queryClient.clear()
    container.remove()
  })

  it('recovers the credential when the same scrubbed history entry is reloaded', async () => {
    const firstContainer = document.createElement('div')
    document.body.appendChild(firstContainer)
    const firstRoot = createRoot(firstContainer)
    const firstQueryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    await act(async () => {
      firstRoot.render(
        <QueryClientProvider client={firstQueryClient}>
          <MagicLinkPage />
        </QueryClientProvider>,
      )
    })
    expect(globalThis.location.hash).toBe('')
    expect(firstContainer.textContent).toContain('Confirm sign in')
    await act(async () => firstRoot.unmount())
    firstQueryClient.clear()
    firstContainer.remove()

    const reloadedContainer = document.createElement('div')
    document.body.appendChild(reloadedContainer)
    const reloadedRoot = createRoot(reloadedContainer)
    const reloadedQueryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    await act(async () => {
      reloadedRoot.render(
        <QueryClientProvider client={reloadedQueryClient}>
          <MagicLinkPage />
        </QueryClientProvider>,
      )
    })

    expect(reloadedContainer.textContent).toContain('Confirm sign in')
    expect(reloadedContainer.textContent).not.toContain('No magic-link token found')

    await act(async () => reloadedRoot.unmount())
    reloadedQueryClient.clear()
    reloadedContainer.remove()
  })

  it('clears a rejected credential and keeps one recovery message', async () => {
    authState.post.mockResolvedValue({
      ok: false,
      error: { code: 'magic_link_invalid', message: 'invalid', httpStatus: 400 },
    })
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
    const button = container.querySelector('button')
    if (!button) throw new Error('confirmation button missing')
    await act(async () => button.click())
    await flush()

    expect(globalThis.sessionStorage.getItem('xid.magic-link.token')).toBeNull()
    expect(container.textContent).toContain('This magic link is invalid or has already been used.')
    expect(container.textContent).not.toContain('No magic-link token found')

    await act(async () => root.unmount())
    queryClient.clear()
    container.remove()
  })

  it('invalidates component state when History marker cleanup is unavailable', async () => {
    authState.post.mockResolvedValue({
      ok: false,
      error: { code: 'magic_link_invalid', message: 'invalid', httpStatus: 400 },
    })
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
    const replaceState = vi.spyOn(globalThis.history, 'replaceState').mockImplementation(() => {
      throw new DOMException('History unavailable', 'SecurityError')
    })
    const button = container.querySelector('button')
    if (!button) throw new Error('confirmation button missing')
    await act(async () => button.click())
    await flush()

    expect(globalThis.sessionStorage.getItem('xid.magic-link.token')).toBeNull()
    expect(container.textContent).toContain('This magic link is invalid or has already been used.')
    expect(container.textContent).not.toContain('No magic-link token found')

    replaceState.mockRestore()
    await act(async () => root.unmount())
    queryClient.clear()
    container.remove()
  })

  it('retains the credential and offers retry for a transient failure', async () => {
    authState.post.mockResolvedValue({
      ok: false,
      error: { code: 'server_error', message: 'unavailable', httpStatus: 500 },
    })
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
    const confirm = container.querySelector('button')
    if (!confirm) throw new Error('confirmation button missing')
    await act(async () => {
      confirm.click()
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
    })
    await flush()

    expect(globalThis.sessionStorage.getItem('xid.magic-link.token')).toBe('signed-magic-link')
    expect(container.textContent).toContain('Something went wrong. Please try again.')
    expect(
      Array.from(container.querySelectorAll('button')).map((button) => button.textContent),
    ).toEqual(['Try again'])

    await act(async () => root.unmount())
    queryClient.clear()
    container.remove()
  })
})
