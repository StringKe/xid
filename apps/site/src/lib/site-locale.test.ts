import { describe, expect, it } from 'vitest'
import {
  getSiteLocale,
  getSiteLocaleAlternates,
  getSiteLlmsIndexPath,
  getSiteOpenGraphLocale,
  hostedAuthHref,
  isLocalizableSitePath,
  localizeSitePath,
  stripSiteLocale,
} from './site-locale'

describe('site locale paths', () => {
  it.each([
    ['/', 'en'],
    ['/getting-started', 'en'],
    ['/zh-hans/', 'zh-Hans'],
    ['/pt-br/sdks/react', 'pt-BR'],
  ] as const)('resolves %s as %s', (pathname, locale) => {
    expect(getSiteLocale(pathname)).toBe(locale)
  })

  it.each([
    ['/zh-hans/', '/'],
    ['/ja/getting-started', '/getting-started'],
    ['/pt-br/sdks/react', '/sdks/react'],
    ['/sdks/react', '/sdks/react'],
  ] as const)('strips locale from %s', (pathname, expected) => {
    expect(stripSiteLocale(pathname)).toBe(expected)
  })

  it('localizes docs paths without nesting locale prefixes', () => {
    expect(localizeSitePath('/', 'zh-Hans')).toBe('/zh-hans')
    expect(localizeSitePath('/getting-started', 'ja')).toBe('/ja/getting-started')
    expect(localizeSitePath('/fr/sdks/react', 'pt-BR')).toBe('/pt-br/sdks/react')
    expect(localizeSitePath('/ko/getting-started', 'en')).toBe('/getting-started')
  })

  it('returns all eight alternate paths', () => {
    const alternates = getSiteLocaleAlternates('/de/sdks/react')
    expect(alternates).toHaveLength(8)
    expect(alternates[0]).toEqual({ locale: 'en', href: '/sdks/react' })
    expect(alternates.at(-1)).toEqual({
      locale: 'pt-BR',
      href: '/pt-br/sdks/react',
    })
  })

  it('localizes the product status surface across all eight locales', () => {
    const alternates = getSiteLocaleAlternates('/status')
    expect(alternates).toHaveLength(8)
    expect(alternates[0]).toEqual({ locale: 'en', href: '/status' })
    expect(alternates[1]).toEqual({ locale: 'zh-Hans', href: '/zh-hans/status' })
    expect(alternates.at(-1)).toEqual({ locale: 'pt-BR', href: '/pt-br/status' })
  })

  it.each([
    ['en', '/en/llms.txt', 'en_US'],
    ['zh-Hans', '/zh-hans/llms.txt', 'zh_CN'],
    ['pt-BR', '/pt-br/llms.txt', 'pt_BR'],
  ] as const)('maps %s to its agent index and Open Graph locale', (locale, llms, og) => {
    expect(getSiteLlmsIndexPath(locale)).toBe(llms)
    expect(getSiteOpenGraphLocale(locale)).toBe(og)
  })

  it.each([
    ['/', true],
    ['/zh-hans/', true],
    ['/getting-started', true],
    ['/fr/getting-started', true],
    ['/sdks/react/', true],
    ['/fr/sdks/react?source=nav', true],
    ['/index.md', true],
    ['/oidc-oauth/index.mdx', true],
    ['/ja/sdks/react/index.md', true],
    ['/status', true],
    ['/zh-hans/status/index.md', true],
    ['/design', false],
    ['/docs', false],
    ['/favicon.ico', false],
    ['/zh-hans/brand/logo.svg', false],
  ] as const)('classifies %s as localizable=%s', (pathname, expected) => {
    expect(isLocalizableSitePath(pathname)).toBe(expected)
  })
})

describe('hostedAuthHref', () => {
  it('builds Core Hosted Auth sign-in with BCP 47 locale from the docs path', () => {
    const locale = getSiteLocale('/zh-hans/getting-started')
    expect(hostedAuthHref('sign-in', locale)).toBe('/sign-in?locale=zh-Hans')
  })

  it('uses unified sign-up entry with intent and locale', () => {
    const locale = getSiteLocale('/pt-br/sdks/react')
    expect(hostedAuthHref('sign-up', locale)).toBe('/sign-in?intent=sign-up&locale=pt-BR')
  })

  it('keeps English locale explicit for Hosted Auth detectLocale', () => {
    expect(hostedAuthHref('sign-in', 'en')).toBe('/sign-in?locale=en')
    expect(hostedAuthHref('sign-up', 'en')).toBe('/sign-in?intent=sign-up&locale=en')
  })
})
