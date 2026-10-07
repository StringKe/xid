import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const configState = vi.hoisted(() => ({
  context: {
    organizationName: 'Northwind Logistics' as string | null,
    applicationName: 'Fleet Planner' as string | null,
    applicationLogoUrl: null,
  },
}))

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

vi.mock('../hosted/use-hosted-auth-config', () => ({
  useHostedAuthConfig: () => ({ config: { context: configState.context }, isPending: false }),
}))

vi.mock('../hosted/LanguageMenu', () => ({
  LanguageMenu: () => <select aria-label="Language" />,
}))

vi.mock('../hosted/BrandMark', () => ({
  BrandMark: ({ organizationName }: { organizationName: string | null }) => (
    <span data-brand="">{organizationName ?? 'XID'}</span>
  ),
}))

import { AuthLayout } from './AuthLayout'

describe('AuthLayout', () => {
  beforeEach(() => {
    configState.context.organizationName = 'Northwind Logistics'
    configState.context.applicationName = 'Fleet Planner'
  })

  it('names the application the user continues to in the context panel', () => {
    const html = renderToStaticMarkup(
      <AuthLayout>
        <h1>Sign in</h1>
      </AuthLayout>,
    )

    expect(html).toContain('<aside')
    expect(html).toContain('You are signing in to continue to')
    expect(html).toContain('Fleet Planner')
  })

  it('collapses the context into one line for narrow layouts', () => {
    const html = renderToStaticMarkup(
      <AuthLayout>
        <h1>Sign in</h1>
      </AuthLayout>,
    )

    expect(html).toContain('Continue to Fleet Planner by Northwind Logistics')
  })

  it('shows no application line at the instance root without a client', () => {
    configState.context.organizationName = null
    configState.context.applicationName = null

    const html = renderToStaticMarkup(
      <AuthLayout>
        <h1>Sign in</h1>
      </AuthLayout>,
    )

    expect(html).not.toContain('Continue to')
    expect(html).toContain('your XID account')
  })

  it('uses the page-specific context when one is given', () => {
    const html = renderToStaticMarkup(
      <AuthLayout context={{ lead: 'Connecting a device', title: 'Driver App' }}>
        <h1>Activate</h1>
      </AuthLayout>,
    )

    expect(html).toContain('Connecting a device')
    expect(html).toContain('Driver App')
    expect(html).not.toContain('Fleet Planner')
  })

  it('offers the language menu in both the panel and the narrow top bar', () => {
    const html = renderToStaticMarkup(
      <AuthLayout>
        <h1>Sign in</h1>
      </AuthLayout>,
    )

    expect(html.match(/aria-label="Language"/g)).toHaveLength(2)
  })

  it('renders footer content only when provided', () => {
    const withFooter = renderToStaticMarkup(
      <AuthLayout footer={<p>Back to sign in</p>}>
        <h1>Sign in</h1>
      </AuthLayout>,
    )

    expect(withFooter).toContain('Back to sign in')
  })
})
