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

vi.mock('../../lib/theme', () => ({
  useTheme: () => ({
    brand: { appName: 'XID', logoUrl: null },
  }),
}))

const authState = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
}))

vi.mock('../../lib/auth-context', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/auth-context')>()
  return {
    ...original,
    useAuth: () => ({
      user: authState.user,
      signOut: async () => {},
    }),
  }
})

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

  it('shows identity, console link, and sign out for a signed-in user', () => {
    authState.user = { id: 'user_1', email: 'ada@example.com' }
    try {
      const html = renderToStaticMarkup(
        <AccountLayout>
          <span>Content</span>
        </AccountLayout>,
      )

      expect(html).toContain('ada@example.com')
      expect(html).toContain('href="/console"')
      expect(html).toContain('Sign out')
    } finally {
      authState.user = null
    }
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
