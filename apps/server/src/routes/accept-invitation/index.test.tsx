// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

const CLAIM_IDENTIFIER = 'a'.repeat(64)

const routerState = vi.hoisted(() => ({
  search: {} as { token?: string },
}))

const authState = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}))

const turnstileState = vi.hoisted(() => ({
  siteKey: null as string | null,
  token: null as string | null,
  onToken: null as ((token: string) => void) | null,
}))

vi.mock('@xid-kit/crypto', () => ({
  sha256Hex: async () => 'a'.repeat(64),
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

vi.mock('../../components/layout', () => ({
  AuthLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('../../components/ui', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div role="alert">{children}</div>,
  Button: ({
    children,
    isLoading: _isLoading,
    fullWidth: _fullWidth,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    children: ReactNode
    isLoading?: boolean
    fullWidth?: boolean
  }) => <button {...props}>{children}</button>,
  PageHeader: ({ title, lead }: { title: ReactNode; lead?: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {lead}
    </header>
  ),
  Spinner: ({ label }: { label?: string }) => <span>{label ?? 'Loading'}</span>,
}))

vi.mock('../../lib/auth-context', () => ({
  useAuth: () => ({
    api: {
      get: authState.get,
      post: authState.post,
    },
  }),
}))

vi.mock('../../lib/google-analytics-funnel', () => ({
  trackInvitationAccepted: vi.fn(),
}))

vi.mock('../sign-in/useTurnstile', () => ({
  useTurnstile: (
    siteKey: string | null,
    token: string | null,
    onToken: (token: string) => void,
  ) => {
    turnstileState.siteKey = siteKey
    turnstileState.token = token
    turnstileState.onToken = onToken
    return { containerRef: { current: null } }
  },
}))

import { AcceptInvitationPage, invitationNavigation } from './index'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type RenderedPage = {
  container: HTMLDivElement
  root: ReturnType<typeof createRoot>
  queryClient: QueryClient
}

async function flushQueries(): Promise<void> {
  for (let index = 0; index < 6; index++) {
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
    })
  }
}

async function renderPage(): Promise<RenderedPage> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AcceptInvitationPage />
      </QueryClientProvider>,
    )
  })
  await flushQueries()
  return { container, root, queryClient }
}

async function disposePage(page: RenderedPage): Promise<void> {
  await act(async () => page.root.unmount())
  page.queryClient.clear()
  page.container.remove()
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text),
  )
  if (!button) throw new Error(`Expected button containing "${text}"`)
  return button
}

