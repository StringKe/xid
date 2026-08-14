import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  WEB_ROUTE_OWNER_HEADER,
  webRedirectLocationMatches,
  webRouteOwnerMatches,
} from './harness/web-route-owner.mjs'
import {
  CONSOLE_SPA_ROUTE_CHECKS,
  INSTANCE_CONSOLE_ROUTE_CHECKS,
  ORGANIZATION_CONSOLE_ROUTE_CHECKS,
  PLATFORM_CONSOLE_ROUTE_CHECKS,
} from './harness/console-route-checks.mjs'

describe('production web route owner contract', () => {
  it('requires explicit Site and Console owners', () => {
    expect(webRouteOwnerMatches(new Headers({ [WEB_ROUTE_OWNER_HEADER]: 'site' }), 'site')).toBe(
      true,
    )
    expect(
      webRouteOwnerMatches(new Headers({ [WEB_ROUTE_OWNER_HEADER]: 'console' }), 'console'),
    ).toBe(true)
    expect(webRouteOwnerMatches(new Headers(), 'site')).toBe(false)
    expect(webRouteOwnerMatches(new Headers(), 'console')).toBe(false)
  })

  it('accepts implicit or explicit Core and rejects override Worker owners', () => {
    expect(webRouteOwnerMatches(new Headers(), 'core')).toBe(true)
    expect(webRouteOwnerMatches(new Headers({ [WEB_ROUTE_OWNER_HEADER]: 'core' }), 'core')).toBe(
      true,
    )
    expect(webRouteOwnerMatches(new Headers({ [WEB_ROUTE_OWNER_HEADER]: 'site' }), 'core')).toBe(
      false,
    )
    expect(webRouteOwnerMatches(new Headers({ [WEB_ROUTE_OWNER_HEADER]: 'console' }), 'core')).toBe(
      false,
    )
  })

  it('matches same-origin redirect paths and preserved queries', () => {
    expect(
      webRedirectLocationMatches(
        '/account/sessions?from=smoke',
        'https://xid.dev',
        '/account/sessions',
        '?from=smoke',
      ),
    ).toBe(true)
    expect(
      webRedirectLocationMatches(
        'https://xid.dev/llms.txt?client=agent',
        'https://xid.dev',
        '/llms.txt',
        '?client=agent',
      ),
    ).toBe(true)
    expect(
      webRedirectLocationMatches(
        'https://tenant.xid.dev/llms.txt?client=agent',
        'https://xid.dev',
        '/llms.txt',
        '?client=agent',
      ),
    ).toBe(false)
    expect(
      webRedirectLocationMatches(
        'https://xid.dev/llms.txt',
        'https://xid.dev',
        '/llms.txt',
        '?client=agent',
      ),
    ).toBe(false)
  })

  it('keeps every production harness wired to the split Worker contract', async () => {
    const [httpHarness, browserHarness, readinessHarness, wildcardHarness] = await Promise.all([
      readFile(new URL('./harness/smoke-production.mjs', import.meta.url), 'utf8'),
      readFile(new URL('./harness/smoke-production-browser.mjs', import.meta.url), 'utf8'),
      readFile(new URL('./harness/goal-readiness-audit.mjs', import.meta.url), 'utf8'),
      readFile(new URL('./harness/wildcard-route-probe.mjs', import.meta.url), 'utf8'),
    ])

    expect(httpHarness).toContain('../../../packages/types/src/public-docs.ts')
    expect(httpHarness).toContain("productionSurfaceBaseUrl('XID_PRODUCTION_SITE_BASE_URL')")
    expect(httpHarness).toContain("productionSurfaceBaseUrl('XID_PRODUCTION_CONSOLE_BASE_URL')")
    expect(httpHarness).toContain("productionSurfaceBaseUrl('XID_PRODUCTION_CORE_BASE_URL')")
    expect(httpHarness).toContain('productionTenantBaseUrl()')
    expect(httpHarness).toContain('/?source=production-smoke')
    expect(httpHarness).toContain('/getting-started?source=production-smoke')
    expect(httpHarness).toContain('/llms.txt?source=production-smoke')
    expect(httpHarness).toContain('/console/?source=production-smoke')
    expect(httpHarness).toContain('`${tenantBaseUrl}/console/?source=production-smoke`')
    expect(httpHarness).toContain('`${tenantBaseUrl}/auth/config?source=production-smoke`')
    expect(httpHarness).toContain('runWildcardRouteProbe()')
    expect(httpHarness).toContain('webRouteOwnerMatches(res.headers, check.surface)')
    expect(httpHarness).not.toContain('x-xid-docs-route-status')
    expect(httpHarness).not.toContain('?locale=zh-Hans')
    expect(httpHarness).not.toContain('<main data-seo-fallback>')
    expect(httpHarness).toContain('xid\\.dev\\/zh-hans"')
    expect(httpHarness).toContain('xid\\.dev\\/pt-br"')
    expect(browserHarness).toContain(
      "checkAccountCompatibilityRoute(\n        page,\n        '/console/sessions',\n        '/account/sessions',",
    )
    expect(browserHarness).toContain(
      "checkAccountCompatibilityRoute(\n        page,\n        '/console/security',\n        '/account/security',",
    )
    expect(browserHarness).toContain("webRouteOwnerMatches(ownerResponse.headers, 'console')")
    expect(readinessHarness).toContain("webRouteOwnerMatches(internalDocs.res.headers, 'site')")
    expect(readinessHarness).toContain('runWildcardRouteProbe()')
    expect(readinessHarness).not.toContain('x-xid-docs-route-status')
    expect(wildcardHarness).toContain('productionWildcardProbeBaseUrl(environment, nonce)')
    expect(wildcardHarness).toContain("webRouteOwnerMatches(res.headers, 'core')")
    expect(wildcardHarness).toContain("webRouteOwnerMatches(res.headers, 'console')")
  })

  it('covers every Console SPA route in the production browser smoke', async () => {
    const routerSource = await readFile(
      new URL('../../apps/console/src/router.tsx', import.meta.url),
      'utf8',
    )
    const routeList = routerSource.match(
      /export const CONSOLE_SPA_ROUTE_PATHS = \[([\s\S]*?)\] as const/,
    )
    expect(routeList).not.toBeNull()
    const routerPaths = [...routeList[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
    const smokePaths = CONSOLE_SPA_ROUTE_CHECKS.map((route) => route.path)

    expect(INSTANCE_CONSOLE_ROUTE_CHECKS).toHaveLength(5)
    expect(ORGANIZATION_CONSOLE_ROUTE_CHECKS).toHaveLength(18)
    expect(PLATFORM_CONSOLE_ROUTE_CHECKS).toHaveLength(13)
    expect(new Set(smokePaths).size).toBe(36)
    expect(smokePaths.toSorted()).toEqual(routerPaths.toSorted())
  })
})
