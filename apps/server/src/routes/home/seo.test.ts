import { readFile, stat } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const htmlPath = new URL('../../../index.html', import.meta.url)
const robotsPath = new URL('../../../public/robots.txt', import.meta.url)
const sitemapPath = new URL('../../../public/sitemap.xml', import.meta.url)
const llmsPath = new URL('../../../public/llms.txt', import.meta.url)
const llmsFullPath = new URL('../../../public/llms-full.txt', import.meta.url)
const wellKnownLlmsPath = new URL('../../../public/.well-known/llms.txt', import.meta.url)
const heroSourcePath = new URL('./HeroSection.tsx', import.meta.url)
const platformSourcePath = new URL('./PlatformSection.tsx', import.meta.url)
const federationSourcePath = new URL('./FederationSection.tsx', import.meta.url)

const publicDocsSlugs = [
  '/docs',
  '/docs/oidc',
  '/docs/hosted-auth',
  '/docs/oidc-oauth',
  '/docs/enterprise-sso',
  '/docs/social-login',
  '/docs/saml',
  '/docs/scim',
  '/docs/management-api',
  '/docs/webhooks',
  '/docs/branding',
  '/docs/sdks',
  '/docs/self-hosting',
]

// /docs/goal、/docs/verification、/docs/current-gap-audit、/docs/implementation-status 对应的
// markdown 已删除,slug 仍留在 deny-list:sitemap 永远不得收录这些路径,防止未来复用同名 slug 时静默泄露。
const internalDocsSlugs = [
  '/docs/design',
  '/docs/goal',
  '/docs/verification',
  '/docs/deployment',
  '/docs/api-contracts',
  '/docs/current-gap-audit',
  '/docs/implementation-status',
  '/docs/soft-delete',
  '/docs/i18n',
  '/docs/api',
]

