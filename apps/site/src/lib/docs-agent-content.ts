import { renderEntryAsMarkdown } from '@cloudflare/nimbus-docs'
import {
  PUBLIC_DOCS_SITE_ORIGIN,
  getPublicDocPath,
  getPublicDocsAgentIndexPath,
  getPublicDocsIndexedSections,
  getPublicDocsLocaleDescriptor,
  type PublicDocsIndexedDocument,
  type PublicDocsIndexedLocale,
  type PublicDocsIndexedSection,
} from './docs-registry'
import { getStatusSurface, renderStatusCorpus } from './status-surface'

function absoluteUrl(pathname: string, siteOrigin: string): string {
  return new URL(pathname, siteOrigin).href
}

function descriptionSuffix(description: string | undefined): string {
  return description ? ` - ${description}` : ''
}

type PublicDocsCorpusItem = {
  locale: PublicDocsIndexedLocale['locale']
  slug: PublicDocsIndexedDocument['slug'] | null
  item: PublicDocsIndexedLocale['hub']
}

function sectionIndexPath(group: PublicDocsIndexedLocale): string {
  return group.locale === 'en' ? '/en/llms.txt' : group.llmsIndexPath
}

function sectionFullPath(group: PublicDocsIndexedLocale): string {
  return group.locale === 'en' ? '/en/llms-full.txt' : group.llmsFullPath
}

function publishedItems(group: PublicDocsIndexedLocale): readonly PublicDocsCorpusItem[] {
  return [
    { locale: group.locale, slug: null, item: group.hub },
    ...group.documents.map((document) => ({
      locale: group.locale,
      slug: document.slug,
      item: document.item,
    })),
  ]
}

function publishedSectionItems(section: PublicDocsIndexedSection): readonly PublicDocsCorpusItem[] {
  return section.documents.map((document) => ({
    locale: section.locale,
    slug: document.slug,
    item: document.item,
  }))
}

function renderCorpusItem(corpusItem: PublicDocsCorpusItem, siteOrigin: string): readonly string[] {
  const { item, locale, slug } = corpusItem
  const canonicalPath =
    slug === null ? getPublicDocsLocaleDescriptor(locale).docsRoot : getPublicDocPath(locale, slug)
  return [
    `<!-- xid-doc-path: ${canonicalPath} -->`,
    ...(slug ? [`<!-- xid-doc-slug: ${slug} -->`] : []),
    `# ${item.title}`,
    '',
    ...(item.description ? [`> ${item.description}`, ''] : []),
    `Locale: ${locale}`,
    `Canonical: ${absoluteUrl(canonicalPath, siteOrigin)}`,
    `Markdown: ${absoluteUrl(item.markdownUrl, siteOrigin)}`,
    ...(item.sourceUrl ? [`Source: ${absoluteUrl(item.sourceUrl, siteOrigin)}`] : []),
    '',
    renderEntryAsMarkdown(item.entry).trim(),
    '',
  ]
}

export function renderPublicDocsLlmsIndex(
  group: PublicDocsIndexedLocale,
  siteOrigin = PUBLIC_DOCS_SITE_ORIGIN,
  llmsFullPath = sectionFullPath(group),
): string {
  const rootLocale = group.locale === 'en'
  const lines = [
    rootLocale ? '# XID' : `# XID documentation (${group.locale})`,
    '',
    group.hub.description ?? 'XID identity platform documentation.',
    '',
    `- [Homepage](${absoluteUrl(group.docsRoot, siteOrigin)})`,
    `- [Documentation hub](${absoluteUrl(group.hub.markdownUrl, siteOrigin)})${descriptionSuffix(group.hub.description)}`,
    `- [Sitemap](${absoluteUrl('/sitemap.xml', siteOrigin)})`,
    `- [Robots](${absoluteUrl('/robots.txt', siteOrigin)})`,
    `- [Full corpus](${absoluteUrl(llmsFullPath, siteOrigin)})`,
    '',
    '## Pages',
    '',
  ]

  for (const document of group.documents) {
    lines.push(
      `- [${document.item.title}](${absoluteUrl(document.item.markdownUrl, siteOrigin)})${descriptionSuffix(document.item.description)}`,
    )
  }
  const status = getStatusSurface(group.locale)
  lines.push(
    `- [${status.title}](${absoluteUrl(status.markdownPath, siteOrigin)})${descriptionSuffix(status.description)}`,
  )

  const sections = getPublicDocsIndexedSections(group)
  if (sections.length > 0) {
    lines.push('', '## Section indexes', '')
    for (const section of sections) {
      lines.push(
        `- [${section.slug}](${absoluteUrl(section.llmsIndexPath, siteOrigin)}) - ${section.documents.length} published pages`,
      )
    }
  }

  lines.push('')
  return lines.join('\n')
}

