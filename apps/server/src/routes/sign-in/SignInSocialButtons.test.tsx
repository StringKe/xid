import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { SignInSocialButtons } from './SignInSocialButtons'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

const providers = [
  {
    provider: 'github',
    allowLogin: true,
    allowUserCreation: true,
    requireVerifiedEmail: true,
    allowedEmailDomains: [],
    blockedEmailDomains: [],
  },
]

describe('SignInSocialButtons', () => {
  it('disables provider authorization until Turnstile is ready', () => {
    const blocked = renderToStaticMarkup(
      <SignInSocialButtons
        providers={providers}
        onSelect={vi.fn()}
        isLoading={false}
        disabled={true}
      />,
    )
    const ready = renderToStaticMarkup(
      <SignInSocialButtons
        providers={providers}
        onSelect={vi.fn()}
        isLoading={false}
        disabled={false}
      />,
    )

    expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*>.*Continue with GitHub.*<\/button>/)
    expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Continue with GitHub.*<\/button>/)
  })
})
