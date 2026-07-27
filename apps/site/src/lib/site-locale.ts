import { PUBLIC_DOC_SLUGS, XID_SITE_LOCALES } from '@xid-kit/types'

export const SITE_LOCALES = ['en', ...XID_SITE_LOCALES] as const
export type SiteLocale = (typeof SITE_LOCALES)[number]

export const SITE_LOCALE_LABELS: Readonly<Record<SiteLocale, string>> = {
  en: 'English',
  'zh-Hans': '简体中文',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  'pt-BR': 'Português',
}

const ALL_LOCALES = new Set<string>(SITE_LOCALES)
const PUBLIC_DOC_SLUG_SET = new Set<string>(PUBLIC_DOC_SLUGS)
export const SITE_LOCALE_ROUTE_SEGMENTS: Readonly<Record<SiteLocale, string>> = {
  en: '',
  'zh-Hans': 'zh-hans',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  'pt-BR': 'pt-br',
}

const ROUTE_SEGMENT_LOCALES = new Map<string, SiteLocale>(
  SITE_LOCALES.filter((locale) => locale !== 'en').map((locale) => [
    SITE_LOCALE_ROUTE_SEGMENTS[locale],
    locale,
  ]),
)

function ensureLeadingSlash(pathname: string): string {
  return pathname.startsWith('/') ? pathname : `/${pathname}`
}

export function isSiteLocale(value: string): value is SiteLocale {
  return ALL_LOCALES.has(value)
}

export function resolveSiteLocale(value: string): SiteLocale | null {
  if (isSiteLocale(value)) return value
  return ROUTE_SEGMENT_LOCALES.get(value.toLowerCase()) ?? null
}

export function getSiteLocale(pathname: string): SiteLocale {
  const segment = ensureLeadingSlash(pathname).split('/')[1]?.toLowerCase() ?? ''
  return ROUTE_SEGMENT_LOCALES.get(segment) ?? 'en'
}

export function stripSiteLocale(pathname: string): string {
  const normalized = ensureLeadingSlash(pathname)
  const locale = getSiteLocale(normalized)
  if (locale === 'en') return normalized

  const routeSegment = SITE_LOCALE_ROUTE_SEGMENTS[locale]
  const unprefixed = normalized.slice(routeSegment.length + 1)
  return unprefixed === '' ? '/' : unprefixed
}

export function localizeSitePath(pathname: string, locale: SiteLocale): string {
  const unprefixed = stripSiteLocale(pathname)
  if (locale === 'en') return unprefixed
  const routeSegment = SITE_LOCALE_ROUTE_SEGMENTS[locale]
  return unprefixed === '/' ? `/${routeSegment}` : `/${routeSegment}${unprefixed}`
}

export function getSiteLocaleAlternates(pathname: string): ReadonlyArray<{
  locale: SiteLocale
  href: string
}> {
  return SITE_LOCALES.map((locale) => ({
    locale,
    href: localizeSitePath(pathname, locale),
  }))
}

export function isLocalizableSitePath(pathname: string): boolean {
  const unprefixed = stripSiteLocale(pathname).split(/[?#]/u, 1)[0] ?? '/'
  const normalized = unprefixed.replace(/^\/+|\/+$/gu, '')
  if (normalized === '') return true
  const twinBase = normalized.replace(/(?:^|\/)index\.(?:md|mdx)$/u, '')
  return twinBase === '' || PUBLIC_DOC_SLUG_SET.has(twinBase)
}
