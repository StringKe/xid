import { describe, expect, it } from 'vitest'
import {
  PUBLIC_DOC_SLUGS,
  getPublicDocsRouteDecision,
  isDocsPath,
  isPublicDocsPath,
  normalizeDocsPath,
  resolvePublicDocSlug,
} from '../packages/types/src/public-docs.ts'

describe('public docs route contract', () => {
  it('models the root hub and all 40 canonical detail pages', () => {
    expect(PUBLIC_DOC_SLUGS).toHaveLength(40)
    expect(normalizeDocsPath('/')).toBe('/')
    expect(isPublicDocsPath('/')).toBe(true)
    expect(isPublicDocsPath('/index.md')).toBe(true)
    expect(isPublicDocsPath('/index.mdx')).toBe(true)

    for (const slug of PUBLIC_DOC_SLUGS) {
      expect(resolvePublicDocSlug(`/${slug}`)).toBe(slug)
      expect(resolvePublicDocSlug(`/${slug}/`)).toBe(slug)
      expect(resolvePublicDocSlug(`/${slug}/index.md`)).toBe(slug)
      expect(resolvePublicDocSlug(`/${slug}/index.mdx`)).toBe(slug)
    }
  })

  it('recognizes legacy canonical and historical alias paths without exposing unknown docs', () => {
    expect(isPublicDocsPath('/docs')).toBe(true)
    expect(isPublicDocsPath('/docs/index.md')).toBe(true)
    expect(resolvePublicDocSlug('/docs/getting-started')).toBe('getting-started')
    expect(resolvePublicDocSlug('/docs/getting-started/index.mdx')).toBe('getting-started')
    expect(resolvePublicDocSlug('/docs/oidc')).toBe('oidc-oauth')
    expect(resolvePublicDocSlug('/docs/sdks/web/index.md')).toBe('sdks/core')
    expect(isDocsPath('/docs/not-a-public-doc')).toBe(true)
    expect(isPublicDocsPath('/docs/not-a-public-doc')).toBe(false)
    expect(isDocsPath('/scim/v2/Users')).toBe(false)
  })

  it('distinguishes public, blocked legacy, and unrelated route decisions', () => {
    expect(getPublicDocsRouteDecision('/').status).toBe('public-technical-doc')
    expect(getPublicDocsRouteDecision('/scim/index.md')).toMatchObject({
      status: 'public-technical-doc',
      slug: 'scim',
    })
    expect(getPublicDocsRouteDecision('/docs/unknown')).toMatchObject({
      status: 'blocked-non-public-docs-path',
      slug: null,
    })
    expect(getPublicDocsRouteDecision('/authorize')).toMatchObject({
      status: 'not-docs-path',
      slug: null,
    })
  })
})
