import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AppRecord } from './app-api'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@lingui/core/macro', () => ({
  msg: (strings: TemplateStringsArray) => ({ id: strings.join(''), message: strings.join('') }),
}))

vi.mock('@xid-kit/web-ui/api-error-message', () => ({
  useManagementErrorMessage: () => (error: { code: string } | null | undefined) => error?.code,
  errorTargetsField: () => false,
}))

vi.mock('./app-api', () => ({
  appKind: (app: AppRecord) => (app.client_type === 'public' ? 'spa' : 'web'),
  useUpdateApplication: () => ({ error: null, isPending: false, mutate: () => undefined }),
}))

import { redirectProblem } from './app-protocol-sections'
import { CredentialsSection } from './app-sections'

function app(overrides: Partial<AppRecord>): AppRecord {
  return {
    id: 'app_1',
    name: 'Billing',
    client_id: 'client_1',
    client_type: 'confidential',
    token_endpoint_auth_method: 'client_secret_basic',
    redirect_uris: [],
    post_logout_redirect_uris: [],
    allowed_grant_types: ['authorization_code'],
    allowed_response_types: ['code'],
    allowed_scopes: ['openid'],
    ...overrides,
  } as AppRecord
}

describe('CredentialsSection', () => {
  it('offers secret rotation for an app that authenticates with a shared secret', () => {
    const html = renderToStaticMarkup(
      <CredentialsSection app={app({})} onRotate={() => undefined} />,
    )

    expect(html).toContain('Rotate secret')
  })

  it('does not offer secret rotation for a public PKCE client', () => {
    const html = renderToStaticMarkup(
      <CredentialsSection
        app={app({ client_type: 'public', token_endpoint_auth_method: 'none' })}
        onRotate={() => undefined}
      />,
    )

    expect(html).not.toContain('Rotate secret')
    expect(html).toContain('client_1')
  })
})

describe('redirectProblem', () => {
  it('rejects wildcards and fragments for every application type', () => {
    expect(redirectProblem('https://*.example.com/cb', false)).toBe('wildcard')
    expect(redirectProblem('com.example.app:/cb#x', true)).toBe('fragment')
  })

  it('requires https for web apps but allows loopback and custom schemes for native apps', () => {
    expect(redirectProblem('http://localhost:3000/cb', false)).toBe('not_https')
    expect(redirectProblem('http://127.0.0.1:3000/cb', true)).toBeNull()
    expect(redirectProblem('https://app.example.com/cb', false)).toBeNull()
  })

  it('ignores blank rows', () => {
    expect(redirectProblem('   ', false)).toBeNull()
  })
})
