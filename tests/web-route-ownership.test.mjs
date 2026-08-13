import { describe, expect, it } from 'vitest'
import {
  CORE_RESERVED_EXACT_PATHS,
  CORE_RESERVED_PREFIX_PATHS,
  CORE_SPA_ROUTE_PATHS,
  CORE_UI_ASSET_PREFIX,
  EXPECTED_WORKER_ROUTE_CONFIGS,
  EXPECTED_WORKER_SERVICE_BINDINGS,
  SITE_EXACT_PATHS,
  SITE_PREFIX_PATHS,
  SITE_PUBLIC_DOC_EXACT_PATHS,
  SITE_PUBLIC_DOC_PREFIX_PATHS,
  SITE_SCIM_DOC_EXACT_PATHS,
  XID_SITE_LOCALE_ROUTE_SEGMENTS,
  XID_SITE_LOCALES,
  isCoreSpaRoute,
  resolveWebRouteOwnership,
} from '../packages/types/src/web-route-ownership.ts'
import { PUBLIC_DOC_SLUGS } from '../packages/types/src/public-docs.ts'
import { TENANT_ROUTE_PATTERNS } from '../apps/server/worker/tenant-routes.ts'
import { parseJsonc, verifyWorkerRouteConfigs } from '../scripts/verify-worker-routes.mjs'

function expectOwner(url, owner, matchedRuleId) {
  const decision = resolveWebRouteOwnership(url)
  expect(decision.owner).toBe(owner)
  if (matchedRuleId) expect(decision.matchedRuleId).toBe(matchedRuleId)
  return decision
}

function expectedWranglerConfigs() {
  return Object.fromEntries(
    Object.entries(EXPECTED_WORKER_ROUTE_CONFIGS).map(([owner, routes]) => [
      owner,
      {
        name: owner === 'site' ? 'xid-site' : owner === 'console' ? 'xid-console' : 'xid',
        preview_urls: false,
        routes: routes.map((route) => ({
          pattern: route.pattern,
          ...(route.customDomain ? { custom_domain: true } : {}),
        })),
        services: EXPECTED_WORKER_SERVICE_BINDINGS[owner].map((service) => ({ ...service })),
      },
    ]),
  )
}

