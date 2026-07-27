import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderEntryAsMarkdown } from '@cloudflare/nimbus-docs'
import { resolveWebRouteOwnership } from '../../../packages/types/src/web-route-ownership.ts'

const SITE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const GENERATED_DOCS_ROOT = path.join(SITE_ROOT, 'src/content/generated/docs')
const DIST_ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(SITE_ROOT, 'dist')
const SITE_ORIGIN = 'https://xid.dev'
const LEGACY_CORE_DOCS_SOURCE = ['apps', 'server', 'src', 'routes', 'docs'].join('/')
const REQUIRED_STATIC_HEADERS = [
  '/*.md',
  '  Content-Type: text/markdown; charset=utf-8',
  '/*.mdx',
  '  Content-Type: text/markdown; charset=utf-8',
  '/*.txt',
  '  Content-Type: text/plain; charset=utf-8',
  '',
].join('\n')

const LOCALES = [
  { locale: 'en', segment: '' },
  { locale: 'zh-Hans', segment: 'zh-hans' },
  { locale: 'ja', segment: 'ja' },
  { locale: 'ko', segment: 'ko' },
  { locale: 'fr', segment: 'fr' },
  { locale: 'de', segment: 'de' },
  { locale: 'es', segment: 'es' },
  { locale: 'pt-BR', segment: 'pt-br' },
]

const LEGACY_ALIASES = {
  '/docs/oidc': '/oidc-oauth',
  '/docs/oauth': '/oidc-oauth',
  '/docs/sso': '/enterprise-sso',
  '/docs/enterprise': '/enterprise-sso',
  '/docs/social': '/social-login',
  '/docs/sdks/web': '/sdks/core',
}

const INTERNAL_DOC_SLUGS = [
  'design',
  'goal',
  'verification',
  'deployment',
  'api-contracts',
  'current-gap-audit',
  'implementation-status',
  'soft-delete',
  'i18n',
  'api',
]

const CORE_RESERVED_PATHS = [
  '/.well-known/openid-configuration',
  '/jwks',
  '/authorize',
  '/par',
  '/token',
  '/userinfo',
  '/end_session',
  '/auth/sign-in',
  '/account/security',
  '/v1/users',
  '/sso/saml',
  '/scim/v2/ServiceProviderConfig',
]

const MERMAID_DOC_SLUGS = new Set(['getting-started', 'hosted-auth', 'enterprise-sso', 'webhooks'])

function invariant(condition, message) {
  if (!condition) throw new TypeError(message)
}

async function readRequired(file) {
  invariant(existsSync(file), `missing dist artifact ${path.relative(DIST_ROOT, file)}`)
  return readFile(file, 'utf8')
}

function routeFile(pathname, filename) {
  return path.join(DIST_ROOT, ...pathname.split('/').filter(Boolean), filename)
}

function localePrefix(segment) {
  return segment === '' ? '' : `/${segment}`
}

function documentRoute(segment, slug) {
  const prefix = localePrefix(segment)
  if (slug === null) return prefix || '/'
  return `${prefix}/${slug}`
}

function sectionAgentPath(locale, suffix) {
  const segment = locale.segment === '' ? 'en' : locale.segment
  return `/${segment}/${suffix}`
}

async function listFiles(directory) {
  const files = []
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile()) files.push(target)
    }
  }
  await visit(directory)
  return files
}

function parsePublicDocRegistry(source) {
  const match = /export const PUBLIC_DOC_SLUGS = \[([\s\S]*?)\] as const/.exec(source)
  invariant(match, 'shared public docs registry is unreadable')
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1])
}

function extractXmlLocations(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((entry) => entry[1])
}

function normalizePublishedUrl(url) {
  const parsed = new URL(url)
  return parsed.pathname === '/' ? `${parsed.origin}/` : parsed.href
}

function splitFrontmatter(source, label) {
  invariant(source.startsWith('---\n'), `${label} has no frontmatter`)
  const closing = source.indexOf('\n---\n', 4)
  invariant(closing >= 0, `${label} has unterminated frontmatter`)
  return {
    frontmatter: source.slice(4, closing),
    body: source.slice(closing + 5),
  }
}

