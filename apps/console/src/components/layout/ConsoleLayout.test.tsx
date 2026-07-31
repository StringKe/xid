// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AuthOrg, AuthSession, AuthUser } from '@xid-kit/web-ui/session'
import { ConsoleLayout } from './ConsoleLayout'

const routeState = vi.hoisted(() => ({
  pathname: '/console/org/social-providers',
  search: '',
}))

const authState = vi.hoisted(
  (): {
    user: AuthUser
    activeOrg: AuthOrg
    organizations: readonly AuthOrg[]
    session: AuthSession | null
    apiPost: ReturnType<typeof vi.fn>
    refresh: ReturnType<typeof vi.fn>
    returnFromImpersonation: ReturnType<typeof vi.fn>
    openEmailVerification: ReturnType<typeof vi.fn>
  } => ({
    user: {
      id: 'user_1',
      email: 'owner@example.com',
      emailVerified: true,
      name: null,
      imageUrl: null,
      locale: null,
      hasMfa: false,
      instanceManager: false,
    },
    activeOrg: {
      id: 'org_1',
      slug: 'default',
      name: 'Default Organization',
      role: 'owner',
      permissions: [],
    },
    organizations: [],
    session: null,
    apiPost: vi.fn(),
    refresh: vi.fn(),
    returnFromImpersonation: vi.fn(),
    openEmailVerification: vi.fn(),
  }),
)

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  Link: ({ to, className, children }: { to: string; className?: string; children: ReactNode }) => (
    <a href={to} className={className} data-router-link="true">
      {children}
    </a>
  ),
  useLocation: () => ({
    pathname: routeState.pathname,
    search: routeState.search,
    hash: '',
    state: undefined,
  }),
  useNavigate: () => vi.fn(),
}))

authState.organizations = [authState.activeOrg]

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: authState.user,
    activeOrg: authState.activeOrg,
    organizations: authState.organizations,
    managerAssignments: [],
    session: authState.session,
    api: { post: authState.apiPost },
    refresh: authState.refresh,
    setActiveOrganization: async () => true,
    signOut: async () => undefined,
    openEmailVerification: authState.openEmailVerification,
  }),
  isGuestUser: (user: { provisioned_by?: string } | null | undefined) =>
    user?.provisioned_by === 'anonymous',
}))

vi.mock('../../lib/impersonation-handoff', () => ({
  returnFromImpersonation: authState.returnFromImpersonation,
}))

vi.mock('@xid-kit/web-ui/theme', () => ({
  useTheme: () => ({ brand: { appName: 'XID' } }),
}))

vi.mock('@xid-kit/web-ui/display-names', () => ({
  organizationDisplayName: () => 'Default organization',
}))

vi.mock('@xid-kit/web-ui/BrandLogo', () => ({
  BrandLogo: () => <span>XID</span>,
}))

vi.mock('../LanguageSwitcher', () => ({
  LanguageSwitcher: () => <span>Language</span>,
}))

vi.mock('../ActiveAnnouncementsBanner', () => ({
  ActiveAnnouncementsBanner: ({ enabled }: { enabled: boolean }) => (
    <span data-active-announcements={String(enabled)}>Announcements</span>
  ),
}))

vi.mock('@xid-kit/web-ui/ui', () => ({
  Alert: ({ title, children }: { title?: ReactNode; children: ReactNode }) => (
    <div role="status">
      {title}
      {children}
    </div>
  ),
  Button: ({
    children,
    disabled,
    isLoading,
    onClick,
  }: {
    children: ReactNode
    disabled?: boolean
    isLoading?: boolean
    onClick?: () => void
  }) => (
    <button type="button" disabled={disabled || isLoading} onClick={onClick}>
      {children}
    </button>
  ),
  Spinner: () => <span>Loading</span>,
}))

// 捕获 motion 组件 props:layoutId 是共享指示条的契约,SSR 输出无可断言标记。
vi.mock('@xid-kit/web-ui/motion', () => ({
  motion: {
    span: ({
      layoutId,
      children,
      className,
    }: {
      layoutId?: string
      children?: ReactNode
      className?: string
    }): ReactNode => (
      <span data-layout-id={layoutId} className={className}>
        {children}
      </span>
    ),
  },
  springDefault: {},
}))