describe('Web route ownership', () => {
  it('assigns product, documentation hub, and legacy docs paths to Site', () => {
    expect(SITE_EXACT_PATHS).toContain('/index.md')
    expect(SITE_EXACT_PATHS).toContain('/index.mdx')
    expect(SITE_EXACT_PATHS).toContain('/docs')
    expect(SITE_EXACT_PATHS).toContain('/docs/index.md')
    expect(SITE_EXACT_PATHS).toContain('/docs/index.mdx')
    expect(SITE_EXACT_PATHS).toContain('/status')
    expect(SITE_EXACT_PATHS).toContain('/status/')
    expect(SITE_EXACT_PATHS).toContain('/status/index.md')
    expect(SITE_EXACT_PATHS).toContain('/status/index.mdx')
    for (const path of SITE_EXACT_PATHS) {
      expectOwner(`https://xid.dev${path}`, 'site')
      expectOwner(`https://xid.dev${path}?source=contract`, 'site')
    }
    expectOwner('https://xid.dev/docs/oidc', 'site')
    expectOwner('https://xid.dev/docs/sdks/web', 'site')
    expectOwner('https://xid.dev/docs/not-a-public-doc', 'site')
  })

  it('assigns all 41 English canonical pages and twins to Site', () => {
    expect(PUBLIC_DOC_SLUGS).toHaveLength(41)
    for (const slug of PUBLIC_DOC_SLUGS) {
      for (const suffix of ['', '/', '/index.md', '/index.mdx']) {
        expectOwner(`https://xid.dev/${slug}${suffix}`, 'site')
      }
    }
  })

  it('uses exact Site routes for the SCIM document without taking the Core protocol tree', () => {
    expect(SITE_SCIM_DOC_EXACT_PATHS).toEqual([
      '/scim',
      '/scim/',
      '/scim/index.md',
      '/scim/index.mdx',
    ])
    expect(SITE_PUBLIC_DOC_EXACT_PATHS).not.toContain('/scim')
    expect(SITE_PUBLIC_DOC_PREFIX_PATHS).not.toContain('/scim/')
    expectOwner('https://xid.dev/scim', 'site', 'site:apex:scim-doc-exact:/scim')
    expectOwner('https://xid.dev/scim/', 'site', 'site:apex:scim-doc-exact:/scim/')
    expectOwner('https://xid.dev/scim/index.md', 'site')
    expectOwner('https://xid.dev/scim/index.mdx', 'site')
    expectOwner('https://xid.dev/scim/v2/Users', 'core', 'core:reserved:prefix:/scim/')
    expectOwner('https://xid.dev/scim/outbound/target/sync', 'core', 'core:reserved:prefix:/scim/')
  })

  it('assigns generated public assets to Site', () => {
    for (const prefix of SITE_PREFIX_PATHS) {
      expectOwner(`https://xid.dev${prefix}contract-fixture`, 'site')
    }
    expectOwner('https://xid.dev/pagefind/pagefind-ui.js', 'site')
    expectOwner('https://xid.dev/og/docs/getting-started.png', 'site')
  })

  it('assigns all seven non-English locale trees to Site', () => {
    expect(XID_SITE_LOCALES).toHaveLength(7)
    expect(XID_SITE_LOCALES).toContain('zh-Hans')
    expect(XID_SITE_LOCALES).toContain('pt-BR')
    expect(XID_SITE_LOCALE_ROUTE_SEGMENTS['zh-Hans']).toBe('zh-hans')
    expect(XID_SITE_LOCALE_ROUTE_SEGMENTS['pt-BR']).toBe('pt-br')

    for (const locale of XID_SITE_LOCALES) {
      const routeSegment = XID_SITE_LOCALE_ROUTE_SEGMENTS[locale]
      expect(routeSegment).toBe(routeSegment.toLowerCase())
      expectOwner(`https://xid.dev/${routeSegment}`, 'site')
      expectOwner(`https://xid.dev/${routeSegment}/`, 'site')
      expectOwner(`https://xid.dev/${routeSegment}/oidc-oauth`, 'site')
      expectOwner(`https://xid.dev/${routeSegment}/docs`, 'site')
      expectOwner(`https://xid.dev/${routeSegment}/status`, 'site')
      expectOwner(`https://xid.dev/${routeSegment}/status/index.md`, 'site')
      expectOwner(`https://xid.dev/${routeSegment}/status/index.mdx`, 'site')
    }
  })

  it('assigns apex and tenant Console routes to Console', () => {
    expectOwner('https://xid.dev/console', 'console', 'console:apex:exact')
    expectOwner('https://xid.dev/console?source=contract', 'console', 'console:apex:exact')
    expectOwner('https://xid.dev/console/organizations', 'console', 'console:apex:prefix')
    expectOwner('https://acme.xid.dev/console', 'console', 'console:tenant:exact')
    expectOwner('https://acme.xid.dev/console?source=contract', 'console', 'console:tenant:exact')
    expectOwner('https://acme.xid.dev/console/settings/domains', 'console', 'console:tenant:prefix')
  })

  it('keeps every www path under the Site redirect override', () => {
    for (const path of [
      '/',
      '/oidc-oauth',
      '/docs/oidc',
      '/console',
      '/console/settings',
      '/authorize',
    ]) {
      const decision = expectOwner(
        `https://www.xid.dev${path}?source=contract`,
        'site',
        'site:www:override',
      )
      expect(decision.behavior).toBe('canonical-host-redirect')
      expect(decision.redirectStatus).toBe(308)
      expect(decision.redirectTarget).toBe(`https://xid.dev${path}?source=contract`)
    }
  })

  it('keeps protocol and fallback paths under Core', () => {
    for (const path of CORE_RESERVED_EXACT_PATHS) {
      expectOwner(`https://xid.dev${path}`, 'core')
      expectOwner(`https://tenant.xid.dev${path}`, 'core')
    }
    for (const prefix of CORE_RESERVED_PREFIX_PATHS) {
      expectOwner(`https://xid.dev${prefix}route-contract`, 'core')
      expectOwner(`https://tenant.xid.dev${prefix}route-contract`, 'core')
    }
    expectOwner('https://xid.dev/account', 'core', 'core:apex:fallback')
    expectOwner('https://tenant.xid.dev/account', 'core', 'core:tenant:fallback')
    expectOwner(`https://xid.dev${CORE_UI_ASSET_PREFIX}app.js`, 'core', 'core:ui-assets')
    expectOwner(`https://tenant.xid.dev${CORE_UI_ASSET_PREFIX}app.js`, 'core', 'core:ui-assets')
    expectOwner('https://xid.dev/assets/legacy.js', 'core', 'core:apex:fallback')
  })

  it('keeps the exact Core SPA manifest under Core without accepting typo descendants', () => {
    expect(CORE_SPA_ROUTE_PATHS).toHaveLength(18)
    for (const path of CORE_SPA_ROUTE_PATHS) {
      expectOwner(`https://xid.dev${path}`, 'core')
      expectOwner(`https://tenant.xid.dev${path}`, 'core')
      expect(isCoreSpaRoute(path)).toBe(true)
      expect(isCoreSpaRoute(`${path}/`)).toBe(true)
      expect(isCoreSpaRoute(`${path}/typo`)).toBe(false)
    }
  })

  it('keeps the Core reserved path contract aligned with the server router', () => {
    const ownershipPatterns = [
      ...CORE_RESERVED_EXACT_PATHS,
      ...CORE_RESERVED_PREFIX_PATHS.map((prefix) => `${prefix}*`),
    ].sort()
    expect(ownershipPatterns).toEqual([...TENANT_ROUTE_PATTERNS].sort())
  })

  it('models the well-known llms redirect as a Core exception', () => {
    const apex = expectOwner(
      'https://xid.dev/.well-known/llms.txt?client=agent',
      'core',
      'core:well-known-llms',
    )
    expect(apex.redirectStatus).toBe(308)
    expect(apex.redirectTarget).toBe('https://xid.dev/llms.txt?client=agent')

    const tenant = expectOwner(
      'https://tenant.xid.dev/.well-known/llms.txt',
      'core',
      'core:well-known-llms',
    )
    expect(tenant.redirectTarget).toBe('https://xid.dev/llms.txt')
  })

  it('leaves unrelated domains unowned', () => {
    expect(resolveWebRouteOwnership('https://example.com/docs').owner).toBeNull()
  })
})