function hasFrontmatterField(frontmatter, field) {
  return new RegExp(`^${field}:`, 'm').test(frontmatter)
}

function generatedSourceFile(locale, slug) {
  const localeParts = locale === 'en' ? [] : [locale]
  if (slug === null) {
    return path.join(GENERATED_DOCS_ROOT, ...localeParts, 'index.mdx')
  }
  const slugParts = slug.split('/')
  const leaf = `${slugParts.pop()}.mdx`
  return path.join(GENERATED_DOCS_ROOT, ...localeParts, ...slugParts, leaf)
}

function countOccurrences(source, pattern) {
  return source.split(pattern).length - 1
}

function extractRelativeLinks(html) {
  return [...html.matchAll(/href="(\/[^"]*)"/gu)].map((match) => {
    const value = match[1]
    const end = value.search(/[?#]/u)
    const pathname = end === -1 ? value : value.slice(0, end)
    return pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname
  })
}

function assertPublishedHtmlMetadata(html, route) {
  const canonicalPath = route === '/' ? '/' : route.replace(/\/+$/u, '')
  const canonical = new URL(canonicalPath, SITE_ORIGIN).href
  invariant(/<title>[^<]+<\/title>/.test(html), `${route} has no title`)
  invariant(/<meta name="description" content="[^"]+"/.test(html), `${route} has no description`)
  invariant(
    html.includes(`<link rel="canonical" href="${canonical}"`),
    `${route} canonical is incorrect`,
  )
  for (const property of [
    'og:title',
    'og:type',
    'og:site_name',
    'og:locale',
    'og:description',
    'og:url',
    'og:image',
  ]) {
    invariant(html.includes(`<meta property="${property}"`), `${route} has no ${property}`)
  }
  invariant(
    !html.includes('<meta name="robots" content="noindex"'),
    `${route} unexpectedly emits noindex`,
  )
  const structuredDataMatch = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)
  invariant(structuredDataMatch, `${route} has no JSON-LD`)
  const structuredData = JSON.parse(structuredDataMatch[1])
  const structuredNodes = Array.isArray(structuredData['@graph'])
    ? structuredData['@graph']
    : [structuredData]
  const expectedType = route === '/' ? 'WebSite' : 'WebPage'
  const typedNode = structuredNodes.find((node) => node?.['@type'] === expectedType)
  invariant(typedNode, `${route} JSON-LD type is incorrect`)
  invariant(typedNode.url === canonical, `${route} JSON-LD URL is incorrect`)
  invariant(
    (typeof typedNode.inLanguage === 'string' && typedNode.inLanguage.length > 0) ||
      (Array.isArray(typedNode.inLanguage) && typedNode.inLanguage.length > 0),
    `${route} JSON-LD has no language`,
  )
}

