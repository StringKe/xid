import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@lingui/react/macro', () => ({
  useLingui: () => ({ t: (_strings: TemplateStringsArray, value: string) => `${value} logo` }),
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
