import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  buildPublicCanonicalUrl,
  isAnalyticsEnabled,
  resolveAnalyticsPageGroup,
  trackEvent,
  trackPageView,
} from './google-analytics'

describe('google analytics helpers', () => {
  const originalLocation = globalThis.location

  beforeEach(() => {
    ;(globalThis as { dataLayer?: unknown[] }).dataLayer = []
    delete (globalThis as { gtag?: unknown }).gtag
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'location', {
      value: originalLocation,
      configurable: true,
    })
  })

  it('disables analytics on localhost', () => {
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'localhost', origin: 'http://localhost:5173' },
      configurable: true,
    })
    expect(isAnalyticsEnabled()).toBe(false)
  })

  it('enables analytics on xid.dev', () => {
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'xid.dev', origin: 'https://xid.dev' },
      configurable: true,
    })
    expect(isAnalyticsEnabled()).toBe(true)
  })

  it('maps routes to analytics content groups', () => {
    expect(resolveAnalyticsPageGroup('/sign-in')).toBe('hosted_auth')
    expect(resolveAnalyticsPageGroup('/account/security')).toBe('account')
    expect(resolveAnalyticsPageGroup('/unknown')).toBe('other')
  })

  it('builds Core canonical URLs', () => {
    expect(buildPublicCanonicalUrl('/sign-in')).toBe('https://xid.dev/sign-in')
  })

  it('queues page_view events on dataLayer when gtag is absent', () => {
    Object.defineProperty(globalThis, 'location', {
      value: {
        hostname: 'xid.dev',
        origin: 'https://xid.dev',
        pathname: '/sign-in',
        search: '',
      },
      configurable: true,
    })

    trackPageView({ pagePath: '/sign-in', pageTitle: 'Sign in | XID', locale: 'en' })

    const layer = (globalThis as { dataLayer?: unknown[] }).dataLayer ?? []
    expect(layer).toEqual([
      [
        'event',
        'page_view',
        {
          send_to: 'G-M7Q66DQ8KX',
          page_path: '/sign-in',
          page_title: 'Sign in | XID',
          page_location: 'https://xid.dev/sign-in',
          content_group: 'hosted_auth',
          language: 'en',
        },
      ],
    ])
  })

  it('tracks custom events through gtag when available', () => {
    const calls: unknown[] = []
    ;(globalThis as { gtag: (...args: unknown[]) => void }).gtag = (...args) => {
      calls.push(args)
    }
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'xid.dev', origin: 'https://xid.dev' },
      configurable: true,
    })

    trackEvent('auth_method_selected', { method: 'passkey' })

    expect(calls).toEqual([
      ['event', 'auth_method_selected', { send_to: 'G-M7Q66DQ8KX', method: 'passkey' }],
    ])
  })
})
