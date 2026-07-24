import { describe, expect, it } from 'vitest'
import {
  PUBLIC_DOC_SLUGS,
  getPublicDocsRouteDecision,
  normalizeDocsPath,
  resolvePublicDocSlug,
} from './registry'
import publicDocsRegistrySource from '../../../public-docs.ts?raw'
import docsSource from './index.tsx?raw'
import reactNativeDocSource from './sdk-docs/react-native.tsx?raw'

// 历史内部文档 slug 永久保留在 deny-list:docs/goal、docs/verification、docs/implementation-status
// 对应的 markdown 已从仓库删除,但 slug 仍要永远 404 -- 防止有人复用同名 slug 建公开文档时静默泄露。
const INTERNAL_DOC_PATTERNS = [
  'docs/design',
  'docs/goal',
  'docs/verification',
  'docs/soft-delete',
  'docs/implementation-status',
  'docs/api-contracts',
  'docs/deployment',
  'implementation-status',
  'soft-delete',
  '完整功能设计',
  '功能设计',
  '设计真相源',
]

const PUBLIC_TENANT_LANGUAGE_PATTERNS = [
  'tenant resources',
  'tenant policy',
  'tenant API keys',
  'tenant-scoped',
  'tenant scoped',
  'Tenants can',
  '{tenant_id}',
  '/scim/v2/{tenant_id}',
]

