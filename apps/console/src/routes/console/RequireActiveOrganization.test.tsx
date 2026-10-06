import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthOrg } from '@xid-kit/web-ui/session'

const authState = vi.hoisted(
  (): {
    activeOrg: AuthOrg | null
    organizations: readonly AuthOrg[]
    targetOrgId: string | null
  } => ({
    activeOrg: null,
    organizations: [],
    targetOrgId: null,
  }),
)

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({
    activeOrg: authState.activeOrg,
    organizations: authState.organizations,
    setActiveOrganization: async () => true,
  }),
}))

vi.mock('@xid-kit/web-ui/ui', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ConsolePage: ({ title, children }: { title: ReactNode; children: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
  ConsolePageSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  Spinner: ({ label }: { label?: string }) => <span>{label}</span>,
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  Navigate: ({ to }: { to: string }) => <span data-navigate-to={to} />,
  useSearchParams: () => [
    { get: (key: string) => (key === 'orgId' ? authState.targetOrgId : null) },
  ],
}))

vi.mock('./ConsoleEntryRoutes', () => ({
  ORGANIZATION_UNAVAILABLE_NOTICE: 'organization_unavailable',
}))

import { RequireActiveOrganization } from './RequireActiveOrganization'

const org: AuthOrg = {
  id: 'org_1',
  slug: 'default',
  name: 'Default',
  role: 'owner',
  permissions: [],
}

const children = <span data-guard-children="ok" />

function render(): string {
  return renderToStaticMarkup(<RequireActiveOrganization>{children}</RequireActiveOrganization>)
}

describe('RequireActiveOrganization', () => {
  beforeEach(() => {
    authState.activeOrg = null
    authState.organizations = []
    authState.targetOrgId = null
  })

  it('renders children for org managers with the active organization', () => {
    authState.activeOrg = org
    authState.organizations = [org]

    expect(render()).toContain('data-guard-children="ok"')
  })

  it('sends a member active organization to organization selection', () => {
    authState.activeOrg = { ...org, role: 'member' }
    authState.organizations = [{ ...org, role: 'member' }]

    const html = render()

    expect(html).toContain('data-navigate-to="/console/organizations"')
    expect(html).not.toContain('data-guard-children')
  })

  it('redirects users without an active organization to org selection', () => {
    expect(render()).toContain('data-navigate-to="/console/organizations"')
  })

  it('switches to the linked organization when the user manages it', () => {
    const otherOrg: AuthOrg = { ...org, id: 'org_other', slug: 'other' }
    authState.activeOrg = org
    authState.organizations = [org, otherOrg]
    authState.targetOrgId = otherOrg.id

    const html = render()

    expect(html).toContain('Opening organization')
    expect(html).not.toContain('data-navigate-to')
    expect(html).not.toContain('data-guard-children')
  })

  it('reports a linked organization the user cannot manage', () => {
    authState.activeOrg = org
    authState.organizations = [org, { ...org, id: 'org_member', role: 'member' }]
    authState.targetOrgId = 'org_member'

    expect(render()).toContain(
      'data-navigate-to="/console/organizations?notice=organization_unavailable"',
    )
  })

  it('renders children when the query organization matches the active one', () => {
    authState.activeOrg = org
    authState.organizations = [org]
    authState.targetOrgId = org.id

    expect(render()).toContain('data-guard-children="ok"')
  })
})
