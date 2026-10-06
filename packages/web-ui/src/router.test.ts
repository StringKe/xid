import { describe, expect, it, vi } from 'vitest'
import {
  createRouterAdapter,
  normalizeInternalNavigationTarget,
  type NavigateOptions,
  usesDocumentNavigation,
} from './router'

describe('normalizeInternalNavigationTarget', () => {
  it('keeps local paths and rejects external or scheme-relative targets', () => {
    expect(normalizeInternalNavigationTarget('/console/org?orgId=org_1', '/account')).toBe(
      '/console/org?orgId=org_1',
    )
    expect(normalizeInternalNavigationTarget('?step=next', '/account')).toBe('?step=next')
    expect(normalizeInternalNavigationTarget('https://evil.example/steal', '/account')).toBe(
      '/account',
    )
    expect(normalizeInternalNavigationTarget('//evil.example/steal', '/console')).toBe('/console')
    expect(normalizeInternalNavigationTarget('/\\evil.example/steal', '/console')).toBe('/console')
  })
})

describe('usesDocumentNavigation', () => {
  it('keeps Core SPA routes in TanStack and sends Console routes through the document', () => {
    expect(usesDocumentNavigation('core', '/sign-in', '/account')).toBe(false)
    expect(usesDocumentNavigation('core', '/account/security', '/account')).toBe(false)
    expect(usesDocumentNavigation('core', '/mfa?redirect_to=%2Fauthorize', '/sign-in')).toBe(false)
    expect(usesDocumentNavigation('core', '?step=next', '/sign-in')).toBe(false)
    expect(usesDocumentNavigation('core', '/', '/account')).toBe(true)
    expect(usesDocumentNavigation('core', '/console', '/account')).toBe(true)
    expect(usesDocumentNavigation('core', '/console/org?orgId=org_1', '/account')).toBe(true)
  })

  it('sends Core Worker endpoints through the document from the Core SPA', () => {
    expect(
      usesDocumentNavigation('core', '/authorize?authz_request_id=x&client_id=c', '/mfa'),
    ).toBe(true)
    expect(usesDocumentNavigation('core', '/sso/outbound/saml/app_1/sso', '/sign-in')).toBe(true)
    expect(usesDocumentNavigation('core', '/end_session', '/account')).toBe(true)
    expect(usesDocumentNavigation('core', '/account/typo', '/account')).toBe(true)
  })

  it('keeps Console routes in TanStack and sends Core routes through the document', () => {
    expect(usesDocumentNavigation('console', '/console/org', '/console')).toBe(false)
    expect(usesDocumentNavigation('console', '/sign-in', '/console')).toBe(true)
    expect(usesDocumentNavigation('console', '/mfa?redirect_to=%2Fconsole', '/console')).toBe(true)
    expect(usesDocumentNavigation('console', '/account', '/console')).toBe(true)
  })
})

describe('createRouterAdapter', () => {
  it('dispatches same-runtime and cross-runtime navigation to separate adapters', () => {
    const clientNavigate = vi.fn<(to: string, options?: NavigateOptions) => void>()
    const assign = vi.fn<(url: string) => void>()
    const replace = vi.fn<(url: string) => void>()
    const adapter = createRouterAdapter({
      runtime: 'console',
      clientNavigate,
      getCurrentPathname: () => '/console',
      documentNavigation: { assign, replace },
    })

    adapter.navigate('/console/org')
    adapter.navigate('/sign-in')
    adapter.navigate('/account', { replace: true })

    expect(clientNavigate).toHaveBeenCalledWith('/console/org', undefined)
    expect(assign).toHaveBeenCalledWith('/sign-in')
    expect(replace).toHaveBeenCalledWith('/account')
  })

  it('sends the Nimbus root through document navigation from Core', () => {
    const clientNavigate = vi.fn<(to: string, options?: NavigateOptions) => void>()
    const assign = vi.fn<(url: string) => void>()
    const adapter = createRouterAdapter({
      runtime: 'core',
      clientNavigate,
      getCurrentPathname: () => '/not-found',
      documentNavigation: { assign, replace: vi.fn<(url: string) => void>() },
    })

    adapter.navigate('/')

    expect(assign).toHaveBeenCalledWith('/')
    expect(clientNavigate).not.toHaveBeenCalled()
  })

  it('never passes an external redirect target to document navigation', () => {
    const clientNavigate = vi.fn<(to: string, options?: NavigateOptions) => void>()
    const replace = vi.fn<(url: string) => void>()
    const adapter = createRouterAdapter({
      runtime: 'core',
      clientNavigate,
      getCurrentPathname: () => '/mfa',
      documentNavigation: { assign: vi.fn<(url: string) => void>(), replace },
    })

    adapter.navigate('https://evil.example/steal', { replace: true })

    expect(replace).not.toHaveBeenCalled()
    expect(clientNavigate).toHaveBeenCalledWith('/account', { replace: true })
  })

  it('resumes /authorize with a document replace from the Core SPA', () => {
    const clientNavigate = vi.fn<(to: string, options?: NavigateOptions) => void>()
    const replace = vi.fn<(url: string) => void>()
    const adapter = createRouterAdapter({
      runtime: 'core',
      clientNavigate,
      getCurrentPathname: () => '/mfa',
      documentNavigation: { assign: vi.fn<(url: string) => void>(), replace },
    })

    adapter.navigate('/authorize?authz_request_id=x&client_id=c', { replace: true })

    expect(replace).toHaveBeenCalledWith('/authorize?authz_request_id=x&client_id=c')
    expect(clientNavigate).not.toHaveBeenCalled()
  })
})
