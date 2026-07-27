import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthOrg } from '@xid-kit/web-ui/session'

const authState = vi.hoisted(
  (): {
    activeOrg: AuthOrg | null
    targetOrgId: string | null
  } => ({
    activeOrg: null,
    targetOrgId: null,
  }),
)

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({ activeOrg: authState.activeOrg }),
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  Navigate: ({ to }: { to: string }) => <span data-navigate-to={to} />,
  useSearchParams: () => [
    { get: (key: string) => (key === 'orgId' ? authState.targetOrgId : null) },
  ],
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

describe('RequireActiveOrganization', () => {
  beforeEach(() => {
    authState.activeOrg = null
    authState.targetOrgId = null
  })

  it('renders children for org managers with the active organization', () => {
    authState.activeOrg = org

    const html = renderToStaticMarkup(
      <RequireActiveOrganization>{children}</RequireActiveOrganization>,
    )

    expect(html).toContain('data-guard-children="ok"')
  })

  it('redirects members to the account portal instead of org selection', () => {
    authState.activeOrg = { ...org, role: 'member' }

    const html = renderToStaticMarkup(
      <RequireActiveOrganization>{children}</RequireActiveOrganization>,
    )

    expect(html).toContain('data-navigate-to="/account"')
    expect(html).not.toContain('data-guard-children')
  })

  it('redirects users without an active organization to org selection', () => {
    const html = renderToStaticMarkup(
      <RequireActiveOrganization>{children}</RequireActiveOrganization>,
    )

    expect(html).toContain('data-navigate-to="/console/organizations"')
  })

  it('redirects managers when the query organization differs from the active one', () => {
    authState.activeOrg = org
    authState.targetOrgId = 'org_other'

    const html = renderToStaticMarkup(
      <RequireActiveOrganization>{children}</RequireActiveOrganization>,
    )

    expect(html).toContain('data-navigate-to="/console/organizations"')
  })

  it('renders children when the query organization matches the active one', () => {
    authState.activeOrg = org
    authState.targetOrgId = org.id

    const html = renderToStaticMarkup(
      <RequireActiveOrganization>{children}</RequireActiveOrganization>,
    )

    expect(html).toContain('data-guard-children="ok"')
  })
})
