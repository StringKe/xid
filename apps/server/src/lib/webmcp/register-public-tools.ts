import {
  buildPublicDocCatalog,
  normalizePublicDocSlugInput,
  searchPublicDocCatalog,
} from '../public-docs-catalog'
import type { WebMcpToolDefinition } from './types'

export type RegisterPublicWebMcpToolsOptions = {
  navigate: (to: string) => void
  getPathname?: () => string
  getPageTitle?: () => string
}

const PUBLIC_DOC_CATALOG = buildPublicDocCatalog()

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function readStringProperty(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' ? value : null
}

export function createPublicWebMcpTools(
  options: RegisterPublicWebMcpToolsOptions,
): WebMcpToolDefinition[] {
  const getPathname = options.getPathname ?? (() => location.pathname)
  const getPageTitle = options.getPageTitle ?? (() => document.title)

  return [
    {
      name: 'list_public_docs',
      description:
        'List every published XID developer documentation page with slug, title, description, category, and canonical URL.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => jsonResult({ docs: PUBLIC_DOC_CATALOG }),
    },
    {
      name: 'get_public_doc',
      description:
        'Return metadata for one published documentation slug. Accepts slug values such as getting-started, oidc-oauth, sdks/react, or aliases like oidc and sso.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            description: 'Documentation slug or alias (for example oidc-oauth or sdks/backend).',
          },
        },
        required: ['slug'],
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const rawSlug = readStringProperty(input, 'slug')
        if (!rawSlug) return jsonResult({ error: 'slug is required' })

        const slug = normalizePublicDocSlugInput(rawSlug)
        if (!slug)
          return jsonResult({ error: 'unknown or unpublished documentation slug', slug: rawSlug })

        const doc = PUBLIC_DOC_CATALOG.find((entry) => entry.slug === slug)
        return jsonResult({ doc })
      },
    },
    {
      name: 'search_public_docs',
      description:
        'Search published XID developer documentation by keyword across slug, title, description, and category.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Case-insensitive keyword, for example "SCIM", "webhook", or "React SDK".',
          },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const query = readStringProperty(input, 'query')
        if (!query) return jsonResult({ error: 'query is required' })

        const docs = searchPublicDocCatalog(PUBLIC_DOC_CATALOG, query)
        return jsonResult({ query, count: docs.length, docs })
      },
    },
    {
      name: 'get_site_context',
      description:
        'Return the current public marketing or documentation page context, including pathname, document title, and whether the page is part of published docs.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () =>
        jsonResult({
          pathname: getPathname(),
          pageTitle: getPageTitle(),
          surface: 'public-marketing-or-docs',
        }),
    },
    {
      name: 'navigate_to_public_doc',
      description:
        'Navigate the visible browser tab to a published XID documentation page. Only public /docs slugs are allowed; auth and console paths are rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            description: 'Documentation slug or alias to open in the current tab.',
          },
        },
        required: ['slug'],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (input) => {
        const rawSlug = readStringProperty(input, 'slug')
        if (!rawSlug) return jsonResult({ error: 'slug is required' })

        const slug = normalizePublicDocSlugInput(rawSlug)
        if (!slug)
          return jsonResult({ error: 'unknown or unpublished documentation slug', slug: rawSlug })

        const doc = PUBLIC_DOC_CATALOG.find((entry) => entry.slug === slug)
        if (!doc) return jsonResult({ error: 'documentation entry not found', slug })

        const target = slug === 'getting-started' ? '/docs' : `/docs/${slug}`
        options.navigate(target)
        return jsonResult({ navigated: true, target, url: doc.url })
      },
    },
  ]
}
