import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { AccountLayout } from './AccountLayout'

const routeState = vi.hoisted(() => ({
  pathname: '/account/security',
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('../../lib/router', () => ({
  Link: ({ to, className, children }: { to: string; className?: string; children: ReactNode }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useLocation: () => ({
    pathname: routeState.pathname,
    search: '',
    hash: '',
    state: undefined,
  }),
}))

vi.mock('../../components/LanguageSwitcher', () => ({
  LanguageSwitcher: () => <span>Language</span>,
}))

vi.mock('../../lib/default-landing', () => ({
  useDefaultLandingPath: () => '/console',
}))

vi.mock('../../lib/theme', () => ({
  useTheme: () => ({
    brand: { appName: 'XID', logoUrl: null },
  }),
}))

type TestOrganization = { id: string; slug: string; name: string; role: 'owner' | 'member' }

const authState = vi.hoisted(() => ({
  user: null as { id: string; email: string; instanceManager?: boolean } | null,
  organizations: [] as TestOrganization[],
}))

vi.mock('../../lib/auth-context', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/auth-context')>()
  return {
    ...original,
    useAuth: () => ({
      user: authState.user,
      organizations: authState.organizations,
      managerAssignments: [],
      signOut: async () => {},
    }),
  }
})

const ownerOrg: TestOrganization = { id: 'org_1', slug: 'acme', name: 'Acme', role: 'owner' }
const memberOrg: TestOrganization = { id: 'org_2', slug: 'beta', name: 'Beta', role: 'member' }

function renderSignedIn(organizations: TestOrganization[]): string {
  authState.user = { id: 'user_1', email: 'ada@example.com' }
  authState.organizations = organizations
  try {
    return renderToStaticMarkup(
      <AccountLayout>
        <span>Content</span>
      </AccountLayout>,
    )
  } finally {
    authState.user = null
    authState.organizations = []
  }
}

describe('AccountLayout', () => {
  it('renders navigation classes as strings instead of function source', () => {
    const html = renderToStaticMarkup(
      <AccountLayout>
        <span>Content</span>
      </AccountLayout>,
    )

    expect(html).toContain('Security')
    expect(html).not.toContain('isActive')
    expect(html).not.toContain('=&gt;')
    expect(html).not.toContain('e=&gt;')
  })

  it('shows identity, console link, and sign out for an organization manager', () => {
    const html = renderSignedIn([ownerOrg])

    expect(html).toContain('ada@example.com')
    expect(html).toContain('href="/console"')
    expect(html).toContain('Sign out')
  })

  it('hides the console link from members without a management role', () => {
    const html = renderSignedIn([memberOrg])

    expect(html).not.toContain('href="/console"')
    expect(html).not.toContain('Switch organization')
  })

  it('offers organization switching when the user belongs to several organizations', () => {
    const html = renderSignedIn([memberOrg, ownerOrg])

    expect(html).toContain('href="/select-organization?redirect_to=%2Faccount"')
  })

  it('hides identity actions when signed out', () => {
    const html = renderToStaticMarkup(
      <AccountLayout>
        <span>Content</span>
      </AccountLayout>,
    )

    expect(html).not.toContain('Sign out')
    expect(html).not.toContain('href="/console"')
  })
})
