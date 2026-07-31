import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderEntryAsMarkdown } from '@cloudflare/nimbus-docs'
import { hasGeneratedDocsBase } from '../src/lib/content-config-contract.ts'

const SITE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const GENERATED_DOCS_ROOT = path.join(SITE_ROOT, 'src/content/generated/docs')
const SITE_SHELL_MESSAGES_FILE = path.join(SITE_ROOT, 'src/lib/site-shell-messages.ts')
const I18N_CATALOG_ROOT = path.join(REPOSITORY_ROOT, 'packages/i18n/locales')
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
  { locale: 'en', segment: '', openGraphLocale: 'en_US' },
  { locale: 'zh-Hans', segment: 'zh-hans', openGraphLocale: 'zh_CN' },
  { locale: 'ja', segment: 'ja', openGraphLocale: 'ja_JP' },
  { locale: 'ko', segment: 'ko', openGraphLocale: 'ko_KR' },
  { locale: 'fr', segment: 'fr', openGraphLocale: 'fr_FR' },
  { locale: 'de', segment: 'de', openGraphLocale: 'de_DE' },
  { locale: 'es', segment: 'es', openGraphLocale: 'es_ES' },
  { locale: 'pt-BR', segment: 'pt-br', openGraphLocale: 'pt_BR' },
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

function contentSectionAgentPath(locale, section, suffix) {
  return `${localePrefix(locale.segment)}/${section}/${suffix}`
}

function pageAgentIndexPath(locale, slug) {
  return slug !== null && (slug === 'sdks' || slug.startsWith('sdks/'))
    ? contentSectionAgentPath(locale, 'sdks', 'llms.txt')
    : sectionAgentPath(locale, 'llms.txt')
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

function ogRouteFile(locale, slug) {
  const localeParts = locale.segment === '' ? [] : [locale.segment]
  return path.join(DIST_ROOT, 'og', ...localeParts, ...slug.split('/')) + '.png'
}

function countOccurrences(source, pattern) {
  return source.split(pattern).length - 1
}

function linguiMessageId(message, context = '') {
  return createHash('sha256').update(`${message}\u001f${context}`).digest('base64url').slice(0, 6)
}

function parseSiteShellMessageIds(source) {
  const messages = [...source.matchAll(/\bmsg`([^`]*)`/gu)].map((match) => match[1])
  invariant(messages.length > 0, 'site shell message descriptors are unreadable')
  return new Map(messages.map((message) => [linguiMessageId(message), message]))
}

function containsStandaloneMessageId(source, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`, 'u').test(source)
}

async function loadSiteShellCatalogs(messageIds) {
  const catalogs = new Map()
  for (const locale of LOCALES) {
    const catalogFile = path.join(I18N_CATALOG_ROOT, locale.locale, 'messages.mjs')
    const module = await import(`${pathToFileURL(catalogFile).href}?audit=${Date.now()}`)
    for (const [id, message] of messageIds) {
      invariant(
        Object.hasOwn(module.messages, id),
        `${locale.locale} compiled catalog is missing Site shell message ${JSON.stringify(message)}`,
      )
    }
    catalogs.set(locale.locale, module.messages)
  }
  return catalogs
}

function findSingleTag(html, tagName, attribute, value, route) {
  const tags = [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, 'gu'))]
    .map((match) => match[0])
    .filter((tag) => tag.includes(`${attribute}="${value}"`))
  invariant(tags.length === 1, `${route} must have exactly one ${tagName} ${attribute}=${value}`)
  return tags[0]
}

function attributeValue(tag, attribute, route) {
  const match = new RegExp(`${attribute}="([^"]*)"`, 'u').exec(tag)
  invariant(match, `${route} ${tag} has no ${attribute}`)
  return match[1]
}

function extractRelativeLinks(html) {
  return [...html.matchAll(/href="(\/[^"]*)"/gu)].map((match) => {
    const value = match[1]
    const end = value.search(/[?#]/u)
    const pathname = end === -1 ? value : value.slice(0, end)
    return pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname
  })
}

