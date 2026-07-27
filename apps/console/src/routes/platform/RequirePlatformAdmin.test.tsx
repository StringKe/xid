import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AuthUser } from '@xid-kit/web-ui/session'

const authState = vi.hoisted(
  (): {
    status: 'loading' | 'authenticated' | 'unauthenticated'
    user: AuthUser | null
  } => ({
    status: 'loading',
    user: null,
  }),
)

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => authState,
}))

import { RequirePlatformAdmin } from './RequirePlatformAdmin'

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

const children = <span data-platform-content="ok" />

describe('RequirePlatformAdmin', () => {
  beforeEach(() => {
    authState.status = 'loading'
    authState.user = null
  })

  it('does not render protected content while authentication is loading', () => {
    const html = renderToStaticMarkup(<RequirePlatformAdmin>{children}</RequirePlatformAdmin>)

    expect(html).not.toContain('data-platform-content')
    expect(html).not.toContain('Instance Manager access is required')
  })

  it('denies an authenticated user without an instance manager assignment', () => {
    authState.status = 'authenticated'
    authState.user = user

    const html = renderToStaticMarkup(<RequirePlatformAdmin>{children}</RequirePlatformAdmin>)

    expect(html).toContain('Instance Manager access is required')
    expect(html).not.toContain('data-platform-content')
  })

  it('renders protected content for an instance manager', () => {
    authState.status = 'authenticated'
    authState.user = { ...user, instanceManager: true }

    const html = renderToStaticMarkup(<RequirePlatformAdmin>{children}</RequirePlatformAdmin>)

    expect(html).toContain('data-platform-content="ok"')
    expect(html).not.toContain('Instance Manager access is required')
  })
})
