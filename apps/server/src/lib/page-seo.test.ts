import { i18n } from '@lingui/core'
import { describe, expect, it, beforeEach } from 'vitest'
import { messages as enMessages } from '@xid-kit/i18n/locales/en/messages.mjs'
import { applyPageSeo, resolvePageSeo } from './page-seo'

type MetaStub = {
  content: string
  setAttribute: (name: string, value: string) => void
  getAttribute: (name: string) => string | null
}

function seedDocument(): void {
  const metaBySelector = new Map<string, MetaStub>()
  const links: HTMLLinkElement[] = []
  const hreflangLinks: Array<{ remove: () => void }> = []
  const ensureMeta = (selector: string): MetaStub => {
    const existing = metaBySelector.get(selector)
    if (existing) return existing
    const stub: MetaStub = {
      content: '',
      setAttribute(_name, value) {
        this.content = value
      },
      getAttribute(name) {
        return name === 'content' ? this.content : null
      },
    }
    metaBySelector.set(selector, stub)
    return stub
  }

  globalThis.document = {
    title: '',
    head: {
      appendChild(node: HTMLLinkElement) {
        if (node.getAttribute('data-xid-hreflang') === 'true') {
          const tracked = {
            remove: () => {
              const index = hreflangLinks.indexOf(tracked)
              if (index >= 0) hreflangLinks.splice(index, 1)
            },
          }
          hreflangLinks.push(tracked)
          return
        }
        links.push(node)
      },
    },
    createElement(tagName: string) {
      const attrs = new Map<string, string>()
      const element = {
        tagName: tagName.toUpperCase(),
        id: '',
        rel: '',
        href: '',
        setAttribute(name: string, value: string) {
          attrs.set(name, value)
          if (name === 'id') this.id = value
          if (name === 'rel') this.rel = value
        },
        getAttribute(name: string) {
          if (name === 'href') return this.href || attrs.get(name) || null
          if (name === 'id') return this.id || attrs.get(name) || null
          return attrs.get(name) ?? null
        },
      }
      return element as HTMLLinkElement
    },
    querySelector(selector: string) {
      if (selector === 'link#xid-page-canonical') {
        return links.find((link) => link.id === 'xid-page-canonical') ?? null
      }
      return ensureMeta(selector)
    },
    querySelectorAll(selector: string) {
      if (selector === 'link[data-xid-hreflang]') return hreflangLinks
      return []
    },
  } as Document

  Object.defineProperty(globalThis, 'location', {
    value: { pathname: '/', search: '' },
    configurable: true,
  })

  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0)
    return 0
  }) as typeof globalThis.requestAnimationFrame
  globalThis.requestIdleCallback = ((cb: IdleRequestCallback) => {
    cb({ didTimeout: false, timeRemaining: () => 50 })
    return 0
  }) as typeof globalThis.requestIdleCallback
}

describe('resolvePageSeo', () => {
  it('marks every Core-owned UI route as noindex', () => {
    expect(resolvePageSeo('/sign-in').indexable).toBe(false)
    expect(resolvePageSeo('/account/security').indexable).toBe(false)
  })

  it('does not resolve metadata for Site or Console routes', () => {
    const notFoundTitle = resolvePageSeo('/unknown').title
    expect(resolvePageSeo('/').title).toBe(notFoundTitle)
    expect(resolvePageSeo('/docs/scim').title).toBe(notFoundTitle)
    expect(resolvePageSeo('/console/org/outbound-sso').title).toBe(notFoundTitle)
  })
})

describe('page seo i18n titles', () => {
  beforeEach(() => {
    seedDocument()
  })

  it('renders localized document titles from catalog', () => {
    i18n.load('en', enMessages)
    i18n.activate('en')

    applyPageSeo(resolvePageSeo('/sign-in'), i18n, { pathname: '/sign-in', locale: 'en' })
    expect(document.title).toBe('Sign in | XID')
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('')
    expect(document.querySelector('link#xid-page-canonical')?.getAttribute('href')).toBe(
      'https://xid.dev/sign-in',
    )
  })

  it('renders non-English titles when locale is activated', async () => {
    const { messages: zhMessages } = await import('@xid-kit/i18n/locales/zh-Hans/messages.mjs')
    i18n.load('zh-Hans', zhMessages)
    i18n.activate('zh-Hans')

    applyPageSeo(resolvePageSeo('/sign-in'), i18n, { pathname: '/sign-in', locale: 'zh-Hans' })
    expect(document.title).toBe('登录 | XID')
  })
})
