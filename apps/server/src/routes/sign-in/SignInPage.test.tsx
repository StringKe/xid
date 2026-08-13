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
  status: 'authenticated' as 'authenticated' | 'unauthenticated',
}))

const signInState = vi.hoisted(() => ({
  enabledMethods: [] as string[],
  guestCapability: false,
  tenantSelection: {
    continueParam: null as string | null,
    redirect: null as string | null,
    authzRequestId: null as string | null,
  },
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@tanstack/react-router', () => ({
  createLazyRoute: () => (options: unknown) => options,
  useSearch: () => routerState.search,
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
}))

vi.mock('../../lib/auth-context', () => ({
  useAuth: () => ({ status: authState.status }),
}))

vi.mock('../../lib/router', () => ({
  Link: ({ to, children }: { to: unknown; children: ReactNode }) => (
    <a
      href={
        typeof to === 'string'
          ? to
          : `${(to as { pathname?: string }).pathname ?? ''}${(to as { search?: string }).search ?? ''}`
      }
    >
      {children}
    </a>
  ),
  useNavigate: () => routerState.navigate,
}))

vi.mock('./shared', () => ({
  getEnabledOtpMethods: () => [],
  identifierPrompt: () => ({ mode: 'email', type: 'email', autoComplete: 'email' }),
  requiredProfileFields: () => [],
  resolveHostedReturn: (continueUrl: string | null, authzRequestId: string | null) =>
    authzRequestId
      ? `/authorize?authz_request_id=${encodeURIComponent(authzRequestId)}`
      : (continueUrl ?? '/console'),
  resolveOtpMethod: () => 'otp-email',
  visibleProfileFields: () => [],
}))

vi.mock('./SignInGuestButton', () => ({
  SignInGuestButton: () => <div>Guest entry</div>,
}))

vi.mock('./SignInOtpPanel', () => ({
  SignInOtpPanel: () => null,
}))

vi.mock('./SignInSocialButtons', () => ({
  SignInSocialButtons: () => null,
}))

vi.mock('./SignInTabs', () => ({
  SignInPanel: ({ children }: { children: ReactNode }) => <>{children}</>,
  SignInTabs: () => null,
}))

vi.mock('./useTurnstile', () => ({
  useTurnstile: () => ({ containerRef: { current: null } }),
}))

vi.mock('./useSignIn', () => ({
  useSignIn: () => [
    {
      method: 'password',
      authConfig: {
        forceSso: false,
        socialProviders: [],
        resolution: { status: 'resolved' },
        guest: signInState.guestCapability ? { capabilityToken: 'guest-capability-token' } : null,
      },
      enabledMethods: signInState.enabledMethods,
      identifier: '',
      profileValues: {
        email: '',
        username: '',
        phone: '',
        name: '',
        givenName: '',
        familyName: '',
      },
      password: '',
      rememberMe: false,
      otpCode: '',
      isLoading: false,
      passkeySupport: 'no',
      conditionalUiRunning: false,
      error: null,
      otpStep: 'input',
      turnstileToken: null,
      tenantSelection: signInState.tenantSelection,
    },
    {
      setMethod: vi.fn(),
      setIdentifier: vi.fn(),
      setProfileValue: vi.fn(),
      setPassword: vi.fn(),
      setRememberMe: vi.fn(),
      setOtpCode: vi.fn(),
      setTurnstileToken: vi.fn(),
      submitPassword: vi.fn(),
      submitMagicLink: vi.fn(),
      submitOtpRequest: vi.fn(),
      submitOtpVerify: vi.fn(),
      submitEnterpriseSso: vi.fn(),
      submitGuest: vi.fn(),
      triggerPasskeyButton: vi.fn(),
      handleSocial: vi.fn(),
      selectOrganizationContext: vi.fn(),
    },
  ],
}))

import { Route } from './SignInPage'

const SignInPage = (
  Route as unknown as {
    component: () => ReactNode
  }
).component

async function renderPage(): Promise<{ html: string; text: string }> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<SignInPage />)
  })
  const rendered = { html: container.innerHTML, text: container.textContent ?? '' }
  await act(async () => root.unmount())
  container.remove()
  return rendered
}

