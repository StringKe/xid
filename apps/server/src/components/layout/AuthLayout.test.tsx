import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// vitest 不走 lingui 编译,Trans 直出 children,t 还原模板拼接。
vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce(
        (acc, part, index) => acc + (index > 0 ? String(values[index - 1]) : '') + part,
        '',
      ),
  }),
}))

vi.mock('../../lib/theme', () => ({
  useTheme: () => ({
    brand: {
      appName: 'XID',
      logoUrl: null,
    },
  }),
}))

vi.mock('../LanguageSwitcher', () => ({
  LanguageSwitcher: () => <select aria-label="Language" />,
}))

import { AuthLayout } from './AuthLayout'

describe('AuthLayout', () => {
  it('renders the language switcher above the auth card', () => {
    const html = renderToStaticMarkup(
      <AuthLayout>
        <h1>Sign in</h1>
      </AuthLayout>,
    )

    expect(html.indexOf('aria-label="Language"')).toBeGreaterThan(-1)
    expect(html.indexOf('aria-label="Language"')).toBeLessThan(html.indexOf('<section'))
  })

  it('renders the brand panel tagline', () => {
    const html = renderToStaticMarkup(
      <AuthLayout>
        <h1>Sign in</h1>
      </AuthLayout>,
    )

    expect(html).toContain('<aside')
    expect(html).toContain('One XID account. Every application.')
  })

  it('does not render an empty footer without footer content', () => {
    const html = renderToStaticMarkup(
      <AuthLayout>
        <h1>Sign in</h1>
      </AuthLayout>,
    )

    expect(html).not.toContain('<footer')
  })

  it('renders footer content when provided', () => {
    const html = renderToStaticMarkup(
      <AuthLayout footer={<p>Policy text</p>}>
        <h1>Sign in</h1>
      </AuthLayout>,
    )

    expect(html).toContain('<footer')
    expect(html).toContain('Policy text')
  })
})
