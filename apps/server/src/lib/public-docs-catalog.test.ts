import { describe, expect, it } from 'vitest'
import { PUBLIC_DOC_SLUGS } from '../../public-docs'
import {
  buildPublicDocCatalog,
  normalizePublicDocSlugInput,
  searchPublicDocCatalog,
} from './public-docs-catalog'

describe('public docs catalog', () => {
  it('covers every published slug with canonical URLs', () => {
    const catalog = buildPublicDocCatalog()

    expect(catalog).toHaveLength(PUBLIC_DOC_SLUGS.length)
    expect(catalog.map((entry) => entry.slug)).toEqual([...PUBLIC_DOC_SLUGS])
    expect(catalog[0]?.url).toBe('https://xid.dev/docs')
    expect(catalog.find((entry) => entry.slug === 'oidc-oauth')?.url).toBe(
      'https://xid.dev/docs/oidc-oauth',
    )
  })

  it('normalizes aliases and rejects unpublished slugs', () => {
    expect(normalizePublicDocSlugInput('oidc')).toBe('oidc-oauth')
    expect(normalizePublicDocSlugInput('/docs/sso')).toBe('enterprise-sso')
    expect(normalizePublicDocSlugInput('docs/sdks/react')).toBe('sdks/react')
    expect(normalizePublicDocSlugInput('design')).toBeNull()
  })

  it('searches across slug, title, description, and category', () => {
    const catalog = buildPublicDocCatalog()
    const results = searchPublicDocCatalog(catalog, 'webhook')

    expect(results.some((entry) => entry.slug === 'webhooks')).toBe(true)
    expect(
      results.every(
        (entry) =>
          entry.title.toLowerCase().includes('webhook') ||
          (entry.description ?? '').toLowerCase().includes('webhook'),
      ),
    ).toBe(true)
  })
})