describe('public docs registry', () => {
  it('resolves only product technical docs slugs', () => {
    expect(resolvePublicDocSlug('/docs')).toBe('getting-started')
    expect(resolvePublicDocSlug('/docs/scim')).toBe('scim')
    expect(resolvePublicDocSlug('/docs/self-hosting')).toBe('self-hosting')
    expect(resolvePublicDocSlug('/docs/oidc')).toBe('oidc-oauth')
    expect(resolvePublicDocSlug('/docs/sso')).toBe('enterprise-sso')
    expect(resolvePublicDocSlug('/docs/social')).toBe('social-login')
    expect(resolvePublicDocSlug('/docs/sdks/core')).toBe('sdks/core')
    expect(resolvePublicDocSlug('/docs/sdks/web')).toBe('sdks/core')
    expect(resolvePublicDocSlug('/docs/sdks/react')).toBe('sdks/react')
    expect(resolvePublicDocSlug('/docs/sdks/vue')).toBe('sdks/vue')
    expect(resolvePublicDocSlug('/docs/sdks/go')).toBe('sdks/go')
    expect(resolvePublicDocSlug('/docs/sdks/flutter')).toBe('sdks/flutter')
  })

  it('keeps internal engineering documents out of the public XID docs namespace', () => {
    expect(resolvePublicDocSlug('/docs/api')).toBeNull()
    expect(resolvePublicDocSlug('/docs/api-contracts')).toBeNull()
    expect(resolvePublicDocSlug('/docs/deployment')).toBeNull()
    expect(resolvePublicDocSlug('/docs/design')).toBeNull()
    expect(resolvePublicDocSlug('/docs/goal')).toBeNull()
    expect(resolvePublicDocSlug('/docs/verification')).toBeNull()
    expect(resolvePublicDocSlug('/docs/soft-delete')).toBeNull()
    expect(resolvePublicDocSlug('/docs/i18n')).toBeNull()
  })

  it('keeps the public docs registry restricted to XID technical topics', () => {
    expect([...PUBLIC_DOC_SLUGS].sort()).toEqual([
      'branding',
      'enterprise-sso',
      'getting-started',
      'hosted-auth',
      'management-api',
      'oidc-oauth',
      'saml',
      'scim',
      'sdks',
      'sdks/android',
      'sdks/angular',
      'sdks/astro',
      'sdks/backend',
      'sdks/core',
      'sdks/dotnet',
      'sdks/electron',
      'sdks/expo',
      'sdks/flutter',
      'sdks/go',
      'sdks/ios',
      'sdks/java',
      'sdks/linux',
      'sdks/macos',
      'sdks/nextjs',
      'sdks/nuxt',
      'sdks/php',
      'sdks/python',
      'sdks/react',
      'sdks/react-native',
      'sdks/remix',
      'sdks/ruby',
      'sdks/rust',
      'sdks/solid',
      'sdks/svelte',
      'sdks/tauri',
      'sdks/vue',
      'sdks/windows',
      'self-hosting',
      'social-login',
      'webhooks',
    ])
  })

  it('keeps SDK status wording aligned with the platform support matrix', () => {
    expect(docsSource).toContain('Current package')
    expect(docsSource).toContain('Implemented · verified locally')
    expect(docsSource).not.toContain('Scaffold')

    expect(reactNativeDocSource).toContain('Current package')
    expect(reactNativeDocSource).toContain('pending manual verification')
    expect(reactNativeDocSource.toLowerCase()).not.toContain('scaffold')
  })

  it('normalizes trailing slashes', () => {
    expect(normalizeDocsPath('/docs/scim/')).toBe('/docs/scim')
    expect(resolvePublicDocSlug('/docs/scim/')).toBe('scim')
  })

  it('reports a copyable route decision for browser and dev server diagnostics', () => {
    expect(getPublicDocsRouteDecision('/docs/scim')).toMatchObject({
      normalizedPath: '/docs/scim',
      status: 'public-technical-doc',
      slug: 'scim',
      registrySource: 'xid-public-technical-docs-registry',
      contentSource: 'apps/server/src/routes/docs/index.tsx',
      repoDocsMarkdownServed: false,
      internalRepositoryDocsServed: false,
    })
    expect(getPublicDocsRouteDecision('/docs/design')).toMatchObject({
      normalizedPath: '/docs/design',
      status: 'blocked-non-public-docs-path',
      slug: null,
      repoDocsMarkdownServed: false,
      internalRepositoryDocsServed: false,
    })
  })

  it('keeps browser diagnostics copyable as one JSON log line', () => {
    const diagnostic = {
      ...getPublicDocsRouteDecision('/docs/scim'),
      renderedTitle: 'SCIM API reference',
    }
    const line = `[xid:docs] route-decision ${JSON.stringify(diagnostic)}`
    expect(line).toContain('"status":"public-technical-doc"')
    expect(line).toContain('"slug":"scim"')
    expect(line).toContain('"contentSource":"apps/server/src/routes/docs/index.tsx"')
    expect(line).toContain('"repoDocsMarkdownServed":false')
    expect(line).toContain('"internalRepositoryDocsServed":false')
    expect(line).toContain('"renderedTitle":"SCIM API reference"')
  })

  it('keeps public docs content separate from internal repository docs', () => {
    expect(docsSource).toContain('SCIM API reference')
    expect(docsSource).toContain('SCIM 2.0 endpoint contract')
    expect(docsSource).toContain('/.well-known/oauth-protected-resource')
    expect(docsSource).toContain('/scim/v2/organizations')
    expect(docsSource).toContain('{organization_id}')
    expect(docsSource).toContain('Support levels')
    expect(docsSource).toContain('Guarded or minimal OAuth and OIDC extensions')
    expect(docsSource).toContain('FAPI 2.0 / Browser-Based')
    expect(docsSource).toContain('Apps profile gates')
    expect(docsSource).toContain('GNAP, UMA, HEART, OpenID4VP, OpenID4VCI')
    expect(docsSource).toContain('token-exchange refresh and ID')
    expect(docsSource).toContain('token issuance')
    expect(docsSource).toContain('JWT bearer and SAML bearer assertion grants are not enabled')
    expect(docsSource).toContain('mTLS client authentication')
    expect(docsSource).toContain('sort.supported=true')
    expect(docsSource).toContain('bulk.supported=true')
    expect(docsSource).toContain('etag.supported=true')
    expect(docsSource).toContain('If-Match')
    expect(docsSource).toContain('SAML is provider-ready')
    expect(docsSource).toContain('Enterprise SSO')
    expect(docsSource).toContain('Microsoft Entra ID')
    expect(docsSource).toContain('Okta')
    expect(docsSource).toContain('Google Workspace')
    expect(docsSource).toContain('SAML Single Logout are not public-supported yet')
    expect(docsSource).toContain('Social login')
    expect(docsSource).toContain('provider-ready until real provider callback L4 exists')
    expect(docsSource).toContain('@xid-kit/core')
    expect(docsSource).toContain('@xid-kit/backend')
    expect(docsSource).toContain('@xid-kit/react')
    expect(docsSource).toContain('@xid-kit/nextjs')
    expect(docsSource).toContain('/docs/sdks/core')
    expect(docsSource).toContain('React Native')
    expect(docsSource).toContain('Flutter')
    expect(docsSource).toContain('iOS')
    expect(docsSource).toContain('Android')
    expect(docsSource).toContain('macOS')
    expect(docsSource).toContain('WebAuthn and passkey boundaries')
    expect(docsSource).toContain('/auth/mfa/passkey/')
    expect(docsSource).toContain('attestationMode')
    expect(docsSource).toContain('EdDSA')
    expect(docsSource).toContain('urn:xid:aal3')
    expect(docsSource).not.toContain('Directory sync (SCIM)')
    expect(docsSource).not.toContain('Every endpoint from')
    for (const pattern of INTERNAL_DOC_PATTERNS) {
      expect(docsSource).not.toContain(pattern)
    }
    for (const pattern of PUBLIC_TENANT_LANGUAGE_PATTERNS) {
      expect(docsSource).not.toContain(pattern)
    }
  })

  it('keeps the public docs registry independent from repository docs files', () => {
    for (const pattern of INTERNAL_DOC_PATTERNS) {
      expect(publicDocsRegistrySource).not.toContain(pattern)
    }
  })
})