function assertPublishedHtmlMetadata(html, route, locale, { indexable = true } = {}) {
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
    'og:description',
    'og:url',
    'og:image',
  ]) {
    invariant(html.includes(`<meta property="${property}"`), `${route} has no ${property}`)
  }
  const ogLocaleTag = findSingleTag(html, 'meta', 'property', 'og:locale', route)
  invariant(
    attributeValue(ogLocaleTag, 'content', route) === locale.openGraphLocale,
    `${route} Open Graph locale is incorrect`,
  )
  const ogTitle = attributeValue(
    findSingleTag(html, 'meta', 'property', 'og:title', route),
    'content',
    route,
  )
  const ogDescription = attributeValue(
    findSingleTag(html, 'meta', 'property', 'og:description', route),
    'content',
    route,
  )
  const ogImageAlt = attributeValue(
    findSingleTag(html, 'meta', 'property', 'og:image:alt', route),
    'content',
    route,
  )
  const twitterImageAlt = attributeValue(
    findSingleTag(html, 'meta', 'name', 'twitter:image:alt', route),
    'content',
    route,
  )
  invariant(ogImageAlt.length > 0, `${route} Open Graph image alt is empty`)
  invariant(ogImageAlt === twitterImageAlt, `${route} Open Graph and Twitter image alt differ`)
  invariant(
    ogImageAlt === `${ogTitle}. ${ogDescription}`,
    `${route} social image alt does not match localized page metadata`,
  )
  if (indexable) {
    const llmsIndexTag = findSingleTag(html, 'link', 'type', 'text/plain', route)
    const expectedLlmsIndex = new URL(sectionAgentPath(locale, 'llms.txt'), SITE_ORIGIN).href
    invariant(
      attributeValue(llmsIndexTag, 'href', route) === expectedLlmsIndex,
      `${route} agent index alternate is incorrect`,
    )
    invariant(
      !html.includes('<meta name="robots" content="noindex"'),
      `${route} unexpectedly emits noindex`,
    )
  } else {
    invariant(html.includes('<meta name="robots" content="noindex"'), `${route} must emit noindex`)
    invariant(
      !html.includes('<link rel="alternate" type="text/plain"'),
      `${route} must not expose an agent index alternate`,
    )
  }
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
  invariant(typedNode.inLanguage === locale.locale, `${route} JSON-LD language is incorrect`)
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
    siteShellMessagesSource,
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
    readFile(SITE_SHELL_MESSAGES_FILE, 'utf8'),
  ])
  const documents = JSON.parse(documentsSource)
  const sitePackage = JSON.parse(sitePackageSource)
  const siteShellMessageIds = parseSiteShellMessageIds(siteShellMessagesSource)
  const siteShellCatalogs = await loadSiteShellCatalogs(siteShellMessageIds)
  const registrySlugs = parsePublicDocRegistry(registrySource)
  const astDocuments = documents.documents
  const publishedDocuments = astDocuments.filter((document) => document.draft !== true)
  const agentDocuments = publishedDocuments.filter((document) => document.noindex !== true)
  const noindexDocuments = publishedDocuments.filter((document) => document.noindex === true)
  const draftDocuments = astDocuments.filter((document) => document.draft === true)
  const astSlugs = astDocuments.map((document) => document.slug)
  const agentSlugs = agentDocuments.map((document) => document.slug)

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
    hasGeneratedDocsBase(contentConfigSource),
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
  const draftRoutes = new Set()
  for (const locale of LOCALES) {
    routeLocale.set(documentRoute(locale.segment, null), locale.locale)
    routeLocale.set(documentRoute(locale.segment, 'status'), locale.locale)
    for (const slug of publishedDocuments.map((document) => document.slug)) {
      routeLocale.set(documentRoute(locale.segment, slug), locale.locale)
    }
    for (const document of draftDocuments) {
      draftRoutes.add(documentRoute(locale.segment, document.slug))
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
      { route: documentRoute(locale.segment, null), slug: null, document: null, indexable: true },
      ...publishedDocuments.map((document) => ({
        route: documentRoute(locale.segment, document.slug),
        slug: document.slug,
        document,
        indexable: document.noindex !== true,
      })),
    ]
    const agentPages = pages.filter((page) => page.indexable)
    const sectionLlmsIndexPath = sectionAgentPath(locale, 'llms.txt')
    const sectionLlmsFullPath = sectionAgentPath(locale, 'llms-full.txt')
    const sdkSlugs = agentSlugs.filter((slug) => slug === 'sdks' || slug.startsWith('sdks/'))
    const sdkLlmsIndexPath = contentSectionAgentPath(locale, 'sdks', 'llms.txt')
    const sdkLlmsFullPath = contentSectionAgentPath(locale, 'sdks', 'llms-full.txt')

    for (const page of pages) {
      const { route, slug, document, indexable } = page
      const authoredSourcePath = generatedSourceFile(locale.locale, slug)
      const [html, authoredSource] = await Promise.all([
        readRequired(routeFile(route, 'index.html')),
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

      invariant(
        html.includes(`lang="${locale.locale}"`),
        `${route} does not use BCP locale ${locale.locale}`,
      )
      assertPublishedHtmlMetadata(html, route, locale, { indexable })
      invariant(
        !html.includes('component-url="/src/react/') &&
          !html.includes('SiteApp') &&
          !html.includes('xid-home-source'),
        `${route} still contains the marketing React runtime`,
      )
      for (const href of extractRelativeLinks(html)) {
        invariant(!draftRoutes.has(href), `${route} links to unpublished draft ${href}`)
        const linkedLocale = routeLocale.get(href)
        invariant(
          !linkedLocale || linkedLocale === locale.locale,
          `${route} navigation leaks locale ${linkedLocale} through ${href}`,
        )
      }
      localeScopedNavigationCount += 1

      let markdown
      let mdx
      let markdownParts
      let mdxParts
      if (indexable) {
        const twins = await Promise.all([
          readRequired(routeFile(route, 'index.md')),
          readRequired(routeFile(route, 'index.mdx')),
        ])
        markdown = twins[0]
        mdx = twins[1]
        markdownParts = splitFrontmatter(markdown, `${route}/index.md`)
        mdxParts = splitFrontmatter(mdx, `${route}/index.mdx`)
        expectedCorpusUrls.add(pageUrl)
        expectedPublishedUrls.add(pageUrl)
        expectedMarkdownUrls.add(markdownUrl)
        invariant(html.includes('data-pagefind-body'), `${route} is absent from Pagefind`)
        invariant(
          html.includes(`type="text/markdown" href="${markdownUrl}"`),
          `${route} does not expose its Markdown alternate`,
        )
        invariant(
          markdown.trimEnd().endsWith(`Source: ${sourceUrl}`),
          `${route} Markdown does not point to its MDX twin`,
        )
        invariant(
          markdown.includes(
            `> Fetch the relevant documentation index at: ${new URL(pageAgentIndexPath(locale, slug), SITE_ORIGIN).href}`,
          ),
          `${route} Markdown does not point to its most specific agent index`,
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
          mdx === authoredSource,
          `${route} MDX twin is not byte-identical to the generated authored source`,
        )
        markdownCount += 1
        mdxCount += 1
      } else {
        invariant(
          html.includes('data-pagefind-ignore') && !html.includes('data-pagefind-body'),
          `${route} noindex page must be excluded from Pagefind`,
        )
        invariant(
          !html.includes('type="text/markdown"'),
          `${route} noindex page must not expose a Markdown alternate`,
        )
        invariant(
          !existsSync(routeFile(route, 'index.md')) && !existsSync(routeFile(route, 'index.mdx')),
          `${route} noindex page must not publish Markdown twins`,
        )
      }
      if (slug !== null && MERMAID_DOC_SLUGS.has(slug)) {
        const surfaces = [
          ['generated raw MDX', authoredSource],
          ...(indexable
            ? [
                ['published MDX twin', mdx],
                ['downleveled Markdown twin', markdown],
              ]
            : []),
        ]
        for (const [surface, source] of surfaces) {
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
      const publishedFrontmatters = indexable
        ? [
            [`${route}/index.md`, markdownParts.frontmatter],
            [`${route}/index.mdx`, mdxParts.frontmatter],
          ]
        : []
      for (const [label, frontmatter] of publishedFrontmatters) {
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
      invariant(
        !hasFrontmatterField(authoredParts.frontmatter, 'version'),
        `${path.relative(SITE_ROOT, authoredSourcePath)} fabricates version frontmatter`,
      )
      invariant(
        hasFrontmatterField(authoredParts.frontmatter, 'draft') === (document?.draft === true) &&
          hasFrontmatterField(authoredParts.frontmatter, 'noindex') ===
            (document?.noindex === true),
        `${path.relative(SITE_ROOT, authoredSourcePath)} publication frontmatter differs from documents.json`,
      )
      htmlCount += 1
    }

    for (const document of draftDocuments) {
      const route = documentRoute(locale.segment, document.slug)
      invariant(
        !existsSync(routeFile(route, 'index.html')) &&
          !existsSync(routeFile(route, 'index.md')) &&
          !existsSync(routeFile(route, 'index.mdx')) &&
          !existsSync(ogRouteFile(locale, document.slug)),
        `${route} draft must not be published in production`,
      )
    }

    const statusRoute = documentRoute(locale.segment, 'status')
    const statusMarkdownUrl = new URL(`${statusRoute}/index.md`, SITE_ORIGIN).href
    const statusSourceUrl = new URL(`${statusRoute}/index.mdx`, SITE_ORIGIN).href
    const statusPageUrl = new URL(statusRoute, SITE_ORIGIN).href
    const [statusHtml, statusMarkdown, statusMdx] = await Promise.all([
      readRequired(routeFile(statusRoute, 'index.html')),
      readRequired(routeFile(statusRoute, 'index.md')),
      readRequired(routeFile(statusRoute, 'index.mdx')),
    ])
    const statusMarkdownParts = splitFrontmatter(statusMarkdown, `${statusRoute}/index.md`)
    const statusMdxParts = splitFrontmatter(statusMdx, `${statusRoute}/index.mdx`)
    expectedCorpusUrls.add(statusPageUrl)
    expectedPublishedUrls.add(statusPageUrl)
    expectedMarkdownUrls.add(statusMarkdownUrl)
    invariant(
      statusHtml.includes(`lang="${locale.locale}"`),
      `${statusRoute} does not use BCP locale ${locale.locale}`,
    )
    assertPublishedHtmlMetadata(statusHtml, statusRoute, locale)
    invariant(statusHtml.includes('data-pagefind-body'), `${statusRoute} is absent from Pagefind`)
    invariant(
      statusHtml.includes(`type="text/markdown" href="${statusMarkdownUrl}"`),
      `${statusRoute} does not expose its Markdown alternate`,
    )
    for (const alternate of LOCALES) {
      const alternateRoute = documentRoute(alternate.segment, 'status')
      const alternateTag = findSingleTag(
        statusHtml,
        'link',
        'hreflang',
        alternate.locale,
        statusRoute,
      )
      invariant(
        attributeValue(alternateTag, 'href', statusRoute) ===
          new URL(alternateRoute, SITE_ORIGIN).href,
        `${statusRoute} hreflang ${alternate.locale} is incorrect`,
      )
    }
    invariant(
      statusMarkdown.trimEnd().endsWith(`Source: ${statusSourceUrl}`),
      `${statusRoute} Markdown does not point to its MDX twin`,
    )
    invariant(
      statusMarkdown.includes(
        `> Fetch the relevant documentation index at: ${new URL(sectionAgentPath(locale, 'llms.txt'), SITE_ORIGIN).href}`,
      ),
      `${statusRoute} Markdown does not point to its locale agent index`,
    )
    invariant(
      statusMdx.includes(`locale: ${JSON.stringify(locale.locale)}`),
      `${statusRoute} MDX locale metadata is incorrect`,
    )
    invariant(
      statusMdxParts.body.includes('<StatusSurface endpoint="/v1/public/status" />'),
      `${statusRoute} MDX source does not retain the status component contract`,
    )
    invariant(
      !hasFrontmatterField(statusMarkdownParts.frontmatter, 'version') &&
        !hasFrontmatterField(statusMdxParts.frontmatter, 'version'),
      `${statusRoute} fabricates version frontmatter`,
    )
    for (const href of extractRelativeLinks(statusHtml)) {
      invariant(!draftRoutes.has(href), `${statusRoute} links to unpublished draft ${href}`)
      const linkedLocale = routeLocale.get(href)
      invariant(
        !linkedLocale || linkedLocale === locale.locale,
        `${statusRoute} navigation leaks locale ${linkedLocale} through ${href}`,
      )
    }
    localeScopedNavigationCount += 1
    htmlCount += 1
    markdownCount += 1
    mdxCount += 1

    const [sectionLlmsIndex, sectionLlmsFull] = await Promise.all([
      readRequired(path.join(DIST_ROOT, sectionLlmsIndexPath.slice(1))),
      readRequired(path.join(DIST_ROOT, sectionLlmsFullPath.slice(1))),
    ])
    for (const page of agentPages) {
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
      countOccurrences(sectionLlmsIndex, '/index.md)') === agentPages.length + 1,
      `${sectionLlmsIndexPath} has an unexpected Markdown twin count`,
    )
    invariant(
      countOccurrences(sectionLlmsFull, '<!-- xid-doc-path:') === agentPages.length + 1,
      `${sectionLlmsFullPath} has an unexpected corpus block count`,
    )
    invariant(
      sectionLlmsIndex.includes(statusMarkdownUrl),
      `${sectionLlmsIndexPath} is missing ${statusRoute}`,
    )
    invariant(
      sectionLlmsFull.includes(`<!-- xid-doc-path: ${statusRoute} -->`),
      `${sectionLlmsFullPath} is missing ${statusRoute}`,
    )
    invariant(
      !/^Generated(?: at| on):/im.test(sectionLlmsFull) &&
        !/^Build timestamp:/im.test(sectionLlmsFull),
      `${sectionLlmsFullPath} contains a generation timestamp`,
    )
    invariant(
      sectionLlmsIndex.includes(new URL(sdkLlmsIndexPath, SITE_ORIGIN).href),
      `${sectionLlmsIndexPath} is missing its SDK section index`,
    )

    const [sdkLlmsIndex, sdkLlmsFull] = await Promise.all([
      readRequired(path.join(DIST_ROOT, sdkLlmsIndexPath.slice(1))),
      readRequired(path.join(DIST_ROOT, sdkLlmsFullPath.slice(1))),
    ])
    for (const slug of sdkSlugs) {
      const route = documentRoute(locale.segment, slug)
      const markdownUrl = new URL(`${route}/index.md`, SITE_ORIGIN).href
      invariant(sdkLlmsIndex.includes(markdownUrl), `${sdkLlmsIndexPath} is missing ${route}`)
      invariant(
        sdkLlmsFull.includes(`<!-- xid-doc-path: ${route} -->`),
        `${sdkLlmsFullPath} is missing corpus block ${route}`,
      )
    }
    invariant(
      countOccurrences(sdkLlmsIndex, '/index.md)') === sdkSlugs.length,
      `${sdkLlmsIndexPath} has an unexpected Markdown twin count`,
    )
    invariant(
      countOccurrences(sdkLlmsFull, '<!-- xid-doc-path:') === sdkSlugs.length,
      `${sdkLlmsFullPath} has an unexpected corpus block count`,
    )
    invariant(
      !/^Generated(?: at| on):/im.test(sdkLlmsFull) && !/^Build timestamp:/im.test(sdkLlmsFull),
      `${sdkLlmsFullPath} contains a generation timestamp`,
    )
    for (const slug of agentSlugs.filter(
      (candidate) => candidate !== 'sdks' && !candidate.startsWith('sdks/'),
    )) {
      const route = documentRoute(locale.segment, slug)
      invariant(
        !sdkLlmsIndex.includes(new URL(`${route}/index.md`, SITE_ORIGIN).href),
        `${sdkLlmsIndexPath} contains non-SDK page ${route}`,
      )
      invariant(
        !sdkLlmsFull.includes(`<!-- xid-doc-path: ${route} -->`),
        `${sdkLlmsFullPath} contains non-SDK corpus block ${route}`,
      )
    }
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
      for (const slug of sdkSlugs) {
        const otherRoute = documentRoute(other.segment, slug)
        invariant(
          !sdkLlmsIndex.includes(new URL(`${otherRoute}/index.md`, SITE_ORIGIN).href),
          `${sdkLlmsIndexPath} contains another locale page`,
        )
        invariant(
          !sdkLlmsFull.includes(`<!-- xid-doc-path: ${otherRoute} -->`),
          `${sdkLlmsFullPath} contains another locale corpus`,
        )
      }
    }
  }

  const expectedHtmlCount = LOCALES.length * (publishedDocuments.length + 2)
  const expectedAgentPageCount = LOCALES.length * (agentDocuments.length + 2)
  invariant(
    htmlCount === expectedHtmlCount,
    `expected ${expectedHtmlCount} HTML files, received ${htmlCount}`,
  )
  invariant(
    markdownCount === expectedAgentPageCount,
    `expected ${expectedAgentPageCount} Markdown twins, received ${markdownCount}`,
  )
  invariant(
    mdxCount === expectedAgentPageCount,
    `expected ${expectedAgentPageCount} MDX twins, received ${mdxCount}`,
  )
  invariant(
    mermaidPageCount ===
      publishedDocuments.filter((document) => MERMAID_DOC_SLUGS.has(document.slug)).length *
        LOCALES.length,
    'localized Mermaid page count differs from published Mermaid documents',
  )

  const generatedMdxFiles = (await listFiles(GENERATED_DOCS_ROOT)).filter((file) =>
    file.endsWith('.mdx'),
  )
  const expectedGeneratedMdxCount = LOCALES.length * (astDocuments.length + 1)
  invariant(
    generatedMdxFiles.length === expectedGeneratedMdxCount,
    `generated collection must contain ${expectedGeneratedMdxCount} MDX files, received ${generatedMdxFiles.length}`,
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
    allMarkdownTwins.length === expectedAgentPageCount,
    `dist must contain ${expectedAgentPageCount} Markdown twins, received ${allMarkdownTwins.length}`,
  )
  invariant(
    allMdxTwins.length === expectedAgentPageCount,
    `dist must contain ${expectedAgentPageCount} MDX twins, received ${allMdxTwins.length}`,
  )
  invariant(
    !existsSync(path.join(DIST_ROOT, 'docs')),
    'dist must not publish a canonical docs directory',
  )
  invariant(
    !distFiles.some((file) => file.includes(`${path.sep}src${path.sep}react${path.sep}`)),
    'dist contains a Site React runtime artifact',
  )
  const agentAndHumanSurfaceFiles = distFiles.filter((file) => {
    const extension = path.extname(file)
    const basename = path.basename(file)
    return (
      extension === '.html' ||
      extension === '.md' ||
      extension === '.mdx' ||
      basename === 'llms.txt' ||
      basename === 'llms-full.txt'
    )
  })
  for (const file of agentAndHumanSurfaceFiles) {
    const source = await readFile(file, 'utf8')
    for (const [id, message] of siteShellMessageIds) {
      invariant(
        !containsStandaloneMessageId(source, id),
        `${path.relative(DIST_ROOT, file)} leaks unresolved Site message ${JSON.stringify(message)}`,
      )
    }
  }

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
  for (const locale of LOCALES) {
    for (const document of [...noindexDocuments, ...draftDocuments]) {
      const route = documentRoute(locale.segment, document.slug)
      const markdownUrl = new URL(`${route}/index.md`, SITE_ORIGIN).href
      invariant(
        !globalLlmsIndex.includes(markdownUrl) &&
          !globalLlmsFull.includes(`<!-- xid-doc-path: ${route} -->`),
        `${route} unpublished agent surface leaked into the global corpus`,
      )
    }
  }
  invariant(
    countOccurrences(globalLlmsIndex, '/index.md)') === expectedAgentPageCount,
    `root llms.txt must enumerate exactly ${expectedAgentPageCount} Markdown twins`,
  )
  invariant(
    countOccurrences(globalLlmsFull, '<!-- xid-doc-path:') === expectedAgentPageCount,
    `root llms-full.txt must contain exactly ${expectedAgentPageCount} corpus blocks`,
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
  for (const locale of LOCALES) {
    const sdkLlmsIndexPath = contentSectionAgentPath(locale, 'sdks', 'llms.txt')
    invariant(
      globalLlmsIndex.includes(new URL(sdkLlmsIndexPath, SITE_ORIGIN).href),
      `root llms.txt is missing ${sdkLlmsIndexPath}`,
    )
  }

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
  invariant(
    pagefindCount === expectedAgentPageCount,
    `Pagefind must index ${expectedAgentPageCount} pages, received ${pagefindCount}`,
  )
  const expectedAgentPagesPerLocale = agentDocuments.length + 2
  invariant(
    Object.values(pagefind.languages).every(
      (language) => language.page_count === expectedAgentPagesPerLocale,
    ),
    `Pagefind must index ${expectedAgentPagesPerLocale} pages per locale`,
  )
  const pagefindFragments = (await listFiles(path.join(DIST_ROOT, 'pagefind/fragment'))).filter(
    (file) => file.endsWith('.pf_fragment'),
  )
  invariant(
    pagefindFragments.length === expectedAgentPageCount,
    `Pagefind must emit ${expectedAgentPageCount} fragments, received ${pagefindFragments.length}`,
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
    sitemapLocations.size === expectedAgentPageCount,
    `compatibility sitemap must contain ${expectedAgentPageCount} pages, received ${sitemapLocations.size}`,
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
    const pageNotFoundId = linguiMessageId('Page not found')
    const pageNotFoundMessage = siteShellCatalogs.get(locale.locale)?.[pageNotFoundId]
    invariant(
      Array.isArray(pageNotFoundMessage) &&
        pageNotFoundMessage.length === 1 &&
        typeof pageNotFoundMessage[0] === 'string',
      `${locale.locale} Page not found message must compile to one static string`,
    )
    const title = /<title>([^<]*)<\/title>/u.exec(notFoundHtml)
    invariant(
      title?.[1] === `${pageNotFoundMessage[0]} | XID`,
      `${notFoundPath} title must be exactly ${JSON.stringify(`${pageNotFoundMessage[0]} | XID`)}`,
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
    localeAgentPages: expectedAgentPagesPerLocale,
    contentSectionAgentIndexes: LOCALES.length,
    sdkSectionPages: agentSlugs.filter((slug) => slug === 'sdks' || slug.startsWith('sdks/'))
      .length,
    pagefindPages: pagefindCount,
    sitemapUrls: sitemapLocations.size,
    contentTypeRules: 3,
    mermaidPages: mermaidPageCount,
    localeScopedNavigationPages: localeScopedNavigationCount,
    localized404Pages: localized404Count,
    resolvedSiteShellMessages: siteShellMessageIds.size,
    legacyAliases: Object.keys(LEGACY_ALIASES).length * LOCALES.length,
  }
}

try {
  process.stdout.write(`${JSON.stringify(await audit(), null, 2)}\n`)
} catch (error) {
  process.stderr.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
