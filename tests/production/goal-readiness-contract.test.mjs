import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_SECURITY_RULES_GAP,
  cloudflareSecurityRulesReadinessGaps,
  npmRegistryVersionMatches,
  remoteD1MigrationReadinessGaps,
  TURNSTILE_PUBLIC_KEY_GAP,
  TURNSTILE_SECRET_GAP,
  turnstileReadinessGaps,
} from './harness/goal-readiness-audit.mjs'
import { parsePendingD1Migrations } from '../../apps/server/scripts/production-target.mjs'
import { docsAuthActionsOk, docsLocaleMetadataOk } from './harness/public-doc-html.mjs'

describe('goal readiness production configuration contract', () => {
  it('reports the Turnstile public and secret halves as distinct gaps', () => {
    expect(turnstileReadinessGaps({ turnstileSiteKey: null }, new Set())).toEqual([
      TURNSTILE_PUBLIC_KEY_GAP,
      TURNSTILE_SECRET_GAP,
    ])
    expect(turnstileReadinessGaps({ turnstileSiteKey: 'site-key' }, new Set())).toEqual([
      TURNSTILE_SECRET_GAP,
    ])
    expect(
      turnstileReadinessGaps({ turnstileSiteKey: null }, new Set(['TURNSTILE_SECRET'])),
    ).toEqual([TURNSTILE_PUBLIC_KEY_GAP])
  })

  it('accepts Turnstile only when both configuration halves are present', () => {
    expect(
      turnstileReadinessGaps({ turnstileSiteKey: 'site-key' }, new Set(['TURNSTILE_SECRET'])),
    ).toEqual([])
  })

  it('requires an explicitly reconciled Cloudflare security-rule manifest', () => {
    expect(
      cloudflareSecurityRulesReadinessGaps({
        deploymentState: 'EXTERNAL',
        manifestDigest: 'a'.repeat(64),
      }),
    ).toEqual([`${CLOUDFLARE_SECURITY_RULES_GAP}: deploymentState=EXTERNAL`])
    expect(
      cloudflareSecurityRulesReadinessGaps({
        deploymentState: 'RECONCILED',
        manifestDigest: 'a'.repeat(64),
      }),
    ).toEqual([])
  })

  it('parses Wrangler remote D1 migration output without treating unknown output as applied', () => {
    expect(
      parsePendingD1Migrations(`
\u001b[31mMigrations to be applied:\u001b[0m
│ 0008_control-plane-projects.sql          │
│ 0002_outbound_scim_resources.sql         │
│ 0008_control-plane-projects.sql          │
`),
    ).toEqual(['0002_outbound_scim_resources.sql', '0008_control-plane-projects.sql'])
    expect(parsePendingD1Migrations('✅ No migrations to apply!')).toEqual([])
    expect(() => parsePendingD1Migrations('Resource location: remote')).toThrow(
      'wrangler d1 migrations list output was not recognized',
    )
  })

  it('surfaces every pending production migration as a distinct gap', () => {
    expect(
      remoteD1MigrationReadinessGaps([
        '0002_outbound_scim_resources.sql',
        '0008_control-plane-projects.sql',
      ]),
    ).toEqual([
      'Production D1 migration pending: 0002_outbound_scim_resources.sql',
      'Production D1 migration pending: 0008_control-plane-projects.sql',
    ])
    expect(remoteD1MigrationReadinessGaps([])).toEqual([])
  })

  it('accepts npm publication only for the exact public package version', () => {
    const target = { name: '@xid-kit/core', version: '0.1.0-alpha.0' }
    expect(npmRegistryVersionMatches(target, target)).toBe(true)
    expect(npmRegistryVersionMatches({ ...target, version: '0.1.0-alpha.1' }, target)).toBe(false)
    expect(npmRegistryVersionMatches({ ...target, name: '@xid-kit/types' }, target)).toBe(false)
  })

  it('requires localized docs actions, Open Graph, JSON-LD, and llms alternate together', () => {
    const html = `<html lang="zh-Hans"><head>
      <meta content="zh_CN" property="og:locale">
      <link href="https://xid.dev/zh-hans/llms.txt" type="text/plain" rel="alternate">
      <script type="application/ld+json">{"url":"https://xid.dev/zh-hans/scim","inLanguage":"zh-Hans"}</script>
      </head><body>
      <a href="/sign-in?locale=zh-Hans">Sign in</a>
      <a href="/sign-in?intent=sign-up&amp;locale=zh-Hans">Sign up</a>
      </body></html>`

    expect(docsAuthActionsOk(html, 'zh-Hans')).toBe(true)
    expect(
      docsLocaleMetadataOk(html, {
        language: 'zh-Hans',
        ogLocale: 'zh_CN',
        canonicalUrl: 'https://xid.dev/zh-hans/scim',
        llmsIndexUrl: 'https://xid.dev/zh-hans/llms.txt',
      }),
    ).toBe(true)
    expect(
      docsLocaleMetadataOk(html.replace('zh_CN', 'en'), {
        language: 'zh-Hans',
        ogLocale: 'zh_CN',
        canonicalUrl: 'https://xid.dev/zh-hans/scim',
        llmsIndexUrl: 'https://xid.dev/zh-hans/llms.txt',
      }),
    ).toBe(false)
    expect(docsAuthActionsOk(html.replace('intent=sign-up', 'intent=sign-in'), 'zh-Hans')).toBe(
      false,
    )
  })
})
