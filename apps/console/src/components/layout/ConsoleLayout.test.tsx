// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AuthOrg, AuthUser } from '@xid-kit/web-ui/session'
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
    setActiveOrganization: async () => true,
    signOut: async () => undefined,
    openEmailVerification: authState.openEmailVerification,
  }),
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

vi.mock('@xid-kit/web-ui/ui', () => ({
  Alert: ({ title, children }: { title?: ReactNode; children: ReactNode }) => (
    <div role="status">
      {title}
      {children}
    </div>
  ),
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
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
    authState.user = { ...authState.user, emailVerified: true, instanceManager: false }
    authState.organizations = [authState.activeOrg]
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
    expect(html).not.toContain('isActive')
    expect(html).not.toContain('=&gt;')
    expect(html).not.toContain('e=&gt;')
  })

  it('preserves target organization query across org console navigation', () => {
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

    expect(html).toContain(
      'href="/console/org/auth-policy?orgId=org_1&amp;orgName=Default+Organization"',
    )
    expect(html).toContain(
      'href="/console/org/social-providers?orgId=org_1&amp;orgName=Default+Organization"',
    )
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

  it('uses document links for account aliases owned by the Console Worker', () => {
    const html = renderToStaticMarkup(
      <ConsoleLayout
        navItems={[
          { to: '/console/sessions', label: 'Sessions' },
          { to: '/console/security', label: 'Security' },
          { to: '/console/settings', label: 'Settings' },
        ]}
      >
        <span>Content</span>
      </ConsoleLayout>,
    )

    expect(html).toContain('<a href="/console/sessions"')
    expect(html).toContain('<a href="/console/security"')
    expect(html).not.toContain('href="/console/sessions" data-router-link')
    expect(html).not.toContain('href="/console/security" data-router-link')
    expect(html).toContain('href="/console/settings"')
    expect(html).toContain('data-router-link="true"')
    expect(html.match(/data-router-link="true"/g)).toHaveLength(1)
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
})
