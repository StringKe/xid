export const PUBLIC_DOC_SLUGS = [
  'getting-started',
  'hosted-auth',
  'oidc-oauth',
  'enterprise-sso',
  'social-login',
  'management-api',
  'webhooks',
  'branding',
  'scim',
  'saml',
  'sdks',
  'sdks/core',
  'sdks/backend',
  'sdks/react',
  'sdks/nextjs',
  'sdks/react-native',
  'sdks/vue',
  'sdks/nuxt',
  'sdks/svelte',
  'sdks/solid',
  'sdks/angular',
  'sdks/astro',
  'sdks/remix',
  'sdks/expo',
  'sdks/electron',
  'sdks/tauri',
  'sdks/go',
  'sdks/rust',
  'sdks/python',
  'sdks/ruby',
  'sdks/php',
  'sdks/java',
  'sdks/dotnet',
  'sdks/ios',
  'sdks/android',
  'sdks/flutter',
  'sdks/macos',
  'sdks/windows',
  'sdks/linux',
  'self-hosting',
] as const

export type PublicDocSlug = (typeof PUBLIC_DOC_SLUGS)[number]

export const PUBLIC_DOC_ALIASES = {
  '/docs/oidc': 'oidc-oauth',
  '/docs/oauth': 'oidc-oauth',
  '/docs/sso': 'enterprise-sso',
  '/docs/enterprise': 'enterprise-sso',
  '/docs/social': 'social-login',
  '/docs/sdks/web': 'sdks/core',
  '/docs/sdks/core': 'sdks/core',
  '/docs/sdks/backend': 'sdks/backend',
  '/docs/sdks/react': 'sdks/react',
  '/docs/sdks/nextjs': 'sdks/nextjs',
  '/docs/sdks/react-native': 'sdks/react-native',
} as const satisfies Readonly<Record<string, PublicDocSlug>>

export const PUBLIC_DOCS_REGISTRY_SOURCE = 'xid-public-technical-docs-registry'
export const PUBLIC_DOCS_CONTENT_SOURCE = 'apps/site/src/content-source/docs/documents.json'
export const PUBLIC_DOCS_REPOSITORY_DOCS_SERVED = false

export type PublicDocsRouteDecision = {
  pathname: string
  normalizedPath: string
  status: 'public-technical-doc' | 'blocked-non-public-docs-path' | 'not-docs-path'
  slug: PublicDocSlug | null
  registrySource: typeof PUBLIC_DOCS_REGISTRY_SOURCE
  contentSource: typeof PUBLIC_DOCS_CONTENT_SOURCE
  repoDocsMarkdownServed: typeof PUBLIC_DOCS_REPOSITORY_DOCS_SERVED
  internalRepositoryDocsServed: typeof PUBLIC_DOCS_REPOSITORY_DOCS_SERVED
  publicSlugs: typeof PUBLIC_DOC_SLUGS
}

const PUBLIC_DOC_SLUG_SET = new Set<string>(PUBLIC_DOC_SLUGS)
const PUBLIC_DOC_TWIN_SUFFIXES = ['/index.md', '/index.mdx'] as const

function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1
  }
  return value.slice(0, end)
}

export function normalizeDocsPath(pathname: string): string {
  const normalized = trimTrailingSlashes(pathname)
  return normalized || '/'
}

export function isDocsPath(pathname: string): boolean {
  const path = normalizeDocsPath(pathname)
  return path === '/docs' || path.startsWith('/docs/') || isPublicDocsPath(path)
}

function withoutTwinSuffix(pathname: string): string {
  for (const suffix of PUBLIC_DOC_TWIN_SUFFIXES) {
    if (pathname.endsWith(suffix)) return pathname.slice(0, -suffix.length) || '/'
  }
  return pathname
}

function isPublicDocsHubPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/index.md' ||
    pathname === '/index.mdx' ||
    pathname === '/docs' ||
    pathname === '/docs/index.md' ||
    pathname === '/docs/index.mdx'
  )
}

export function resolvePublicDocSlug(pathname: string): PublicDocSlug | null {
  const path = withoutTwinSuffix(normalizeDocsPath(pathname))
  const legacyPath = path.startsWith('/docs/') ? path : `/docs${path}`
  const alias = PUBLIC_DOC_ALIASES[legacyPath as keyof typeof PUBLIC_DOC_ALIASES]
  if (alias) return alias

  const slug = path.startsWith('/docs/') ? path.slice('/docs/'.length) : path.slice(1)
  return PUBLIC_DOC_SLUG_SET.has(slug) ? (slug as PublicDocSlug) : null
}

export function isPublicDocsPath(pathname: string): boolean {
  const path = normalizeDocsPath(pathname)
  return isPublicDocsHubPath(path) || resolvePublicDocSlug(path) !== null
}

export function getPublicDocsRouteDecision(pathname: string): PublicDocsRouteDecision {
  const normalizedPath = normalizeDocsPath(pathname)
  const slug = resolvePublicDocSlug(normalizedPath)
  const status = isPublicDocsPath(normalizedPath)
    ? 'public-technical-doc'
    : normalizedPath === '/docs' || normalizedPath.startsWith('/docs/')
      ? 'blocked-non-public-docs-path'
      : 'not-docs-path'

  return {
    pathname,
    normalizedPath,
    status,
    slug,
    registrySource: PUBLIC_DOCS_REGISTRY_SOURCE,
    contentSource: PUBLIC_DOCS_CONTENT_SOURCE,
    repoDocsMarkdownServed: PUBLIC_DOCS_REPOSITORY_DOCS_SERVED,
    internalRepositoryDocsServed: PUBLIC_DOCS_REPOSITORY_DOCS_SERVED,
    publicSlugs: PUBLIC_DOC_SLUGS,
  }
}
