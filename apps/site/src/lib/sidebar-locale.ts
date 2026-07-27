import type { SidebarItem, SidebarSection } from '@cloudflare/nimbus-docs/types'
import { getSiteLocale, localizeSitePath, SITE_LOCALES, type SiteLocale } from './site-locale'

function normalizePathname(pathname: string): string {
  const normalized = pathname.split(/[?#]/u, 1)[0].replace(/\/+$/u, '')
  return normalized || '/'
}

function localeDocsRoot(pathname: string): string {
  return normalizePathname(localizeSitePath('/', getSiteLocale(pathname)))
}

function isLocaleRoot(href: string | undefined, root: string): boolean {
  return href !== undefined && href.startsWith('/') && normalizePathname(href) === root
}

const NON_ENGLISH_DOC_ROOTS = new Set(
  SITE_LOCALES.filter((locale): locale is Exclude<SiteLocale, 'en'> => locale !== 'en').map(
    (locale) => normalizePathname(localizeSitePath('/', locale)),
  ),
)

function isNonEnglishLocaleGroup(item: SidebarItem): boolean {
  return (
    item.type === 'group' &&
    item.indexHref !== undefined &&
    NON_ENGLISH_DOC_ROOTS.has(normalizePathname(item.indexHref))
  )
}

function findLocaleRootGroups(items: SidebarItem[], root: string): SidebarItem[] {
  return items.flatMap((item) => {
    if (item.type !== 'group') return []
    if (isLocaleRoot(item.indexHref, root)) return [item]
    return findLocaleRootGroups(item.children, root)
  })
}

export function scopeSidebarToSiteLocale(tree: SidebarItem[], pathname: string): SidebarItem[] {
  if (getSiteLocale(pathname) === 'en') {
    return tree.filter((item) => !isNonEnglishLocaleGroup(item))
  }

  const root = localeDocsRoot(pathname)
  const matches = findLocaleRootGroups(tree, root)

  if (matches.length !== 1) {
    throw new TypeError(`expected one sidebar group for ${root}, received ${matches.length}`)
  }

  return matches
}

export function scopeSidebarSectionsToSiteLocale(
  sections: SidebarSection[],
  pathname: string,
): SidebarSection[] {
  if (getSiteLocale(pathname) === 'en') {
    return sections.filter((section) => !NON_ENGLISH_DOC_ROOTS.has(normalizePathname(section.href)))
  }

  const root = localeDocsRoot(pathname)
  return sections.filter((section) => isLocaleRoot(section.href, root))
}
