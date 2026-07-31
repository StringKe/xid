import { siteShellMessages } from './site-shell-messages'
import { translateSiteMessage } from './site-i18n'
import {
  getSiteLlmsIndexPath,
  localizeSitePath,
  SITE_LOCALES,
  SITE_LOCALE_ROUTE_SEGMENTS,
} from './site-locale'
import type { SiteLocale } from './site-locale'

export const STATUS_API_PATH = '/v1/public/status'

export type StatusSurface = {
  locale: SiteLocale
  routeSegment: string
  path: string
  markdownPath: string
  sourcePath: string
  llmsIndexPath: string
  title: string
  description: string
  agentBody: string
  machineReadableLabel: string
}

export function getStatusSurface(locale: SiteLocale): StatusSurface {
  const path = localizeSitePath('/status', locale)
  return {
    locale,
    routeSegment: SITE_LOCALE_ROUTE_SEGMENTS[locale],
    path,
    markdownPath: `${path}/index.md`,
    sourcePath: `${path}/index.mdx`,
    llmsIndexPath: getSiteLlmsIndexPath(locale),
    title: translateSiteMessage(path, siteShellMessages.status),
    description: translateSiteMessage(path, siteShellMessages.statusDescription),
    agentBody: translateSiteMessage(path, siteShellMessages.statusAgentBody),
    machineReadableLabel: translateSiteMessage(path, siteShellMessages.machineReadableStatus),
  }
}

export function getLocalizedStatusStaticPaths(): Array<{
  params: { lang: string }
  props: { locale: SiteLocale }
}> {
  return SITE_LOCALES.filter((locale) => locale !== 'en').map((locale) => ({
    params: { lang: SITE_LOCALE_ROUTE_SEGMENTS[locale] },
    props: { locale },
  }))
}

function absoluteUrl(pathname: string, siteOrigin: string): string {
  return new URL(pathname, siteOrigin).href
}

function frontmatter(surface: StatusSurface, siteOrigin: string): readonly string[] {
  return [
    '---',
    `title: ${JSON.stringify(surface.title)}`,
    `description: ${JSON.stringify(surface.description)}`,
    `locale: ${JSON.stringify(surface.locale)}`,
    `image: ${JSON.stringify(absoluteUrl('/og.png', siteOrigin))}`,
    '---',
  ]
}

export function renderStatusMarkdown(locale: SiteLocale, siteOrigin = 'https://xid.dev'): string {
  const surface = getStatusSurface(locale)
  return [
    ...frontmatter(surface, siteOrigin),
    '',
    '> Documentation Index',
    `> Fetch the relevant documentation index at: ${absoluteUrl(surface.llmsIndexPath, siteOrigin)}`,
    '> Use this file to discover all available pages before exploring further.',
    '',
    `# ${surface.title}`,
    '',
    surface.description,
    '',
    surface.agentBody,
    '',
    `${surface.machineReadableLabel}: ${absoluteUrl(STATUS_API_PATH, siteOrigin)}`,
    '',
    `Source: ${absoluteUrl(surface.sourcePath, siteOrigin)}`,
    '',
  ].join('\n')
}

export function renderStatusMdx(locale: SiteLocale, siteOrigin = 'https://xid.dev'): string {
  const surface = getStatusSurface(locale)
  return [
    ...frontmatter(surface, siteOrigin),
    '',
    `<StatusSurface endpoint=${JSON.stringify(STATUS_API_PATH)} />`,
    '',
  ].join('\n')
}

export function renderStatusCorpus(
  locale: SiteLocale,
  siteOrigin = 'https://xid.dev',
): readonly string[] {
  const surface = getStatusSurface(locale)
  return [
    `<!-- xid-doc-path: ${surface.path} -->`,
    '<!-- xid-doc-slug: status -->',
    `# ${surface.title}`,
    '',
    `> ${surface.description}`,
    '',
    `Locale: ${surface.locale}`,
    `Canonical: ${absoluteUrl(surface.path, siteOrigin)}`,
    `Markdown: ${absoluteUrl(surface.markdownPath, siteOrigin)}`,
    `Source: ${absoluteUrl(surface.sourcePath, siteOrigin)}`,
    '',
    surface.agentBody,
    '',
    `${surface.machineReadableLabel}: ${absoluteUrl(STATUS_API_PATH, siteOrigin)}`,
    '',
  ]
}
