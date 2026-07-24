import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AuthOrg, AuthUser } from '../../lib/auth-context'

const authState = vi.hoisted(
  (): {
    user: AuthUser | null
    activeOrg: AuthOrg | null
    organizations: readonly AuthOrg[]
  } => ({
    user: null,
    activeOrg: null,
    organizations: [],
  }),
)

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('../../lib/router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to} data-link-to={to}>
      {children}
    </a>
  ),
  Navigate: ({ to }: { to: string }) => <span data-navigate-to={to} />,
  useNavigate: () => vi.fn(),
}))

vi.mock('../../components/ui', () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  Card: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  PageHeader: ({ title, lead }: { title: ReactNode; lead?: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {lead ? <p>{lead}</p> : null}
    </header>
  ),
  Spinner: ({ label }: { label?: string }) => <span>{label}</span>,
}))

vi.mock('../../lib/auth-context', () => ({
  useAuth: () => ({
    ...authState,
    setActiveOrganization: async () => true,
  }),
}))

import {
  ConsoleHomeEntry,
  ConsoleOrganizationsEntry,
  ConsoleSettingsEntry,
  ConsoleUsersEntry,
  orgSelectionTarget,
} from './ConsoleEntryRoutes'

const user: AuthUser = {
  id: 'user_1',
  email: 'owner@example.com',
  emailVerified: true,
  name: null,
  imageUrl: null,
  locale: null,
  hasMfa: false,
  instanceManager: false,
}

const org: AuthOrg = {
  id: 'org_1',
  slug: 'default',
  name: 'Default',
  role: 'owner',
  permissions: [],
}

