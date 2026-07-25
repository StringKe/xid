// 公开技术文档机器可读目录(英文),供 WebMCP 工具与 GEO 测试共用。

import { PUBLIC_DOC_SLUGS } from '../../public-docs'
import { docSeoDescriptionForSlug, docSeoTitleForSlug } from './page-seo-descriptors'

export type PublicDocCatalogEntry = {
  slug: string
  title: string
  description: string | null
  url: string
  category: string
}

const PUBLIC_SITE_ORIGIN = 'https://xid.dev'

const CATEGORY_BY_SLUG: Record<string, string> = {
  'getting-started': 'Getting started',
  'hosted-auth': 'Getting started',
  'oidc-oauth': 'Protocols',
  saml: 'Protocols',
  scim: 'Protocols',
  'enterprise-sso': 'Enterprise identity',
  'social-login': 'Enterprise identity',
  'management-api': 'Developer API',
  webhooks: 'Developer API',
  branding: 'Developer API',
  sdks: 'SDKs',
  'self-hosting': 'Operations',
}

const SLUG_ALIASES: Record<string, string> = {
  oidc: 'oidc-oauth',
  oauth: 'oidc-oauth',
  sso: 'enterprise-sso',
  enterprise: 'enterprise-sso',
  social: 'social-login',
  web: 'sdks/core',
}

function categoryForSlug(slug: string): string {
  if (slug.startsWith('sdks/')) return 'SDK packages'
  return CATEGORY_BY_SLUG[slug] ?? 'Developer documentation'
}

function publicDocUrl(slug: string): string {
  return slug === 'getting-started'
    ? `${PUBLIC_SITE_ORIGIN}/docs`
    : `${PUBLIC_SITE_ORIGIN}/docs/${slug}`
}

function readDescriptorMessage(descriptor: { message?: string } | null | undefined): string | null {
  const message = descriptor?.message
  return typeof message === 'string' && message.length > 0 ? message : null
}

export function normalizePublicDocSlugInput(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\/+|\/+$/gu, '')
  if (!trimmed || trimmed === 'docs') return 'getting-started'

  const withoutPrefix = trimmed.startsWith('docs/') ? trimmed.slice('docs/'.length) : trimmed
  const alias = SLUG_ALIASES[withoutPrefix]
  const slug = alias ?? withoutPrefix

  return (PUBLIC_DOC_SLUGS as readonly string[]).includes(slug) ? slug : null
}

export function buildPublicDocCatalog(): readonly PublicDocCatalogEntry[] {
  return PUBLIC_DOC_SLUGS.map((slug) => {
    const title = readDescriptorMessage(docSeoTitleForSlug(slug)) ?? slug
    const description = readDescriptorMessage(docSeoDescriptionForSlug(slug))
    return {
      slug,
      title,
      description,
      url: publicDocUrl(slug),
      category: categoryForSlug(slug),
    }
  })
}

export function searchPublicDocCatalog(
  catalog: readonly PublicDocCatalogEntry[],
  query: string,
): PublicDocCatalogEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...catalog]

  return catalog.filter((entry) => {
    const haystack = [entry.slug, entry.title, entry.description ?? '', entry.category]
      .join(' ')
      .toLowerCase()
    return haystack.includes(needle)
  })
}
