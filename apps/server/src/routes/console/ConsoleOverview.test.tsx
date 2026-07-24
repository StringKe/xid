import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
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

vi.mock('../../lib/auth-context', () => ({
  useAuth: () => authState,
}))

vi.mock('../../lib/router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  Navigate: ({ to }: { to: string }) => <span data-navigate-to={to} />,
  useNavigate: () => vi.fn(),
}))

import ConsoleOverview from './ConsoleOverview'

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

describe('ConsoleOverview', () => {
  it('opens the active organization instead of rendering a console overview', () => {
    authState.user = user
    authState.activeOrg = org
    authState.organizations = [org]

    const html = renderToStaticMarkup(<ConsoleOverview />)

    expect(html).toContain('data-navigate-to="/console/org"')
    expect(html).not.toContain('Console overview')
  })

  it('auto-selects the only organization before entering the console', () => {
    authState.user = user
    authState.activeOrg = null
    authState.organizations = [org]

    const html = renderToStaticMarkup(<ConsoleOverview />)

    expect(html).toContain('Opening organization')
  })

  it('does not redirect instance managers to the platform automatically', () => {
    authState.user = { ...user, instanceManager: true }
    authState.activeOrg = org
    authState.organizations = [org]

    const html = renderToStaticMarkup(<ConsoleOverview />)

    expect(html).toContain('data-navigate-to="/console/org"')
    expect(html).not.toContain('/console/platform')
  })

  it('sends members to the account portal instead of the organization console', () => {
    authState.user = user
    authState.activeOrg = { ...org, role: 'member' }
    authState.organizations = [{ ...org, role: 'member' }]

    const html = renderToStaticMarkup(<ConsoleOverview />)

    expect(html).toContain('data-navigate-to="/account"')
    expect(html).not.toContain('data-navigate-to="/console/org"')
  })
})
