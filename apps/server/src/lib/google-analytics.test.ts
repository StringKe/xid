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
    expect(resolveAnalyticsPageGroup('/')).toBe('marketing')
    expect(resolveAnalyticsPageGroup('/docs/oidc')).toBe('docs')
    expect(resolveAnalyticsPageGroup('/sign-in')).toBe('hosted_auth')
    expect(resolveAnalyticsPageGroup('/console/org/members')).toBe('console')
  })

  it('builds locale-aware canonical URLs', () => {
    expect(buildPublicCanonicalUrl('/docs', 'zh-Hans')).toBe('https://xid.dev/docs?locale=zh-Hans')
    expect(buildPublicCanonicalUrl('/')).toBe('https://xid.dev/')
  })

  it('queues page_view events on dataLayer when gtag is absent', () => {
    Object.defineProperty(globalThis, 'location', {
      value: {
        hostname: 'xid.dev',
        origin: 'https://xid.dev',
        pathname: '/docs',
        search: '',
      },
      configurable: true,
    })

    trackPageView({ pagePath: '/docs', pageTitle: 'Developer docs | XID', locale: 'en' })

    const layer = (globalThis as { dataLayer?: unknown[] }).dataLayer ?? []
    expect(layer).toEqual([
      [
        'event',
        'page_view',
        {
          send_to: 'G-M7Q66DQ8KX',
          page_path: '/docs',
          page_title: 'Developer docs | XID',
          page_location: 'https://xid.dev/docs',
          content_group: 'docs',
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

    trackEvent('cta_click', { cta_id: 'hero_read_docs' })

    expect(calls).toEqual([
      ['event', 'cta_click', { send_to: 'G-M7Q66DQ8KX', cta_id: 'hero_read_docs' }],
    ])
  })
})