describe('Wrangler route verifier', () => {
  it('parses comments, URLs, and trailing commas without changing strings', () => {
    expect(
      parseJsonc(`{
        // line comment
        "url": "https://xid.dev/docs",
        "routes": [
          { "pattern": "xid.dev/docs/*", }, /* block comment */
        ],
      }`),
    ).toEqual({
      url: 'https://xid.dev/docs',
      routes: [{ pattern: 'xid.dev/docs/*' }],
    })
  })

  it('accepts only the route manifests declared by the ownership model', () => {
    const configs = expectedWranglerConfigs()
    expect(verifyWorkerRouteConfigs(configs)).toEqual([])

    const sitePatterns = configs.site.routes.map((route) => route.pattern)
    const consolePatterns = configs.console.routes.map((route) => route.pattern)
    const corePatterns = configs.core.routes.map((route) => route.pattern)
    expect(configs.site.services).toEqual([])
    expect(configs.console.services).toEqual([])
    expect(configs.core.services).toEqual([
      { binding: 'SITE_WORKER', service: 'xid-site' },
      { binding: 'CONSOLE_WORKER', service: 'xid-console' },
    ])
    expect(sitePatterns).toContain('www.xid.dev/console')
    expect(sitePatterns).toContain('www.xid.dev/console/*')
    expect(consolePatterns.some((pattern) => pattern.startsWith('www.xid.dev/'))).toBe(false)
    expect(sitePatterns).not.toContain('xid.dev/*')
    expect(sitePatterns).not.toContain('xid.dev/scim/*')
    expect(sitePatterns).not.toContain('xid.dev/assets/*')
    expect(consolePatterns).not.toContain('xid.dev/*')
    expect(corePatterns).toContain('*/*')
    expect(sitePatterns).toContain('xid.dev/index.md')
    expect(sitePatterns).toContain('xid.dev/index.mdx')
    expect(sitePatterns).toContain('xid.dev/docs')
    expect(sitePatterns).toContain('xid.dev/docs/index.md')
    expect(sitePatterns).toContain('xid.dev/docs/index.mdx')
    expect(sitePatterns).toContain('xid.dev/getting-started')
    expect(sitePatterns).toContain('xid.dev/getting-started/*')
    expect(sitePatterns).toContain('xid.dev/scim')
    expect(sitePatterns).toContain('xid.dev/scim/')
    expect(sitePatterns).toContain('xid.dev/scim/index.md')
    expect(sitePatterns).toContain('xid.dev/scim/index.mdx')
    expect(sitePatterns).toContain('xid.dev/en/llms.txt')
    expect(sitePatterns).toContain('xid.dev/en/llms-full.txt')
    expect(sitePatterns).toContain('xid.dev/zh-hans/*')
    expect(sitePatterns).toContain('xid.dev/pt-br/*')
    expect(sitePatterns.some((pattern) => pattern.includes('zh-Hans'))).toBe(false)
    expect(sitePatterns.some((pattern) => pattern.includes('pt-BR'))).toBe(false)
  })

  it('fails missing, over-wide, and cross-Worker duplicate routes', () => {
    const configs = expectedWranglerConfigs()
    configs.site.routes = configs.site.routes.slice(1)
    configs.console.routes.push({ pattern: 'xid.dev/*' })
    configs.console.routes.push({ pattern: 'www.xid.dev/*' })
    configs.core.services = configs.core.services.slice(1)
    configs.site.services.push({ binding: 'CORE_WORKER', service: 'xid' })

    const errors = verifyWorkerRouteConfigs(configs)
    expect(errors.some((error) => error.includes('site: missing route'))).toBe(true)
    expect(errors).toContain('console: over-wide or unowned route route:xid.dev/*')
    expect(errors).toContain('unresolved duplicate pattern www.xid.dev/*: site, console')
    expect(errors).toContain('core: missing service binding SITE_WORKER:xid-site')
    expect(errors).toContain('site: unexpected service binding CORE_WORKER:xid')
  })

  it('rejects renamed production Workers and public Preview URLs', () => {
    const configs = expectedWranglerConfigs()
    configs.core.name = 'xid-core'
    configs.site.preview_urls = true

    expect(verifyWorkerRouteConfigs(configs)).toEqual(
      expect.arrayContaining(['core: name must be xid', 'site: preview_urls must be false']),
    )
  })
})
