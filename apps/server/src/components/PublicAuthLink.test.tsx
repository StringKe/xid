import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AuthOrg, AuthStatus, AuthUser } from '../lib/auth-context'

const authState = vi.hoisted(
  (): {
    status: AuthStatus
    user: AuthUser | null
    activeOrg: AuthOrg | null
    organizations: readonly AuthOrg[]
  } => ({
    status: 'unauthenticated',
    user: null,
    activeOrg: null,
    organizations: [],
  }),
)

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('../lib/auth-context', () => ({
  useAuth: () => authState,
}))

import { PublicAuthLink } from './PublicAuthLink'

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

describe('PublicAuthLink', () => {
  it('renders the unified console link for instance managers', () => {
    authState.status = 'authenticated'
    authState.user = { ...user, instanceManager: true }
    authState.activeOrg = null
    authState.organizations = []

    const html = renderToStaticMarkup(<PublicAuthLink className="nav-link" />)

    expect(html).toContain('href="/console"')
    expect(html).not.toContain('href="/console/platform"')
    expect(html).toContain('Console')
    expect(html).not.toContain('Sign in')
  })

  it('renders the unified console link for organization users', () => {
    authState.status = 'authenticated'
    authState.user = user
    authState.activeOrg = org
    authState.organizations = [org]

    const html = renderToStaticMarkup(<PublicAuthLink className="nav-link" />)

    expect(html).toContain('href="/console"')
    expect(html).toContain('Console')
    expect(html).not.toContain('Sign in')
  })

  it('renders the unified console link for authenticated users without active organization', () => {
    authState.status = 'authenticated'
    authState.user = user
    authState.activeOrg = null
    authState.organizations = []

    const html = renderToStaticMarkup(<PublicAuthLink className="nav-link" />)

    expect(html).toContain('href="/console"')
    expect(html).toContain('Console')
  })

  it('renders the sign in link for unauthenticated users', () => {
    authState.status = 'unauthenticated'
    authState.user = null
    authState.activeOrg = null
    authState.organizations = []

    const html = renderToStaticMarkup(<PublicAuthLink className="nav-link" />)

    expect(html).toContain('href="/sign-in"')
    expect(html).toContain('Sign in')
  })

  it('does not show a sign in link while auth state is loading', () => {
    authState.status = 'loading'
    authState.user = null
    authState.activeOrg = null
    authState.organizations = []

    const html = renderToStaticMarkup(<PublicAuthLink className="nav-link" />)

    expect(html).toBe('')
    expect(html).not.toContain('Sign in')
  })
})