describe('ConsoleLayout', () => {
  beforeEach(() => {
    authState.user = {
      ...authState.user,
      emailVerified: true,
      instanceManager: false,
      provisioned_by: null,
    }
    authState.organizations = [authState.activeOrg]
    authState.session = null
    authState.apiPost.mockReset()
    authState.refresh.mockReset()
    authState.returnFromImpersonation.mockReset()
    authState.openEmailVerification.mockClear()
  })

  it('renders navigation classes as strings instead of function source', () => {
    routeState.search = ''
    const html = renderToStaticMarkup(
      <ConsoleLayout
        navItems={[
          { to: '/console/org', label: 'Overview', end: true },
          { to: '/console/org/social-providers', label: 'Social providers' },
        ]}
      >
        <span>Content</span>
      </ConsoleLayout>,
    )

    expect(html).toContain('Social providers')
    expect(html).toContain('Default organization')
    expect(html).toContain('data-active-announcements="true"')
    expect(html).not.toContain('isActive')
    expect(html).not.toContain('=&gt;')
    expect(html).not.toContain('e=&gt;')
  })

  it('carries only the orgId parameter across org console navigation', () => {
    routeState.search = '?orgId=org_1&orgName=Default+Organization'
    const html = renderToStaticMarkup(
      <ConsoleLayout
        navItems={[
          { to: '/console/org', label: 'Overview', end: true },
          { to: '/console/org/auth-policy', label: 'Auth policy' },
          { to: '/console/org/social-providers', label: 'Social providers' },
        ]}
      >
        <span>Content</span>
      </ConsoleLayout>,
    )

    expect(html).toContain('href="/console/org/auth-policy?orgId=org_1"')
    expect(html).toContain('href="/console/org/social-providers?orgId=org_1"')
    expect(html).not.toContain('orgName=')
  })

  it('renders the organization switcher and hides the platform menu from organization users', () => {
    const html = renderToStaticMarkup(
      <ConsoleLayout navItems={[{ to: '/console/org', label: 'Overview', end: true }]}>
        <span>Content</span>
      </ConsoleLayout>,
    )

    expect(html).toContain('aria-label="Switch organization"')
    expect(html).toContain('Default organization')
    expect(html).not.toContain('Platform management')
  })

  it('renders the platform menu for instance managers', () => {
    authState.user = { ...authState.user, instanceManager: true }

    const html = renderToStaticMarkup(
      <ConsoleLayout navItems={[{ to: '/console/org', label: 'Overview', end: true }]}>
        <span>Content</span>
      </ConsoleLayout>,
    )

    expect(html).toContain('href="/console/platform"')
    expect(html).toContain('Platform management')
  })

  it('shows a back link instead of the platform menu inside the platform area', () => {
    authState.user = { ...authState.user, instanceManager: true }

    const html = renderToStaticMarkup(
      <ConsoleLayout
        navItems={[
          { to: '/console/platform', label: 'Overview', end: true },
          { to: '/console/platform/users', label: 'Users' },
        ]}
      >
        <span>Content</span>
      </ConsoleLayout>,
    )

    expect(html).toContain('Back to console')
    expect(html).not.toContain('Platform management')
  })

  it('shows the guest band for guest users instead of the read-only notice', () => {
    authState.user = { ...authState.user, emailVerified: false, provisioned_by: 'anonymous' }

    const html = renderToStaticMarkup(
      <ConsoleLayout navItems={[{ to: '/console/org', label: 'Overview', end: true }]}>
        <span>Content</span>
      </ConsoleLayout>,
    )

    expect(html).toContain('Guest account')
    expect(html).not.toContain('Console is read-only')
  })

  it('renders a document link to the account portal in the user area', () => {
    const html = renderToStaticMarkup(
      <ConsoleLayout navItems={[{ to: '/console/settings', label: 'Settings' }]}>
        <span>Content</span>
      </ConsoleLayout>,
    )

    expect(html).toContain('<a href="/account"')
    expect(html).toContain('Account settings')
  })

  it('renders layoutId indicators on the active nav item only', () => {
    routeState.pathname = '/console/org/social-providers'
    const html = renderToStaticMarkup(
      <ConsoleLayout
        navItems={[
          { to: '/console/org', label: 'Overview', end: true },
          { to: '/console/org/social-providers', label: 'Social providers' },
        ]}
      >
        <span>Content</span>
      </ConsoleLayout>,
    )

    expect(html).toContain('data-layout-id="console-nav-rail"')
    expect(html).toContain('data-layout-id="console-nav-tab"')
    expect(html.match(/data-layout-id=/g)).toHaveLength(2)
  })

  it('shows the global read-only notice and opens email verification', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    authState.user = { ...authState.user, emailVerified: false }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <ConsoleLayout navItems={[{ to: '/console/org', label: 'Overview', end: true }]}>
          <span>Content</span>
        </ConsoleLayout>,
      )
    })

    expect(container.textContent).toContain('Console is read-only')
    expect(container.textContent).toContain('owner@example.com')
    const verifyButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Verify email',
    )
    if (!verifyButton) throw new Error('Verify email button was not rendered')

    await act(async () => {
      verifyButton.click()
    })
    expect(authState.openEmailVerification).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    container.remove()
  })

  it('shows a global impersonation banner, pins the organization, and ends the session', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    authState.session = {
      id: 'session_impersonation',
      status: 'active',
      expiresAt: '2026-07-28T00:15:00.000Z',
      isImpersonation: true,
      userId: 'user_target',
      activeOrganizationId: 'org_1',
      lastActiveAt: '2026-07-28T00:00:00.000Z',
    }
    authState.user = { ...authState.user, emailVerified: false }
    authState.apiPost.mockResolvedValue({
      ok: true,
      value: { ok: true, redirectUrl: 'https://xid.dev/console/platform/users' },
    })
    authState.refresh.mockResolvedValue(undefined)
    authState.returnFromImpersonation.mockReturnValue(true)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <ConsoleLayout navItems={[{ to: '/console/org', label: 'Overview', end: true }]}>
          <span>Content</span>
        </ConsoleLayout>,
      )
    })

    expect(container.textContent).toContain('Impersonation session')
    expect(container.textContent).toContain('Management changes are disabled.')
    expect(container.textContent).not.toContain('Verify email')
    expect(container.querySelector('select')?.disabled).toBe(true)
    const endButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'End impersonation',
    )
    if (!endButton) throw new Error('End impersonation button was not rendered')

    await act(async () => {
      endButton.click()
    })

    expect(authState.apiPost).toHaveBeenCalledWith('/auth/impersonation/end')
    expect(authState.returnFromImpersonation).toHaveBeenCalledWith(
      'https://xid.dev/console/platform/users',
    )
    expect(authState.refresh).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    container.remove()
  })
})