async function audit() {
  const [
    documentsSource,
    registrySource,
    wranglerSource,
    contentConfigSource,
    generatorSource,
    sitePackageSource,
    publicHeaders,
    distHeaders,
    agentInstructions,
  ] = await Promise.all([
    readFile(path.join(SITE_ROOT, 'src/content-source/docs/documents.json'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'packages/types/src/public-docs.ts'), 'utf8'),
    readFile(path.join(SITE_ROOT, 'wrangler.jsonc'), 'utf8'),
    readFile(path.join(SITE_ROOT, 'src/content.config.ts'), 'utf8'),
    readFile(path.join(SITE_ROOT, 'scripts/generate-localized-content.mjs'), 'utf8'),
    readFile(path.join(SITE_ROOT, 'package.json'), 'utf8'),
    readFile(path.join(SITE_ROOT, 'public/_headers'), 'utf8'),
    readRequired(path.join(DIST_ROOT, '_headers')),
    readFile(path.join(SITE_ROOT, 'AGENT.md'), 'utf8'),
  ])
  const documents = JSON.parse(documentsSource)
  const sitePackage = JSON.parse(sitePackageSource)
  const registrySlugs = parsePublicDocRegistry(registrySource)
  const astSlugs = documents.documents.map((document) => document.slug)

  invariant(documents.locales.length === 8, 'documents.json must contain 8 locales')
  invariant(astSlugs.length === 40, 'documents.json must contain 40 public docs')
  invariant(
    Array.isArray(documents.hub.sections) && documents.hub.sections.length >= 3,
    'documentation hub must contain product, capability, and quick-start sections',
  )
  invariant(
    JSON.stringify(astSlugs) === JSON.stringify(registrySlugs),
    'documents.json and shared public docs registry differ',
  )
  invariant(
    /"not_found_handling"\s*:\s*"404-page"/.test(wranglerSource),
    'static assets must use 404-page handling',
  )
  invariant(
    /"html_handling"\s*:\s*"drop-trailing-slash"/.test(wranglerSource),
    'static assets must preserve the no-trailing-slash canonical contract',
  )
  invariant(
    contentConfigSource.includes('base: "generated/docs"'),
    'Astro docs collection must be isolated to generated/docs',
  )
  invariant(
    !generatorSource.includes(LEGACY_CORE_DOCS_SOURCE) &&
      !generatorSource.includes("from 'typescript'") &&
      !generatorSource.includes('from "typescript"'),
    'localized generation must not read historical Core docs sources',
  )
  invariant(
    sitePackage.scripts?.build ===
      'astro build && node scripts/generate-localized-404s.mjs && node scripts/audit-dist-routes.mjs',
    'Site build must audit Nimbus output without a marketing twin postprocessor',
  )
  invariant(
    publicHeaders === REQUIRED_STATIC_HEADERS && distHeaders === REQUIRED_STATIC_HEADERS,
    'public and dist _headers must define the exact Markdown, MDX, and text types',
  )
  invariant(
    agentInstructions.includes('pnpm-lock.yaml') && agentInstructions.includes('Do not generate'),
    'AGENT.md must define the single-lockfile contract',
  )
  for (const lockfile of [
    'package-lock.json',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'pnpm-lock.yaml',
  ]) {
    invariant(
      !existsSync(path.join(SITE_ROOT, lockfile)),
      `Site package must not contain a second lockfile ${lockfile}`,
    )
  }

  const routeLocale = new Map()
  for (const locale of LOCALES) {
    routeLocale.set(documentRoute(locale.segment, null), locale.locale)
    for (const slug of astSlugs) {
      routeLocale.set(documentRoute(locale.segment, slug), locale.locale)
    }
  }

  const expectedCorpusUrls = new Set()
  const expectedPublishedUrls = new Set()
  const expectedMarkdownUrls = new Set()
  let htmlCount = 0
  let markdownCount = 0
  let mdxCount = 0
  let mermaidPageCount = 0
  let localeScopedNavigationCount = 0
  let localized404Count = 0

  for (const locale of LOCALES) {
    const pages = [
      { route: documentRoute(locale.segment, null), slug: null },
      ...astSlugs.map((slug) => ({
        route: documentRoute(locale.segment, slug),
        slug,
      })),
    ]
    const sectionLlmsIndexPath = sectionAgentPath(locale, 'llms.txt')
    const sectionLlmsFullPath = sectionAgentPath(locale, 'llms-full.txt')

    for (const page of pages) {
      const { route, slug } = page
      const authoredSourcePath = generatedSourceFile(locale.locale, slug)
      const [html, markdown, mdx, authoredSource] = await Promise.all([
        readRequired(routeFile(route, 'index.html')),
        readRequired(routeFile(route, 'index.md')),
        readRequired(routeFile(route, 'index.mdx')),
        readFile(authoredSourcePath, 'utf8'),
      ])
      const canonicalRoute = route === '/' ? '/' : route
      const pageUrl = new URL(canonicalRoute, SITE_ORIGIN).href
      const markdownUrl = new URL(route === '/' ? '/index.md' : `${route}/index.md`, SITE_ORIGIN)
        .href
      const sourceUrl = new URL(route === '/' ? '/index.mdx' : `${route}/index.mdx`, SITE_ORIGIN)
        .href
      const authoredParts = splitFrontmatter(
        authoredSource,
        path.relative(SITE_ROOT, authoredSourcePath),
      )
      const markdownParts = splitFrontmatter(markdown, `${route}/index.md`)
      const mdxParts = splitFrontmatter(mdx, `${route}/index.mdx`)

      expectedCorpusUrls.add(pageUrl)
      expectedPublishedUrls.add(pageUrl)
      expectedMarkdownUrls.add(markdownUrl)
      invariant(
        html.includes(`lang="${locale.locale}"`),
        `${route} does not use BCP locale ${locale.locale}`,
      )
      assertPublishedHtmlMetadata(html, route)
      invariant(html.includes('data-pagefind-body'), `${route} is absent from Pagefind`)
      invariant(
        html.includes(`type="text/markdown" href="${markdownUrl}"`),
        `${route} does not expose its Markdown alternate`,
      )
      invariant(
        !html.includes('component-url="/src/react/') &&
          !html.includes('SiteApp') &&
          !html.includes('xid-home-source'),
        `${route} still contains the marketing React runtime`,
      )
      for (const href of extractRelativeLinks(html)) {
        const linkedLocale = routeLocale.get(href)
        invariant(
          !linkedLocale || linkedLocale === locale.locale,
          `${route} navigation leaks locale ${linkedLocale} through ${href}`,
        )
      }
      localeScopedNavigationCount += 1
      invariant(
        markdown.trimEnd().endsWith(`Source: ${sourceUrl}`),
        `${route} Markdown does not point to its MDX twin`,
      )
      invariant(
        mdx.includes(`locale: ${JSON.stringify(locale.locale)}`),
        `${route} MDX locale metadata is incorrect`,
      )
      invariant(
        markdown.includes(renderEntryAsMarkdown({ body: authoredSource }).trim()),
        `${route} Markdown is not the localized downlevel of its authored source`,
      )
      invariant(
        mdxParts.body.trim() === authoredParts.body.trim(),
        `${route} MDX twin is not the generated raw authored source`,
      )
      if (slug !== null && MERMAID_DOC_SLUGS.has(slug)) {
        for (const [surface, source] of [
          ['generated raw MDX', authoredSource],
          ['published MDX twin', mdx],
          ['downleveled Markdown twin', markdown],
        ]) {
          invariant(
            countOccurrences(source, '```mermaid') === 1,
            `${route} ${surface} must retain one Mermaid fence`,
          )
        }
        invariant(
          countOccurrences(html, '<pre class="mermaid">') === 1,
          `${route} HTML must contain one pre.mermaid element`,
        )
        mermaidPageCount += 1
      }
      for (const [label, frontmatter] of [
        [`${route}/index.md`, markdownParts.frontmatter],
        [`${route}/index.mdx`, mdxParts.frontmatter],
        [path.relative(SITE_ROOT, authoredSourcePath), authoredParts.frontmatter],
      ]) {
        invariant(
          !hasFrontmatterField(frontmatter, 'version'),
          `${label} fabricates version frontmatter`,
        )
        invariant(
          !hasFrontmatterField(frontmatter, 'draft') &&
            !hasFrontmatterField(frontmatter, 'noindex'),
          `${label} is draft or noindex but entered the public collection`,
        )
      }
      for (const url of [pageUrl, markdownUrl, sourceUrl]) {
        invariant(
          resolveWebRouteOwnership(url).owner === 'site',
          `${url} is not owned by the Site Worker`,
        )
      }
      htmlCount += 1
      markdownCount += 1
      mdxCount += 1
    }

    const [sectionLlmsIndex, sectionLlmsFull] = await Promise.all([
      readRequired(path.join(DIST_ROOT, sectionLlmsIndexPath.slice(1))),
      readRequired(path.join(DIST_ROOT, sectionLlmsFullPath.slice(1))),
    ])
    for (const page of pages) {
      const route = page.route
      const markdownPath = route === '/' ? '/index.md' : `${route}/index.md`
      const corpusPath = route
      const markdownUrl = new URL(markdownPath, SITE_ORIGIN).href
      invariant(
        sectionLlmsIndex.includes(markdownUrl),
        `${sectionLlmsIndexPath} is missing ${route}`,
      )
      invariant(
        sectionLlmsFull.includes(`<!-- xid-doc-path: ${corpusPath} -->`),
        `${sectionLlmsFullPath} is missing corpus block ${route}`,
      )
    }
    invariant(
      countOccurrences(sectionLlmsIndex, '/index.md)') === 41,
      `${sectionLlmsIndexPath} must contain exactly 41 Markdown twins`,
    )
    invariant(
      countOccurrences(sectionLlmsFull, '<!-- xid-doc-path:') === 41,
      `${sectionLlmsFullPath} must contain exactly 41 corpus blocks`,
    )
    invariant(
      !/^Generated(?: at| on):/im.test(sectionLlmsFull) &&
        !/^Build timestamp:/im.test(sectionLlmsFull),
      `${sectionLlmsFullPath} contains a generation timestamp`,
    )
    for (const other of LOCALES) {
      if (other.locale === locale.locale) continue
      const otherHub = documentRoute(other.segment, null)
      const otherHubPath = otherHub
      const otherMarkdownPath = otherHub === '/' ? '/index.md' : `${otherHub}/index.md`
      invariant(
        !sectionLlmsIndex.includes(new URL(otherMarkdownPath, SITE_ORIGIN).href),
        `${sectionLlmsIndexPath} contains another locale hub`,
      )
      invariant(
        !sectionLlmsFull.includes(`<!-- xid-doc-path: ${otherHubPath} -->`),
        `${sectionLlmsFullPath} contains another locale corpus`,
      )
    }
  }

  invariant(htmlCount === 328, `expected 328 docs HTML files, received ${htmlCount}`)
  invariant(markdownCount === 328, `expected 328 docs Markdown twins, received ${markdownCount}`)
  invariant(mdxCount === 328, `expected 328 docs MDX twins, received ${mdxCount}`)
  invariant(
    mermaidPageCount === MERMAID_DOC_SLUGS.size * LOCALES.length,
    `expected 32 localized Mermaid pages, received ${mermaidPageCount}`,
  )

  const generatedMdxFiles = (await listFiles(GENERATED_DOCS_ROOT)).filter((file) =>
    file.endsWith('.mdx'),
  )
  invariant(
    generatedMdxFiles.length === 328,
    `generated collection must contain exactly 328 MDX files, received ${generatedMdxFiles.length}`,
  )
  invariant(
    generatedMdxFiles.every(
      (file) => !path.relative(GENERATED_DOCS_ROOT, file).split(path.sep).includes('docs'),
    ),
    'generated collection still contains a docs URL segment',
  )

  const distFiles = await listFiles(DIST_ROOT)
  const allMarkdownTwins = distFiles.filter((file) => path.basename(file) === 'index.md')
  const allMdxTwins = distFiles.filter((file) => path.basename(file) === 'index.mdx')
  invariant(
    allMarkdownTwins.length === 328,
    `dist must contain 328 Markdown twins, received ${allMarkdownTwins.length}`,
  )
  invariant(
    allMdxTwins.length === 328,
    `dist must contain 328 MDX twins, received ${allMdxTwins.length}`,
  )
  invariant(
    !existsSync(path.join(DIST_ROOT, 'docs')),
    'dist must not publish a canonical docs directory',
  )
  invariant(
    !distFiles.some((file) => file.includes(`${path.sep}src${path.sep}react${path.sep}`)),
    'dist contains a Site React runtime artifact',
  )

  const [globalLlmsIndex, globalLlmsFull] = await Promise.all([
    readRequired(path.join(DIST_ROOT, 'llms.txt')),
    readRequired(path.join(DIST_ROOT, 'llms-full.txt')),
  ])
  for (const markdownUrl of expectedMarkdownUrls) {
    invariant(globalLlmsIndex.includes(markdownUrl), `root llms.txt is missing ${markdownUrl}`)
  }
  for (const pageUrl of expectedCorpusUrls) {
    const pathname = new URL(pageUrl).pathname
    invariant(
      globalLlmsFull.includes(`<!-- xid-doc-path: ${pathname} -->`),
      `root llms-full.txt is missing ${pathname}`,
    )
  }
  invariant(
    countOccurrences(globalLlmsIndex, '/index.md)') === 328,
    'root llms.txt must enumerate exactly 328 Markdown twins',
  )
  invariant(
    countOccurrences(globalLlmsFull, '<!-- xid-doc-path:') === 328,
    'root llms-full.txt must contain exactly 328 corpus blocks',
  )
  invariant(
    !/\]\(https:\/\/xid\.dev\/(?:zh-hans\/|ja\/|ko\/|fr\/|de\/|es\/|pt-br\/)?docs(?:\/|\))/u.test(
      globalLlmsIndex,
    ),
    'root llms.txt contains a legacy docs canonical link',
  )
  invariant(
    !/^Generated(?: at| on):/im.test(globalLlmsFull) && !/^Build timestamp:/im.test(globalLlmsFull),
    'root llms-full.txt must not contain generation timestamps',
  )

  const distTopLevelNames = new Set(await readdir(DIST_ROOT))
  invariant(
    !distTopLevelNames.has('zh-Hans') && distTopLevelNames.has('zh-hans'),
    'dist route segment must be lowercase zh-hans',
  )
  invariant(
    !distTopLevelNames.has('pt-BR') && distTopLevelNames.has('pt-br'),
    'dist route segment must be lowercase pt-br',
  )

  const pagefind = JSON.parse(
    await readRequired(path.join(DIST_ROOT, 'pagefind/pagefind-entry.json')),
  )
  const expectedPagefindLocales = LOCALES.map((entry) => entry.segment || 'en').sort()
  const actualPagefindLocales = Object.keys(pagefind.languages).sort()
  invariant(
    JSON.stringify(actualPagefindLocales) === JSON.stringify(expectedPagefindLocales),
    'Pagefind locale index differs from the 8 documentation locales',
  )
  const pagefindCount = Object.values(pagefind.languages).reduce(
    (total, language) => total + language.page_count,
    0,
  )
  invariant(pagefindCount === 328, `Pagefind must index 328 docs, received ${pagefindCount}`)
  invariant(
    Object.values(pagefind.languages).every((language) => language.page_count === 41),
    'Pagefind must index one hub plus 40 pages for every locale',
  )
  const pagefindFragments = (await listFiles(path.join(DIST_ROOT, 'pagefind/fragment'))).filter(
    (file) => file.endsWith('.pf_fragment'),
  )
  invariant(
    pagefindFragments.length === 328,
    `Pagefind must emit 328 fragments, received ${pagefindFragments.length}`,
  )

  const [sitemap, sitemapIndex, sitemapPart, robots] = await Promise.all([
    readRequired(path.join(DIST_ROOT, 'sitemap.xml')),
    readRequired(path.join(DIST_ROOT, 'sitemap-index.xml')),
    readRequired(path.join(DIST_ROOT, 'sitemap-0.xml')),
    readRequired(path.join(DIST_ROOT, 'robots.txt')),
  ])
  const sitemapLocations = new Set(extractXmlLocations(sitemap).map(normalizePublishedUrl))
  const nimbusSitemapLocations = new Set(
    extractXmlLocations(sitemapPart).map(normalizePublishedUrl),
  )
  invariant(
    sitemapLocations.size === 328,
    `compatibility sitemap must contain 328 docs, received ${sitemapLocations.size}`,
  )
  invariant(
    sitemapLocations.size === expectedPublishedUrls.size &&
      [...expectedPublishedUrls].every((url) => sitemapLocations.has(url)),
    'compatibility sitemap differs from the published HTML set',
  )
  invariant(
    nimbusSitemapLocations.size === expectedPublishedUrls.size &&
      [...expectedPublishedUrls].every((url) => nimbusSitemapLocations.has(url)),
    'Nimbus sitemap differs from the published HTML set',
  )
  invariant(
    ![...sitemapLocations].some((url) => new URL(url).pathname.includes('/docs/')),
    'sitemap contains a legacy docs canonical',
  )
  invariant(
    sitemapIndex.includes(`${SITE_ORIGIN}/sitemap-0.xml`),
    'Nimbus sitemap index does not reference sitemap-0.xml',
  )
  invariant(
    robots.includes(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`),
    'robots.txt does not reference compatibility sitemap.xml',
  )
  invariant(
    !existsSync(path.join(DIST_ROOT, '.well-known/llms.txt')),
    'Site dist must not claim Core-owned .well-known/llms.txt',
  )

  for (const [source, target] of Object.entries(LEGACY_ALIASES)) {
    for (const locale of LOCALES) {
      const prefix = localePrefix(locale.segment)
      const localizedSource = `${prefix}${source}`
      const localizedTarget = `${prefix}${target}`
      invariant(
        !existsSync(routeFile(localizedSource, 'index.html')),
        `alias source emitted duplicate HTML ${localizedSource}`,
      )
      invariant(
        existsSync(routeFile(localizedTarget, 'index.html')),
        `alias target is missing ${localizedTarget}`,
      )
    }
  }

  for (const slug of INTERNAL_DOC_SLUGS) {
    for (const locale of LOCALES) {
      const prefix = localePrefix(locale.segment)
      for (const candidate of [`${prefix}/${slug}`, `${prefix}/docs/${slug}`]) {
        invariant(
          !existsSync(routeFile(candidate, 'index.html')),
          `internal docs path leaked into dist ${candidate}`,
        )
        const absolute = new URL(candidate, SITE_ORIGIN).href
        invariant(
          !sitemapLocations.has(`${absolute}/`) && !sitemapLocations.has(absolute),
          `internal docs path leaked into sitemap ${candidate}`,
        )
      }
    }
  }

  for (const pathname of CORE_RESERVED_PATHS) {
    invariant(
      resolveWebRouteOwnership(new URL(pathname, SITE_ORIGIN)).owner === 'core',
      `${pathname} is not owned by Core`,
    )
  }
  invariant(
    resolveWebRouteOwnership(new URL('/scim', SITE_ORIGIN)).owner === 'site' &&
      resolveWebRouteOwnership(new URL('/scim/', SITE_ORIGIN)).owner === 'site' &&
      resolveWebRouteOwnership(new URL('/scim/index.md', SITE_ORIGIN)).owner === 'site' &&
      resolveWebRouteOwnership(new URL('/scim/index.mdx', SITE_ORIGIN)).owner === 'site',
    'SCIM documentation exact route ownership is incomplete',
  )

  for (const locale of LOCALES) {
    const notFoundPath =
      locale.segment === ''
        ? path.join(DIST_ROOT, '404.html')
        : path.join(DIST_ROOT, locale.segment, '404.html')
    const notFoundHtml = await readRequired(notFoundPath)
    invariant(
      notFoundHtml.includes(`<html lang="${locale.locale}"`),
      `${notFoundPath} does not use locale ${locale.locale}`,
    )
    invariant(
      /<meta name="robots" content="noindex"/.test(notFoundHtml),
      `${notFoundPath} must be noindex`,
    )
    localized404Count += 1
  }
  invariant(localized404Count === LOCALES.length, 'localized 404 page count mismatch')

  return {
    status: 'PASS',
    locales: LOCALES.length,
    documentsPerLocale: astSlugs.length,
    publishedHtml: htmlCount,
    markdownTwins: allMarkdownTwins.length,
    mdxTwins: allMdxTwins.length,
    globalAgentPages: expectedMarkdownUrls.size,
    localeAgentIndexes: LOCALES.length,
    localeAgentPages: 41,
    pagefindPages: pagefindCount,
    sitemapUrls: sitemapLocations.size,
    contentTypeRules: 3,
    mermaidPages: mermaidPageCount,
    localeScopedNavigationPages: localeScopedNavigationCount,
    localized404Pages: localized404Count,
    legacyAliases: Object.keys(LEGACY_ALIASES).length * LOCALES.length,
  }
}

try {
  process.stdout.write(`${JSON.stringify(await audit(), null, 2)}\n`)
} catch (error) {
  process.stderr.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
