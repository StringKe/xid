import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import NotFoundPage from './NotFoundPage'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join('') }),
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}))

vi.mock('../../components/layout', () => ({
  AuthLayout: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}))

vi.mock('../../components/hosted/use-hosted-auth-config', () => ({
  useHostedAuthConfig: () => ({ config: { context: { organizationName: 'Northwind' } } }),
}))

describe('NotFoundPage', () => {
  it('explains the missing page and offers sign-in and account exits', () => {
    const html = renderToStaticMarkup(<NotFoundPage />)

    expect(html).toContain('404')
    expect(html).toContain('We can&#x27;t find that page')
    expect(html).toContain('Go to Northwind sign-in')
    expect(html).toContain('href="/account"')
    expect(html).not.toContain('href="/"')
  })
})
