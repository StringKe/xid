import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import NotFoundPage from './NotFoundPage'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))

vi.mock('../../components/LanguageSwitcher', () => ({
  LanguageSwitcher: () => <span>Language</span>,
}))

vi.mock('../../components/BrandLogo', () => ({
  BrandLogo: () => <span>XID</span>,
}))

describe('NotFoundPage', () => {
  it('renders 404 copy and navigation exits without redirecting to sign-in only', () => {
    const html = renderToStaticMarkup(<NotFoundPage />)

    expect(html).toContain('404')
    expect(html).toContain('Page not found')
    expect(html).toContain('href="/account"')
    expect(html).toContain('href="/sign-in"')
    expect(html).not.toContain('href="/"')
    expect(html).not.toContain('<button')
  })
})