export function renderPublicDocsGlobalLlmsIndex(
  groups: readonly PublicDocsIndexedLocale[],
  siteOrigin = PUBLIC_DOCS_SITE_ORIGIN,
): string {
  const lines = [
    '# XID',
    '',
    'XID product and integration documentation across every published locale.',
    '',
    `- [Full corpus](${absoluteUrl('/llms-full.txt', siteOrigin)})`,
    `- [Sitemap](${absoluteUrl('/sitemap.xml', siteOrigin)})`,
    `- [Robots](${absoluteUrl('/robots.txt', siteOrigin)})`,
    '',
    '## Sections',
    '',
  ]

  for (const group of groups) {
    const pageCount = publishedItems(group).length + 1
    lines.push(
      `- [${group.locale}](${absoluteUrl(sectionIndexPath(group), siteOrigin)}) - ${pageCount} published pages`,
    )
  }

  const contentSections = groups.flatMap((group) => getPublicDocsIndexedSections(group))
  if (contentSections.length > 0) {
    lines.push('', '## Content sections', '')
    for (const section of contentSections) {
      lines.push(
        `- [${section.locale}/${section.slug}](${absoluteUrl(section.llmsIndexPath, siteOrigin)}) - ${section.documents.length} published pages`,
      )
    }
  }

  lines.push('', '## Published pages', '')
  for (const group of groups) {
    lines.push(`### ${group.locale}`, '')
    for (const { item } of publishedItems(group)) {
      lines.push(
        `- [${item.title}](${absoluteUrl(item.markdownUrl, siteOrigin)})${descriptionSuffix(item.description)}`,
      )
    }
    const status = getStatusSurface(group.locale)
    lines.push(
      `- [${status.title}](${absoluteUrl(status.markdownPath, siteOrigin)})${descriptionSuffix(status.description)}`,
    )
    lines.push('')
  }

  return `${lines.join('\n').trim()}\n`
}

export function renderPublicDocsSectionLlmsIndex(
  section: PublicDocsIndexedSection,
  siteOrigin = PUBLIC_DOCS_SITE_ORIGIN,
): string {
  const lines = [
    `# XID ${section.slug} documentation (${section.locale})`,
    '',
    `Published ${section.slug} documentation for locale ${section.locale}.`,
    '',
    `- [Section homepage](${absoluteUrl(section.docsRoot, siteOrigin)})`,
    `- [Locale index](${absoluteUrl(getPublicDocsAgentIndexPath(section.locale), siteOrigin)})`,
    `- [Full section corpus](${absoluteUrl(section.llmsFullPath, siteOrigin)})`,
    '',
    '## Pages',
    '',
  ]

  for (const document of section.documents) {
    lines.push(
      `- [${document.item.title}](${absoluteUrl(document.item.markdownUrl, siteOrigin)})${descriptionSuffix(document.item.description)}`,
    )
  }

  return `${lines.join('\n').trim()}\n`
}

export function renderPublicDocsSectionLlmsFull(
  section: PublicDocsIndexedSection,
  siteOrigin = PUBLIC_DOCS_SITE_ORIGIN,
): string {
  const lines = [
    `# XID ${section.slug}: full documentation corpus (${section.locale})`,
    '',
    `- Concise index: ${absoluteUrl(section.llmsIndexPath, siteOrigin)}`,
    `- Locale index: ${absoluteUrl(getPublicDocsAgentIndexPath(section.locale), siteOrigin)}`,
    `- Section homepage: ${absoluteUrl(section.docsRoot, siteOrigin)}`,
    `- Published pages: ${section.documents.length}`,
    '',
  ]

  for (const item of publishedSectionItems(section)) {
    lines.push(...renderCorpusItem(item, siteOrigin))
  }

  return `${lines.join('\n').trim()}\n`
}

export function renderPublicDocsLlmsFull(
  group: PublicDocsIndexedLocale,
  siteOrigin = PUBLIC_DOCS_SITE_ORIGIN,
  llmsIndexPath = sectionIndexPath(group),
): string {
  const lines = [
    `# XID: full public documentation corpus (${group.locale})`,
    '',
    `- Concise index: ${absoluteUrl(llmsIndexPath, siteOrigin)}`,
    `- Documentation hub: ${absoluteUrl(group.docsRoot, siteOrigin)}`,
    `- Published pages: ${publishedItems(group).length + 1}`,
    '',
    '## Canonical aliases',
    '',
  ]

  const aliasPrefix = group.routeSegment === '' ? '' : `/${group.routeSegment}`
  lines.push(
    `- \`${aliasPrefix}/docs/oidc\` -> \`${getPublicDocPath(group.locale, 'oidc-oauth')}\``,
    `- \`${aliasPrefix}/docs/oauth\` -> \`${getPublicDocPath(group.locale, 'oidc-oauth')}\``,
    `- \`${aliasPrefix}/docs/sso\` -> \`${getPublicDocPath(group.locale, 'enterprise-sso')}\``,
    '',
    '## Pages',
    '',
  )

  for (const item of publishedItems(group)) {
    lines.push(...renderCorpusItem(item, siteOrigin))
  }
  lines.push(...renderStatusCorpus(group.locale, siteOrigin))

  return `${lines.join('\n').trim()}\n`
}

export function renderPublicDocsGlobalLlmsFull(
  groups: readonly PublicDocsIndexedLocale[],
  siteOrigin = PUBLIC_DOCS_SITE_ORIGIN,
): string {
  const items = groups
    .flatMap((group) => publishedItems(group))
    .sort((left, right) => left.item.url.localeCompare(right.item.url))
  const lines = [
    '# XID: full public documentation corpus',
    '',
    `Index: ${absoluteUrl('/llms.txt', siteOrigin)}`,
    `Published pages: ${items.length + groups.length}`,
    '',
  ]

  for (const item of items) {
    lines.push(...renderCorpusItem(item, siteOrigin))
  }
  const statusGroups = [...groups].sort((left, right) =>
    getStatusSurface(left.locale).path.localeCompare(getStatusSurface(right.locale).path),
  )
  for (const group of statusGroups) {
    lines.push(...renderStatusCorpus(group.locale, siteOrigin))
  }

  return `${lines.join('\n').trim()}\n`
}
