// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

const routerState = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, string>,
}))

const authState = vi.hoisted(() => ({
  status: 'authenticated' as 'authenticated' | 'unauthenticated',
}))

const signInState = vi.hoisted(() => ({
  step: 'identifier' as 'identifier' | 'methods' | 'sso' | 'organization',
  method: 'password',
  methods: [] as string[],
  enabledMethods: [] as string[],
  error: null as string | null,
  guestCapability: false,
  isSignUpFlow: false,
  allowUserCreation: true,
  organizationName: 'Northwind' as string | null,
  nameField: 'hidden' as 'hidden' | 'required',
  emailOtpSignUp: false,
  tenantSelection: {
    continueParam: null as string | null,
    redirect: null as string | null,
    authzRequestId: null as string | null,
  },
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((copy, part, index) => copy + part + String(values[index] ?? ''), ''),
    i18n: { date: () => '9:26 AM' },
  }),
}))

vi.mock('@tanstack/react-router', () => ({
  createLazyRoute: () => (options: unknown) => options,
  useSearch: () => routerState.search,
}))

vi.mock('../../components/layout', () => ({
  AuthLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('../../components/hosted/context-copy', () => ({
  useSignUpContextCopy: () => ({ title: 'your XID account' }),
}))

vi.mock('../../components/ui', () => ({
  Notice: ({ children }: { children: ReactNode }) => <div role="status">{children}</div>,
  Icon: () => null,
  Button: ({
    children,
    type,
    onClick,
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button type={type === 'submit' ? 'submit' : 'button'} onClick={onClick}>
      {children}
    </button>
  ),
  Field: ({ label, children }: { label?: ReactNode; children: ReactNode }) => (
    <label>
      {label}
      {children}
    </label>
  ),
  Input: ({
    inputSize: _inputSize,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & { inputSize?: string }) => <input {...props} />,
  PasswordField: ({
    label,
    labelAction,
    autoComplete,
  }: {
    label: ReactNode
    labelAction?: ReactNode
    autoComplete?: string
  }) => (
    <label>
      {label}
      {labelAction}
      <input type="password" autoComplete={autoComplete} />
    </label>
  ),
}))

vi.mock('../../lib/auth-context', () => ({
  useAuth: () => ({ status: authState.status }),
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  Link: ({ to, children }: { to: unknown; children: ReactNode }) => (
    <a href={typeof to === 'string' ? to : ''}>{children}</a>
  ),
  useNavigate: () => routerState.navigate,
}))

vi.mock('@xid-kit/web-ui/api-error-message', () => ({
  useApiErrorMessage: () => () => '',
}))

vi.mock('./SignInGuestButton', () => ({
  SignInGuestButton: () => <div>Guest entry</div>,
}))

vi.mock('./SignInSocialButtons', () => ({
  SignInSocialButtons: () => null,
}))

vi.mock('./useTurnstile', () => ({
  useTurnstile: () => ({ containerRef: { current: null } }),
}))

vi.mock('./useSignIn', () => ({
  useSignIn: () => [
    {
      step: signInState.step,
      method: signInState.method,
      methods: signInState.methods,
      authConfig: {
        identifierMode: 'email',
        forceSso: false,
        socialProviders: [],
        resolution: { status: 'ready' },
        guest: signInState.guestCapability ? { capabilityToken: 'guest-capability-token' } : null,
        passkeyEntry: { identifierRequired: false, reregistrationRequired: false },
        defaultLandingPath: '/console',
        profileFields: {
          email: 'required',
          username: 'hidden',
          phone: 'hidden',
          name: signInState.nameField,
          givenName: 'hidden',
          familyName: 'hidden',
        },
        allowUserCreation: signInState.allowUserCreation,
        methods: {
          password: { enabled: true, allowLogin: true, allowUserCreation: true },
          magicLink: { enabled: false, allowLogin: false, allowUserCreation: false },
          emailOtp: {
            enabled: signInState.emailOtpSignUp,
            allowLogin: signInState.emailOtpSignUp,
            allowUserCreation: signInState.emailOtpSignUp,
          },
          whatsappOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
          smsOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
        },
        context: {
          organizationName: signInState.organizationName,
          applicationName: null,
          applicationLogoUrl: null,
        },
      },
      configSettled: true,
      enabledMethods: signInState.enabledMethods,
      identifier: 'dana@northwind.com',
      identifierKind: 'email',
      isSignUpFlow: signInState.isSignUpFlow,
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
      otpSentAt: null,
      otpResent: false,
      isSendingOtp: false,
      isVerifyingOtp: false,
      magicLinkSent: false,
      ssoTarget: null,
      isLoading: false,
      passkeySupport: 'yes',
      passkeyConditionalAvailable: true,
      conditionalUiRunning: false,
      error: signInState.error,
      turnstileToken: null,
      turnstileReady: true,
      excludesFederatedEntry: false,
      hostedReturn: '/console',
      guestEntryPending: false,
      tenantSelection: signInState.tenantSelection,
    },
    {
      setIdentifier: vi.fn(),
      setProfileValue: vi.fn(),
      setPassword: vi.fn(),
      setRememberMe: vi.fn(),
      setOtpCode: vi.fn(),
      setTurnstileToken: vi.fn(),
      submitIdentifier: vi.fn(),
      changeIdentifier: vi.fn(),
      chooseMethod: vi.fn(),
      submitPassword: vi.fn(),
      submitMagicLink: vi.fn(),
      requestOtp: vi.fn(),
      verifyOtp: vi.fn(),
      triggerPasskeyButton: vi.fn(),
      triggerEarlierPasskeyButton: vi.fn(),
      submitGuest: vi.fn(),
      handleSocial: vi.fn(),
      selectOrganizationContext: vi.fn(),
    },
  ],
}))

import { Route } from './SignInPage'

const SignInPage = (Route as unknown as { component: () => ReactNode }).component

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

describe('SignInPage', () => {
  beforeEach(() => {
    authState.status = 'authenticated'
    routerState.navigate.mockClear()
    routerState.search = {}
    signInState.step = 'identifier'
    signInState.method = 'password'
    signInState.methods = []
    signInState.enabledMethods = []
    signInState.error = null
    signInState.guestCapability = false
    signInState.isSignUpFlow = false
    signInState.allowUserCreation = true
    signInState.organizationName = 'Northwind'
    signInState.nameField = 'hidden'
    signInState.emailOtpSignUp = false
    signInState.tenantSelection = { continueParam: null, redirect: null, authzRequestId: null }
  })

  it('starts with one identifier field that offers passkeys through autofill', async () => {
    authState.status = 'unauthenticated'
    signInState.enabledMethods = ['passkey', 'password']

    const rendered = await renderPage()

    expect(rendered.text).toContain('Sign in to Northwind')
    expect(rendered.html).toContain('autocomplete="email webauthn"')
    expect(rendered.html.match(/<input/g)).toHaveLength(1)
    expect(rendered.text).not.toContain('Continue with a passkey')
  })

  it('names the organization in the create-account title for sign-up intent', async () => {
    authState.status = 'unauthenticated'
    routerState.search = { intent: 'sign-up' }
    signInState.isSignUpFlow = true
    signInState.enabledMethods = ['password']

    const rendered = await renderPage()

    expect(rendered.text).toContain('Create your Northwind account')
    expect(rendered.text).toContain('Already have an account?')
    expect(rendered.text).not.toContain("Can't sign in?")
  })

  it('uses create-password semantics in the new-account second step', async () => {
    authState.status = 'unauthenticated'
    signInState.isSignUpFlow = true
    signInState.step = 'methods'
    signInState.methods = ['password']
    signInState.enabledMethods = ['password']

    const rendered = await renderPage()

    expect(rendered.text).toContain('Create a password')
    expect(rendered.text).toContain('Choose a password to create your account.')
    expect(rendered.html).toContain('autocomplete="new-password"')
    expect(rendered.text).not.toContain('Forgot password?')
  })

  it('says where the code goes when sign-up asks for no profile fields', async () => {
    authState.status = 'unauthenticated'
    signInState.isSignUpFlow = true
    signInState.emailOtpSignUp = true
    signInState.step = 'methods'
    signInState.method = 'otp-email'
    signInState.methods = ['otp-email']
    signInState.enabledMethods = ['otp-email']

    const rendered = await renderPage()

    expect(rendered.text).toContain("We'll send a 6-digit code to")
    expect(rendered.text).not.toContain('Add your details')
  })

  it('asks for details before sending the code when sign-up renders profile fields', async () => {
    authState.status = 'unauthenticated'
    signInState.isSignUpFlow = true
    signInState.emailOtpSignUp = true
    signInState.nameField = 'required'
    signInState.step = 'methods'
    signInState.method = 'otp-email'
    signInState.methods = ['otp-email']
    signInState.enabledMethods = ['otp-email']

    const rendered = await renderPage()

    expect(rendered.text).toContain(
      "Add your details, and we'll send you a code to confirm it's you.",
    )
    expect(rendered.text).not.toContain("We'll send a 6-digit code to")
  })

  it('echoes the typed identifier with a Change action and offers recovery on the password step', async () => {
    authState.status = 'unauthenticated'
    signInState.step = 'methods'
    signInState.methods = ['otp-email', 'password']
    signInState.enabledMethods = ['otp-email', 'password']

    const rendered = await renderPage()

    expect(rendered.text).toContain('dana@northwind.com')
    expect(rendered.text).toContain('Change')
    expect(rendered.text).toContain('Enter your password')
    expect(rendered.text).toContain('Forgot password?')
    expect(rendered.html).toContain('autocomplete="current-password"')
    expect(rendered.text).toContain('Try another way')
  })

  it('keeps organization and locale context in password recovery navigation', async () => {
    authState.status = 'unauthenticated'
    routerState.search = { organization_id: 'org-1', locale: 'en' }
    signInState.enabledMethods = ['password']

    const rendered = await renderPage()

    expect(rendered.html).toContain(
      'href="/forgot-password?organization_id=org-1&amp;locale=en&amp;login_hint=dana%40northwind.com"',
    )
  })

  it('shows the locked screen without naming why the account cannot sign in', async () => {
    authState.status = 'unauthenticated'
    signInState.error = 'account_locked'

    const rendered = await renderPage()

    expect(rendered.text).toContain("You can't sign in right now")
    expect(rendered.text).toContain('Use a different account')
  })

  it('renders guest entry only when the server config includes the capability', async () => {
    authState.status = 'unauthenticated'
    signInState.guestCapability = true

    expect((await renderPage()).text).toContain('Guest entry')

    signInState.guestCapability = false
    expect((await renderPage()).text).not.toContain('Guest entry')
  })

  it('confirms a verified email above the sign-in form for verified=1', async () => {
    authState.status = 'unauthenticated'
    routerState.search = { verified: '1' }

    const rendered = await renderPage()

    expect(rendered.text).toContain('Your email address is confirmed. Sign in to continue.')
  })

  it('routes an authenticated sign-up session to organization onboarding', async () => {
    routerState.search = { intent: 'sign-up' }

    await renderPage()

    expect(routerState.navigate).toHaveBeenCalledWith('/create-organization', { replace: true })
  })

  it('keeps an explicit invitation continuation ahead of sign-up onboarding', async () => {
    routerState.search = { intent: 'sign-up', continue: '/accept-invitation?token=invite-1' }

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

    expect(rendered.text).toContain('New to Northwind?')
    const switchHref = /href="(\/sign-in\?[^"]*)"/.exec(rendered.html)?.[1]
    const decoded = (switchHref ?? '').replaceAll('&amp;', '&')
    expect(decoded).toContain('intent=application-sign-up')
    expect(decoded).toContain('continue=%2Fconsole')
    expect(decoded).toContain('client_id=client-1')
    expect(decoded).toContain('authz_request_id=authz-1')
    expect(decoded).toContain('login_hint=owner%40example.com')
    expect(decoded).not.toContain('verified=')
    expect(decoded).not.toContain('reauthenticate=')
    expect(decoded).not.toContain('select_account=')
  })

  it('links product sign-in to product sign-up when no application client is present', async () => {
    authState.status = 'unauthenticated'
    routerState.search = { continue: '/console', organization_id: 'org-1' }

    const rendered = await renderPage()

    const switchHref = /href="(\/sign-in\?[^"]*)"/.exec(rendered.html)?.[1]
    const decoded = (switchHref ?? '').replaceAll('&amp;', '&')
    expect(decoded).toContain('intent=sign-up')
    expect(decoded).not.toContain('client_id=')
  })

  it('hides the account creation link when the tenant disables self sign-up', async () => {
    authState.status = 'unauthenticated'
    signInState.allowUserCreation = false
    routerState.search = { continue: '/console' }

    const rendered = await renderPage()

    expect(rendered.text).not.toContain('New to Northwind?')
    expect(rendered.html).not.toContain('intent=sign-up')
  })

  it('links sign-up back to sign-in without an intent param', async () => {
    authState.status = 'unauthenticated'
    signInState.isSignUpFlow = true
    routerState.search = {
      intent: 'sign-up',
      continue: '/console',
      invitation_token: 'invite-1',
      verified: '1',
    }

    const rendered = await renderPage()

    const switchHref = /href="(\/sign-in\?[^"]*)"/.exec(rendered.html)?.[1]
    const decoded = (switchHref ?? '').replaceAll('&amp;', '&')
    expect(decoded).not.toContain('intent=')
    expect(decoded).toContain('continue=%2Fconsole')
    expect(decoded).toContain('invitation_token=invite-1')
    expect(decoded).not.toContain('verified=')
  })
})
