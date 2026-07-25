import { trimTrailingSlashes } from './shared/url'

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
  // TS 包详情页(packages/*)
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
  // 原生服务端 SDK 详情页(sdk/*)
  'sdks/go',
  'sdks/rust',
  'sdks/python',
  'sdks/ruby',
  'sdks/php',
  'sdks/java',
  'sdks/dotnet',
  // 原生客户端 SDK 详情页(sdk/*)
  'sdks/ios',
  'sdks/android',
  'sdks/flutter',
  'sdks/macos',
  'sdks/windows',
  'sdks/linux',
  'self-hosting',
] as const

export const PUBLIC_DOCS_REGISTRY_SOURCE = 'xid-public-technical-docs-registry'
export const PUBLIC_DOCS_CONTENT_SOURCE = 'apps/server/src/routes/docs/index.tsx'
export const PUBLIC_DOCS_REPOSITORY_DOCS_SERVED = false

export type PublicDocsRouteDecision = {
  pathname: string
  normalizedPath: string
  status: 'public-technical-doc' | 'blocked-non-public-docs-path' | 'not-docs-path'
  slug: string | null
  registrySource: typeof PUBLIC_DOCS_REGISTRY_SOURCE
  contentSource: typeof PUBLIC_DOCS_CONTENT_SOURCE
  repoDocsMarkdownServed: typeof PUBLIC_DOCS_REPOSITORY_DOCS_SERVED
  internalRepositoryDocsServed: typeof PUBLIC_DOCS_REPOSITORY_DOCS_SERVED
  publicSlugs: typeof PUBLIC_DOC_SLUGS
}

const PUBLIC_DOC_SLUG_SET = new Set<string>(PUBLIC_DOC_SLUGS)

const PUBLIC_DOC_ALIASES = new Map<string, string>([
  ['/docs', 'getting-started'],
  ['/docs/oidc', 'oidc-oauth'],
  ['/docs/oauth', 'oidc-oauth'],
  ['/docs/sso', 'enterprise-sso'],
  ['/docs/enterprise', 'enterprise-sso'],
  ['/docs/social', 'social-login'],
  ['/docs/sdks/web', 'sdks/core'],
  ['/docs/sdks/core', 'sdks/core'],
  ['/docs/sdks/backend', 'sdks/backend'],
  ['/docs/sdks/react', 'sdks/react'],
  ['/docs/sdks/nextjs', 'sdks/nextjs'],
  ['/docs/sdks/react-native', 'sdks/react-native'],
])

export function normalizeDocsPath(pathname: string): string {
  const normalized = trimTrailingSlashes(pathname)
  return normalized || '/docs'
}

export function isDocsPath(pathname: string): boolean {
  const path = normalizeDocsPath(pathname)
  return path === '/docs' || path.startsWith('/docs/')
}

export function resolvePublicDocSlug(pathname: string): string | null {
  const path = normalizeDocsPath(pathname)
  const alias = PUBLIC_DOC_ALIASES.get(path)
  if (alias) return alias

  const prefix = '/docs/'
  if (!path.startsWith(prefix)) return null

  const slug = path.slice(prefix.length)
  return PUBLIC_DOC_SLUG_SET.has(slug) ? slug : null
}

export function isPublicDocsPath(pathname: string): boolean {
  return resolvePublicDocSlug(pathname) !== null
}

export function getPublicDocsRouteDecision(pathname: string): PublicDocsRouteDecision {
  const normalizedPath = normalizeDocsPath(pathname)
  const slug = resolvePublicDocSlug(normalizedPath)
  const status = !isDocsPath(normalizedPath)
    ? 'not-docs-path'
    : slug
      ? 'public-technical-doc'
      : 'blocked-non-public-docs-path'

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