describe('AcceptInvitationPage proof-first flow', () => {
  beforeEach(() => {
    routerState.search = {}
    authState.get.mockReset()
    authState.post.mockReset()
    turnstileState.siteKey = null
    turnstileState.token = null
    turnstileState.onToken = null
    globalThis.sessionStorage.clear()
    globalThis.history.replaceState({}, '', '/accept-invitation')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('scrubs the claim token fragment without verifying on mount', async () => {
    globalThis.history.replaceState({}, '', '/accept-invitation#claim_token=signed-email-claim')
    const replaceState = vi.spyOn(globalThis.history, 'replaceState')

    const page = await renderPage()

    expect(globalThis.location.hash).toBe('')
    expect(replaceState).toHaveBeenCalledWith({}, '', '/accept-invitation')
    expect(authState.post).not.toHaveBeenCalled()
    expect(page.container.textContent).toContain('Confirm your invitation')
    expect(globalThis.sessionStorage.getItem(`${CLAIM_IDENTIFIER}.token`)).toBeNull()
    expect(
      globalThis.sessionStorage.getItem(`xid.invitation-claim.${CLAIM_IDENTIFIER}.token`),
    ).toBe('signed-email-claim')

    await disposePage(page)
  })

  it('previews the raw invitation and starts the Email claim with the Turnstile token', async () => {
    routerState.search = { token: 'raw-invitation-token' }
    authState.get.mockImplementation(async (path: string) => {
      if (path === '/auth/invitation/preview?token=raw-invitation-token') {
        return {
          ok: true,
          value: {
            status: 'pending',
            email: 'invitee@example.com',
            orgId: 'org_1',
            orgName: 'Acme',
            role: 'member',
            expiresAt: '2026-08-01T00:00:00.000Z',
          },
        }
      }
      if (path === '/auth/config?organization_id=org_1') {
        return {
          ok: true,
          value: {
            resolution: { status: 'ready' },
            identifierMode: 'email',
            requireVerifiedEmail: true,
            allowedEmailDomains: [],
            blockedEmailDomains: [],
            forceSso: false,
            allowUserCreation: true,
            allowExistingUserLogin: true,
            turnstileSiteKey: 'turnstile-site-key',
            guest: null,
            profileFields: {
              email: 'required',
              username: 'hidden',
              phone: 'hidden',
              name: 'hidden',
              givenName: 'hidden',
              familyName: 'hidden',
            },
            methods: {
              password: { enabled: false, allowLogin: false, allowUserCreation: false },
              magicLink: { enabled: true, allowLogin: true, allowUserCreation: true },
              emailOtp: { enabled: true, allowLogin: true, allowUserCreation: true },
              whatsappOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
              smsOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
              passkey: { enabled: false, allowLogin: false, allowUserCreation: false },
              enterpriseSso: {
                enabled: false,
                allowLogin: false,
                allowJitUserCreation: false,
                domainDiscovery: false,
                allowedEmailDomains: [],
                blockedEmailDomains: [],
              },
            },
            socialProviders: [],
          },
        }
      }
      throw new Error(`Unexpected GET ${path}`)
    })
    authState.post.mockResolvedValue({ ok: true, value: { ok: true } })

    const page = await renderPage()
    const startButton = buttonWithText(page.container, 'Email me a secure link')

    expect(authState.get).toHaveBeenNthCalledWith(
      1,
      '/auth/invitation/preview?token=raw-invitation-token',
    )
    expect(turnstileState.siteKey).toBe('turnstile-site-key')
    expect(startButton.disabled).toBe(true)

    await act(async () => {
      turnstileState.onToken?.('turnstile-response')
    })
    expect(startButton.disabled).toBe(false)

    await act(async () => {
      startButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushQueries()

    expect(authState.post).toHaveBeenCalledWith('/auth/invitation/claim', {
      token: 'raw-invitation-token',
      turnstileToken: 'turnstile-response',
    })
    expect(page.container.textContent).toContain('Check your email')
    expect(authState.post).not.toHaveBeenCalledWith('/auth/invitation/accept', expect.anything())
    expect(authState.post).not.toHaveBeenCalledWith('/auth/sign-in', expect.anything())

    await disposePage(page)
  })

  it('ignores and clears a stale stored claim when a new raw invitation URL is opened', async () => {
    routerState.search = { token: 'new-raw-invitation' }
    globalThis.sessionStorage.setItem('xid.invitation-claim.current', CLAIM_IDENTIFIER)
    globalThis.sessionStorage.setItem(
      `xid.invitation-claim.${CLAIM_IDENTIFIER}.token`,
      'stale-email-claim',
    )
    globalThis.sessionStorage.setItem(
      `xid.invitation-claim.${CLAIM_IDENTIFIER}.recovery`,
      'stale-recovery-key-that-is-long-enough',
    )
    authState.get.mockImplementation(async (path: string) => {
      if (path === '/auth/invitation/preview?token=new-raw-invitation') {
        return {
          ok: true,
          value: {
            status: 'pending',
            email: 'new@example.com',
            orgId: null,
            orgName: 'New organization',
            role: 'member',
            expiresAt: '2026-08-01T00:00:00.000Z',
          },
        }
      }
      throw new Error(`Unexpected GET ${path}`)
    })

    const page = await renderPage()

    expect(page.container.textContent).toContain('Join')
    expect(page.container.textContent).not.toContain('Confirm your invitation')
    expect(authState.get).toHaveBeenCalledWith('/auth/invitation/preview?token=new-raw-invitation')
    expect(globalThis.sessionStorage.getItem('xid.invitation-claim.current')).toBeNull()
    expect(
      globalThis.sessionStorage.getItem(`xid.invitation-claim.${CLAIM_IDENTIFIER}.token`),
    ).toBeNull()
    expect(
      globalThis.sessionStorage.getItem(`xid.invitation-claim.${CLAIM_IDENTIFIER}.recovery`),
    ).toBeNull()

    await disposePage(page)
  })

  it('reuses the recovery key after a failed response, then clears storage and assigns the redirect', async () => {
    globalThis.history.replaceState({}, '', '/accept-invitation#claim_token=signed-email-claim')
    const assign = vi.spyOn(invitationNavigation, 'assign').mockImplementation(() => undefined)
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues')
    authState.post
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'token_invalid', message: '', httpStatus: 400 },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { redirectUrl: '/console/org?orgId=org_1' },
      })

    const page = await renderPage()
    const confirmButton = buttonWithText(page.container, 'Confirm and join')

    expect(authState.post).not.toHaveBeenCalled()

    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushQueries()

    const firstBody = authState.post.mock.calls[0]?.[1] as {
      token: string
      recoveryKey: string
    }
    expect(authState.post).toHaveBeenNthCalledWith(1, '/auth/invitation/claim/verify', {
      token: 'signed-email-claim',
      recoveryKey: firstBody.recoveryKey,
    })
    expect(firstBody.recoveryKey).toHaveLength(64)
    expect(
      globalThis.sessionStorage.getItem(`xid.invitation-claim.${CLAIM_IDENTIFIER}.recovery`),
    ).toBe(firstBody.recoveryKey)

    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushQueries()

    expect(authState.post).toHaveBeenNthCalledWith(2, '/auth/invitation/claim/verify', {
      token: 'signed-email-claim',
      recoveryKey: firstBody.recoveryKey,
    })
    expect(random).toHaveBeenCalledOnce()
    expect(globalThis.sessionStorage.getItem('xid.invitation-claim.current')).toBeNull()
    expect(
      globalThis.sessionStorage.getItem(`xid.invitation-claim.${CLAIM_IDENTIFIER}.token`),
    ).toBeNull()
    expect(
      globalThis.sessionStorage.getItem(`xid.invitation-claim.${CLAIM_IDENTIFIER}.recovery`),
    ).toBeNull()
    expect(assign).toHaveBeenCalledWith('/console/org?orgId=org_1')
    expect(authState.post.mock.calls.map(([path]) => path)).not.toContain('/auth/invitation/accept')

    await disposePage(page)
  })
})
