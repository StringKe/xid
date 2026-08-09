import type { SidebarItem, SidebarSection } from '@cloudflare/nimbus-docs/types'
import { getSiteLocale, localizeSitePath, SITE_LOCALES, type SiteLocale } from './site-locale'

function normalizePathname(pathname: string): string {
  const normalized = pathname.split(/[?#]/u, 1)[0].replace(/\/+$/u, '')
  return normalized || '/'
}

function localeDocsRoot(pathname: string): string {
  return normalizePathname(localizeSitePath('/docs', getSiteLocale(pathname)))
}

function isLocaleRoute(href: string | undefined, root: string): boolean {
  return href !== undefined && href.startsWith('/') && normalizePathname(href) === root
}

const NON_ENGLISH_DOC_ROOTS = new Set(
  SITE_LOCALES.filter((locale): locale is Exclude<SiteLocale, 'en'> => locale !== 'en').map(
    (locale) => normalizePathname(localizeSitePath('/docs', locale)),
  ),
)

function itemContainsRoute(item: SidebarItem, root: string): boolean {
  if (item.type === 'link') return isLocaleRoute(item.href, root)
  if (item.type !== 'group') return false
  return (
    isLocaleRoute(item.indexHref, root) ||
    item.children.some((child) => itemContainsRoute(child, root))
  )
}

function isNonEnglishLocaleGroup(item: SidebarItem): boolean {
  return (
    item.type === 'group' &&
    [...NON_ENGLISH_DOC_ROOTS].some((root) => itemContainsRoute(item, root))
  )
}

export function scopeSidebarToSiteLocale(tree: SidebarItem[], pathname: string): SidebarItem[] {
  if (getSiteLocale(pathname) === 'en') {
    return tree.filter((item) => !isNonEnglishLocaleGroup(item))
  }

  const root = localeDocsRoot(pathname)
  const matches = tree.filter(
    (item): item is Extract<SidebarItem, { type: 'group' }> =>
      item.type === 'group' && itemContainsRoute(item, root),
  )

  if (matches.length !== 1) {
    throw new TypeError(`expected one sidebar group for ${root}, received ${matches.length}`)
  }

  return matches[0].children
}

export function scopeSidebarSectionsToSiteLocale(
  sections: SidebarSection[],
  pathname: string,
): SidebarSection[] {
  if (getSiteLocale(pathname) === 'en') {
    return sections.filter((section) => !NON_ENGLISH_DOC_ROOTS.has(normalizePathname(section.href)))
  }

  const root = localeDocsRoot(pathname)
  return sections.filter((section) => isLocaleRoute(section.href, root))
}
