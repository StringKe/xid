// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const routerState = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as { intent?: string },
}))

const authState = vi.hoisted(() => ({
  status: 'authenticated' as 'authenticated' | 'unauthenticated',
}))

const signInState = vi.hoisted(() => ({
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
  Input: () => <input />,
  PageHeader: ({ title }: { title: ReactNode }) => <h1>{title}</h1>,
}))

vi.mock('../../lib/auth-context', () => ({
  useAuth: () => ({ status: authState.status }),
}))

vi.mock('../../lib/router', () => ({
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
  SignInGuestButton: () => null,
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
      },
      enabledMethods: [],
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

async function renderPage(): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<SignInPage />)
  })
  await act(async () => root.unmount())
  container.remove()
}

describe('SignInPage authenticated redirect', () => {
  beforeEach(() => {
    authState.status = 'authenticated'
    routerState.navigate.mockClear()
    routerState.search = {}
    signInState.tenantSelection = {
      continueParam: null,
      redirect: null,
      authzRequestId: null,
    }
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
})