async function readPngDimensions(path: URL): Promise<{ width: number; height: number }> {
  const buffer = await readFile(path)
  expect(buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

describe('home SEO contract', () => {
  it('ships crawlable head metadata in the initial HTML', async () => {
    const html = await readFile(htmlPath, 'utf8')

    expect(html).toContain('<title>XID | Edge identity platform</title>')
    expect(html).toContain('<meta name="robots" content="index,follow" />')
    expect(html).toContain('<meta name="application-name" content="XID" />')
    expect(html).toContain('http-equiv="origin-trial"')
    expect(html).toContain('AwQJO+GulqA9rUZ4ndXF2fkvirbACtMu7uobk+QrJwUr')
    expect(html).toContain(
      '<link rel="canonical" id="xid-page-canonical" href="https://xid.dev/" />',
    )
    expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://xid.dev/" />')
    expect(html).toMatch(
      /<meta\s+name="description"\s+content="XID is an edge-native identity platform/u,
    )
    expect(html).toContain('<meta property="og:type" content="website" />')
    expect(html).toContain('<meta property="og:url" content="https://xid.dev/" />')
    expect(html).toContain('<meta property="og:title" content="XID | Edge identity platform" />')
    expect(html).toContain('<meta property="og:image" content="https://xid.dev/brand/og.png" />')
    expect(html).toContain(
      '<meta name="twitter:image" content="https://xid.dev/brand/twitter-card.png" />',
    )
    expect(html).toContain('<main data-seo-fallback>')
    expect(html).toContain('<h1>XID edge identity platform</h1>')
    expect(html).toContain(
      '<link rel="alternate" type="text/plain" href="/llms.txt" title="LLMs.txt" />',
    )
    expect(html).toContain(
      '<link rel="alternate" type="text/plain" href="/llms-full.txt" title="LLMs-full.txt" />',
    )

    for (const slug of publicDocsSlugs) {
      expect(html).toContain(`href="${slug}"`)
    }
  })

  it('ships parseable JSON-LD with current product semantics', async () => {
    const html = await readFile(htmlPath, 'utf8')
    const match = html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/)

    expect(match).not.toBeNull()
    const jsonLd = JSON.parse(match?.[1] ?? '{}') as { '@graph'?: Array<Record<string, unknown>> }
    const graph = Array.isArray(jsonLd['@graph']) ? jsonLd['@graph'] : []
    const types = new Set(graph.map((entry) => entry['@type']))
    const software = graph.find((entry) => entry['@type'] === 'SoftwareApplication')

    expect(types).toEqual(new Set(['Organization', 'WebSite', 'SoftwareApplication']))
    const website = graph.find((entry) => entry['@type'] === 'WebSite')
    expect(website?.potentialAction).toMatchObject({
      '@type': 'SearchAction',
    })
    expect(software?.['url']).toBe('https://xid.dev/')
    expect(software?.['image']).toBe('https://xid.dev/brand/og.png')
    expect(software?.['operatingSystem']).toBe('Cloudflare Workers')
    expect(software?.['featureList']).toContain(
      'Networkless JWT verification on Cloudflare Workers',
    )
    expect(software?.['featureList']).toContain(
      'Downstream SaaS SAML and outbound SCIM local baselines',
    )
  })

  it('keeps homepage protocol claims aligned with support levels', async () => {
    // 设计稿 v2 的诚实声明分布:hero 不夸大,Platform 标注支持等级,Federation 按证据分级。
    const heroSource = await readFile(heroSourcePath, 'utf8')
    const platformSource = await readFile(platformSourcePath, 'utf8')
    const federationSource = await readFile(federationSourcePath, 'utf8')
    const forbiddenCompleteIdpClaim = ['complete OIDC / OAuth', 'identity provider'].join(' ')

    expect(heroSource).not.toContain(forbiddenCompleteIdpClaim)
    expect(heroSource).not.toContain('enterprise SAML and SCIM')
    expect(platformSource).toContain('explicit support level')
    expect(platformSource).toContain('No inflated claims')
    expect(federationSource).toContain('Provider-ready')
    expect(federationSource).toContain('Planned')
    expect(federationSource).toContain('not claimed')
  })

  it('keeps robots scoped to public docs slugs', async () => {
    const robots = await readFile(robotsPath, 'utf8')
    const lines = robots
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)

    expect(lines).toContain('User-agent: *')
    expect(lines).toContain('Allow: /$')
    expect(lines).toContain('Allow: /docs$')
    expect(lines).toContain('Allow: /docs/oidc$')
    expect(lines).toContain('Allow: /docs/hosted-auth$')
    expect(lines).toContain('Allow: /docs/oidc-oauth$')
    expect(lines).toContain('Allow: /docs/enterprise-sso$')
    expect(lines).toContain('Allow: /docs/social-login$')
    expect(lines).toContain('Allow: /docs/saml$')
    expect(lines).toContain('Allow: /docs/scim$')
    expect(lines).toContain('Allow: /docs/management-api$')
    expect(lines).toContain('Allow: /docs/webhooks$')
    expect(lines).toContain('Allow: /docs/branding$')
    expect(lines).toContain('Allow: /docs/sdks$')
    expect(lines).toContain('Allow: /docs/self-hosting$')
    expect(lines).not.toContain('Allow: /docs/')
    expect(lines).toContain('Disallow: /sign-in')
    expect(lines).toContain('Disallow: /sign-up')
    expect(lines).toContain('Disallow: /account')
    expect(lines).toContain('Disallow: /console')
    expect(lines).toContain('Disallow: /auth')
    expect(lines).toContain('Disallow: /v1')
    expect(lines).toContain('Sitemap: https://xid.dev/sitemap.xml')
  })

  it('keeps sitemap public and excludes internal repository docs', async () => {
    const sitemap = await readFile(sitemapPath, 'utf8')

    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    expect(sitemap).toContain('<loc>https://xid.dev/</loc>')
    for (const slug of publicDocsSlugs) {
      expect(sitemap).toContain(`<loc>https://xid.dev${slug}</loc>`)
    }
    for (const slug of internalDocsSlugs) {
      expect(sitemap).not.toContain(`https://xid.dev${slug}`)
    }
  })

  it('ships llms.txt for AI crawlers with heading and public links', async () => {
    const llms = await readFile(llmsPath, 'utf8')

    expect(llms).toMatch(/^# XID/m)
    expect(llms).toContain('https://xid.dev/')
    expect(llms).toContain('https://xid.dev/docs')
    expect(llms).toContain('https://xid.dev/sitemap.xml')
    expect(llms).toContain('https://xid.dev/robots.txt')
    expect(llms).toContain('https://xid.dev/llms-full.txt')
    expect(llms).toContain('WebMCP tools')
    expect(llms).not.toContain('https://xid.dev/docs/design')
    expect(llms).not.toContain('https://xid.dev/console')
  })

  it('ships llms-full.txt with every published documentation slug', async () => {
    const llmsFull = await readFile(llmsFullPath, 'utf8')

    expect(llmsFull).toMatch(/^# XID: full public documentation index/m)
    expect(llmsFull).toContain('https://xid.dev/llms.txt')
    expect(llmsFull).toContain('https://xid.dev/docs/oidc-oauth')
    expect(llmsFull).toContain('https://xid.dev/docs/sdks/react')
    expect(llmsFull).toContain('`/docs/oidc` -> `/docs/oidc-oauth`')
    expect(llmsFull).not.toContain('https://xid.dev/docs/design')
  })

  it('mirrors llms.txt under .well-known for alternate discovery', async () => {
    const llms = await readFile(llmsPath, 'utf8')
    const wellKnown = await readFile(wellKnownLlmsPath, 'utf8')

    expect(wellKnown).toBe(llms)
  })

  it('keeps share images present with declared dimensions', async () => {
    const images = [
      { path: new URL('../../../public/brand/og.png', import.meta.url), width: 1200, height: 630 },
      {
        path: new URL('../../../public/brand/twitter-card.png', import.meta.url),
        width: 1200,
        height: 675,
      },
    ]

    for (const image of images) {
      const file = await stat(image.path)
      expect(file.isFile()).toBe(true)
      expect(file.size).toBeGreaterThan(0)
      await expect(readPngDimensions(image.path)).resolves.toEqual({
        width: image.width,
        height: image.height,
      })
    }
  })
})