describe('Console entry routes', () => {
  beforeEach(() => {
    authState.user = null
    authState.activeOrg = null
    authState.organizations = []
  })

  it('sends instance managers with an active organization to organization routes', () => {
    authState.user = { ...user, instanceManager: true }
    authState.activeOrg = org
    authState.organizations = [org]

    expect(renderToStaticMarkup(<ConsoleUsersEntry />)).toContain(
      'data-navigate-to="/console/org/members"',
    )
    expect(renderToStaticMarkup(<ConsoleOrganizationsEntry />)).toContain(
      'data-navigate-to="/console/org"',
    )
  })

  it('opens the active organization from the console home for instance managers', () => {
    authState.user = { ...user, instanceManager: true }
    authState.activeOrg = org
    authState.organizations = [org]

    expect(renderToStaticMarkup(<ConsoleHomeEntry />)).toContain('data-navigate-to="/console/org"')
  })

  it('sends active organization users to org routes', () => {
    authState.user = user
    authState.activeOrg = org
    authState.organizations = [org]

    expect(renderToStaticMarkup(<ConsoleUsersEntry />)).toContain(
      'data-navigate-to="/console/org/members"',
    )
    expect(renderToStaticMarkup(<ConsoleOrganizationsEntry />)).toContain(
      'data-navigate-to="/console/org"',
    )
  })

  it('shows organization settings as separate sections', () => {
    authState.user = user
    authState.activeOrg = org
    authState.organizations = [org]

    const html = renderToStaticMarkup(<ConsoleSettingsEntry />)

    expect(html).toContain('Settings')
    expect(html).toContain('Auth policy')
    expect(html).toContain('Delivery channels')
    expect(html).toContain('Social providers')
    expect(html).toContain('data-link-to="/console/org/auth-policy"')
    expect(html).toContain('data-link-to="/console/org/delivery-channels"')
    expect(html).toContain('data-link-to="/console/org/social-providers"')
    expect(html).toContain('SCIM targets')
    expect(html).toContain('data-link-to="/console/org/scim-targets"')
    expect(html).toContain('Enterprise SSO inbound')
    expect(html).toContain('data-link-to="/console/org/sso"')
    expect(html).toContain('Enterprise SSO outbound')
    expect(html).toContain('data-link-to="/console/org/outbound-sso"')
    expect(html).not.toContain('data-navigate-to="/console/org/auth-policy"')
  })

  it('shows organization settings for instance managers with active organization', () => {
    authState.user = { ...user, instanceManager: true }
    authState.activeOrg = org
    authState.organizations = [org]

    const html = renderToStaticMarkup(<ConsoleSettingsEntry />)

    expect(html).toContain('Settings')
    expect(html).toContain('Delivery channels')
    expect(html).toContain('Social providers')
    expect(html).toContain('data-link-to="/console/org/delivery-channels"')
    expect(html).toContain('data-link-to="/console/org/social-providers"')
    expect(html).not.toContain('data-navigate-to="/console/platform/flags"')
  })

  it('auto-selects a single organization for instance manager settings without platform redirect', () => {
    authState.user = { ...user, instanceManager: true }
    authState.activeOrg = null
    authState.organizations = [org]

    const html = renderToStaticMarkup(<ConsoleSettingsEntry />)

    expect(html).toContain('Opening organization')
    expect(html).not.toContain('data-navigate-to="/console/platform/flags"')
    expect(html).not.toContain('No organization selected')
  })

  it('auto-selects a single organization instead of showing a dead org page', () => {
    authState.user = user
    authState.activeOrg = null
    authState.organizations = [org]

    const html = renderToStaticMarkup(<ConsoleSettingsEntry />)

    expect(html).toContain('Opening organization')
    expect(html).not.toContain('Select organization')
    expect(html).not.toContain('data-navigate-to="/console/org/auth-policy"')
    expect(html).not.toContain('No organization selected')
  })

  it('builds selected organization targets with a server-validated organization identifier', () => {
    expect(orgSelectionTarget('/console/org', org)).toBe('/console/org?orgId=org_1')
    expect(orgSelectionTarget('/console/org/auth-policy', org)).toBe(
      '/console/org/auth-policy?orgId=org_1',
    )
    expect(orgSelectionTarget('/console/settings', org)).toBe('/console/settings')
  })

  it('shows an empty organization state instead of redirecting to org settings', () => {
    authState.user = user
    authState.activeOrg = null
    authState.organizations = []

    const html = renderToStaticMarkup(<ConsoleSettingsEntry />)

    expect(html).toContain('No organization access')
    expect(html).not.toContain('/console/org')
    expect(html).not.toContain('No organization selected')
  })

  it('sends members with an active organization to the account portal', () => {
    authState.user = user
    authState.activeOrg = { ...org, role: 'member' }
    authState.organizations = [{ ...org, role: 'member' }]

    expect(renderToStaticMarkup(<ConsoleHomeEntry />)).toContain('data-navigate-to="/account"')
    expect(renderToStaticMarkup(<ConsoleUsersEntry />)).toContain('data-navigate-to="/account"')
    expect(renderToStaticMarkup(<ConsoleOrganizationsEntry />)).toContain(
      'data-navigate-to="/account"',
    )
    expect(renderToStaticMarkup(<ConsoleSettingsEntry />)).toContain('data-navigate-to="/account"')
  })

  it('sends member-only users without an active organization to the account portal', () => {
    authState.user = user
    authState.activeOrg = null
    authState.organizations = [{ ...org, role: 'member' }]

    const html = renderToStaticMarkup(<ConsoleHomeEntry />)

    expect(html).toContain('data-navigate-to="/account"')
    expect(html).not.toContain('Opening organization')
  })

  it('auto-selects the only manageable organization for mixed-role users', () => {
    const adminOrg: AuthOrg = { ...org, id: 'org_admin', slug: 'admin', role: 'admin' }
    authState.user = user
    authState.activeOrg = null
    authState.organizations = [{ ...org, role: 'member' }, adminOrg]

    const html = renderToStaticMarkup(<ConsoleHomeEntry />)

    expect(html).toContain('Opening organization')
    expect(html).not.toContain('Select organization')
  })

  it('lists only manageable organizations in the selection', () => {
    const adminOrg: AuthOrg = { ...org, id: 'org_admin', slug: 'admin', name: 'Admin Org' }
    const otherAdminOrg: AuthOrg = { ...org, id: 'org_admin_2', slug: 'ops', name: 'Ops Org' }
    authState.user = user
    authState.activeOrg = null
    authState.organizations = [
      { ...org, role: 'member', name: 'Member Org' },
      adminOrg,
      otherAdminOrg,
    ]

    const html = renderToStaticMarkup(<ConsoleOrganizationsEntry />)

    expect(html).toContain('Select organization')
    expect(html).toContain('Admin Org')
    expect(html).toContain('Ops Org')
    expect(html).not.toContain('Member Org')
  })
})