describe('SignInPage authenticated redirect', () => {
  beforeEach(() => {
    authState.status = 'authenticated'
    routerState.navigate.mockClear()
    routerState.search = {}
    signInState.enabledMethods = []
    signInState.guestCapability = false
    signInState.tenantSelection = {
      continueParam: null,
      redirect: null,
      authzRequestId: null,
    }
  })

  it('uses account-creation copy and password semantics for sign-up intent', async () => {
    authState.status = 'unauthenticated'
    routerState.search = { intent: 'sign-up' }
    signInState.enabledMethods = ['password']

    const rendered = await renderPage()

    expect(rendered.text).toContain('Create your account')
    expect(rendered.text).toContain('Sign up')
    expect(rendered.text).not.toContain('Forgot password?')
    expect(rendered.html).toContain('autocomplete="new-password"')
    expect(rendered.html).toContain('placeholder="Minimum 12 characters"')
  })

  it('does not expose the sign-in passkey action during sign-up', async () => {
    authState.status = 'unauthenticated'
    routerState.search = { intent: 'sign-up' }
    signInState.enabledMethods = ['passkey', 'password']

    const rendered = await renderPage()

    expect(rendered.text).not.toContain('Sign in with passkey')
    expect(rendered.text).toContain('Sign up')
  })

  it('keeps recovery and current-password semantics for sign-in intent', async () => {
    authState.status = 'unauthenticated'
    signInState.enabledMethods = ['password']

    const rendered = await renderPage()

    expect(rendered.text).toContain('Sign in')
    expect(rendered.text).toContain('Forgot password?')
    expect(rendered.html).toContain('href="/forgot-password"')
    expect(rendered.html).toContain('autocomplete="current-password"')
  })

  it('keeps organization and locale context in password recovery navigation', async () => {
    authState.status = 'unauthenticated'
    routerState.search = { organization_id: 'org-1', locale: 'en' }
    signInState.enabledMethods = ['password']

    const rendered = await renderPage()

    expect(rendered.html).toContain('href="/forgot-password?organization_id=org-1&amp;locale=en"')
  })

  it('renders guest entry only when the server config includes the capability', async () => {
    authState.status = 'unauthenticated'
    signInState.guestCapability = true

    expect((await renderPage()).text).toContain('Guest entry')

    signInState.guestCapability = false
    expect((await renderPage()).text).not.toContain('Guest entry')
  })

  it('shows the verified success alert and keeps the sign-in form for verified=1', async () => {
    authState.status = 'unauthenticated'
    routerState.search = { verified: '1' }
    signInState.enabledMethods = ['password']

    const rendered = await renderPage()

    expect(rendered.text).toContain('Your email has been verified. Sign in to continue.')
    expect(rendered.text).toContain('Sign in')
  })

  it('routes an authenticated sign-up session to organization onboarding', async () => {
    routerState.search = { intent: 'sign-up' }

    await renderPage()

    expect(routerState.navigate).toHaveBeenCalledWith('/create-organization', { replace: true })
  })

  it('keeps an explicit invitation continuation ahead of sign-up onboarding', async () => {
    routerState.search = { intent: 'sign-up' }
    signInState.tenantSelection.continueParam = '/accept-invitation?token=invite-1'

    await renderPage()

    expect(routerState.navigate).toHaveBeenCalledWith('/accept-invitation?token=invite-1', {
      replace: true,
    })
  })

  it('keeps the normal authenticated sign-in return', async () => {
    await renderPage()

    expect(routerState.navigate).toHaveBeenCalledWith('/console', { replace: true })
  })

  it('links sign-in to account creation and carries only whitelisted params', async () => {
    authState.status = 'unauthenticated'
    routerState.search = {
      continue: '/console',
      client_id: 'client-1',
      organization_id: 'org-1',
      authz_request_id: 'authz-1',
      login_hint: 'owner@example.com',
      verified: '1',
      reauthenticate: '1',
      select_account: '1',
    }

    const rendered = await renderPage()

    expect(rendered.text).toContain('New here? Create an account')
    const switchHref = /href="(\/sign-in\?[^"]*)"/.exec(rendered.html)?.[1]
    expect(switchHref).toBeDefined()
    const decoded = (switchHref ?? '').replaceAll('&amp;', '&')
    expect(decoded).toContain('intent=sign-up')
    expect(decoded).toContain('continue=%2Fconsole')
    expect(decoded).toContain('client_id=client-1')
    expect(decoded).toContain('organization_id=org-1')
    expect(decoded).toContain('authz_request_id=authz-1')
    expect(decoded).toContain('login_hint=owner%40example.com')
    expect(decoded).not.toContain('verified=')
    expect(decoded).not.toContain('reauthenticate=')
    expect(decoded).not.toContain('select_account=')
  })

  it('links sign-up back to sign-in without an intent param', async () => {
    authState.status = 'unauthenticated'
    routerState.search = {
      intent: 'sign-up',
      continue: '/console',
      invitation_token: 'invite-1',
      verified: '1',
    }

    const rendered = await renderPage()

    expect(rendered.text).toContain('Already have an account? Sign in')
    const switchHref = /href="(\/sign-in\?[^"]*)"/.exec(rendered.html)?.[1]
    expect(switchHref).toBeDefined()
    const decoded = (switchHref ?? '').replaceAll('&amp;', '&')
    expect(decoded).not.toContain('intent=')
    expect(decoded).toContain('continue=%2Fconsole')
    expect(decoded).toContain('invitation_token=invite-1')
    expect(decoded).not.toContain('verified=')
  })
})
