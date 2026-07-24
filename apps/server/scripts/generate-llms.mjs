// 从 public-docs 注册表与 page-seo-descriptors 生成 llms.txt / llms-full.txt,避免与 sitemap 漂移。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ORIGIN = 'https://xid.dev'

function readPublicDocSlugs() {
  const source = readFileSync(join(ROOT, 'public-docs.ts'), 'utf8')
  const match = source.match(/export const PUBLIC_DOC_SLUGS = \[([\s\S]*?)\] as const/u)
  if (!match) throw new Error('PUBLIC_DOC_SLUGS not found in public-docs.ts')
  return [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1])
}

function readDescriptorMaps() {
  const source = readFileSync(join(ROOT, 'src/lib/page-seo-descriptors.ts'), 'utf8')
  const titleBlock = source.match(/const DOC_TITLE_BY_SLUG[\s\S]*?= \{([\s\S]*?)\n\}/u)
  const descriptionBlock = source.match(/const DOC_DESCRIPTION_BY_SLUG[\s\S]*?= \{([\s\S]*?)\n\}/u)
  if (!titleBlock || !descriptionBlock) {
    throw new Error('DOC_TITLE_BY_SLUG or DOC_DESCRIPTION_BY_SLUG not found')
  }

  // key 可能带引号(`'sdks/core':`)也可能不带(Oxfmt 会去掉合法标识符的引号,如 `saml:`);
  // seoDescriptor(...) 超宽时被 Oxfmt 折成多行并补尾逗号。三者任一不匹配都会静默丢条目,所以全部放宽。
  const entryPattern =
    /(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*seoDescriptor\(\s*'[^']*'\s*,\s*`([^`]+)`\s*,?\s*\)/gu

  const parseEntries = (block) =>
    Object.fromEntries(
      [...block.matchAll(entryPattern)].map((entry) => [entry[1] ?? entry[2], entry[3]]),
    )

  return {
    titles: parseEntries(titleBlock[1]),
    descriptions: parseEntries(descriptionBlock[1]),
  }
}

const PUBLIC_DOC_SLUGS = readPublicDocSlugs()
const { titles, descriptions } = readDescriptorMaps()

const PUBLIC_ALIASES = [
  ['oidc', 'oidc-oauth'],
  ['oauth', 'oidc-oauth'],
  ['sso', 'enterprise-sso'],
  ['enterprise', 'enterprise-sso'],
  ['social', 'social-login'],
  ['sdks/web', 'sdks/core'],
]

const CATEGORY_BY_SLUG = new Map(
  [
    ['getting-started', 'Getting started'],
    ['hosted-auth', 'Getting started'],
    ['oidc-oauth', 'Protocols'],
    ['saml', 'Protocols'],
    ['scim', 'Protocols'],
    ['enterprise-sso', 'Enterprise identity'],
    ['social-login', 'Enterprise identity'],
    ['management-api', 'Developer API'],
    ['webhooks', 'Developer API'],
    ['branding', 'Developer API'],
    ['sdks', 'SDKs'],
    ['self-hosting', 'Operations'],
  ].flatMap(([slug, category]) => [[slug, category]]),
)

function categoryForSlug(slug) {
  if (slug.startsWith('sdks/')) return 'SDK packages'
  return CATEGORY_BY_SLUG.get(slug) ?? 'Developer documentation'
}

function docUrl(slug) {
  return slug === 'getting-started' ? `${ORIGIN}/docs` : `${ORIGIN}/docs/${slug}`
}

function docLine(slug) {
  const title = titles[slug] ?? slug
  const description = descriptions[slug]
  const url = docUrl(slug)
  if (description) return `- [${title}](${url}): ${description}`
  return `- [${title}](${url})`
}

const llmsTxt = `# XID

> Edge-native identity platform for OIDC, OAuth, organization RBAC, enterprise SSO, SCIM, passkeys, and networkless JWT verification on Cloudflare Workers.

XID is open source identity infrastructure under the MIT License. Public marketing and developer documentation are crawlable; authenticated console and account areas require a signed-in session.

## Product

- [Home](${ORIGIN}/)

## Developer documentation

- [Documentation index](${ORIGIN}/docs)
- [OIDC alias](${ORIGIN}/docs/oidc)
- [OIDC and OAuth](${ORIGIN}/docs/oidc-oauth)
- [Hosted authentication](${ORIGIN}/docs/hosted-auth)
- [Enterprise SSO](${ORIGIN}/docs/enterprise-sso)
- [Social login](${ORIGIN}/docs/social-login)
- [SAML](${ORIGIN}/docs/saml)
- [SCIM directory sync](${ORIGIN}/docs/scim)
- [Management API](${ORIGIN}/docs/management-api)
- [Webhooks](${ORIGIN}/docs/webhooks)
- [Branding](${ORIGIN}/docs/branding)
- [SDK matrix](${ORIGIN}/docs/sdks)
- [Self-hosting](${ORIGIN}/docs/self-hosting)

## Discovery

- [Sitemap](${ORIGIN}/sitemap.xml)
- [Robots policy](${ORIGIN}/robots.txt)
- [Full machine-readable index](${ORIGIN}/llms-full.txt)
- [WebMCP tools](${ORIGIN}/) (Chrome origin trial; read-only public docs tools on marketing and /docs)

## Crawl policy

- Allow: \`/\`, \`/docs\`, and published \`/docs/*\` slugs listed in the sitemap and llms-full.txt.
- Disallow: \`/sign-in\`, \`/sign-up\`, \`/account\`, \`/console\`, \`/auth\`, \`/v1\`, \`/admin\`, \`/platform-admin\`.
- Hosted auth flows are \`noindex\` and should not be used for model training.
`

const grouped = new Map()
for (const slug of PUBLIC_DOC_SLUGS) {
  const category = categoryForSlug(slug)
  const entries = grouped.get(category) ?? []
  entries.push(slug)
  grouped.set(category, entries)
}

const categoryOrder = [
  'Getting started',
  'Protocols',
  'Enterprise identity',
  'Developer API',
  'SDKs',
  'SDK packages',
  'Operations',
]

const fullSections = categoryOrder
  .filter((category) => grouped.has(category))
  .map((category) => {
    const lines = grouped
      .get(category)
      .sort((a, b) => a.localeCompare(b))
      .map(docLine)
    return `## ${category}\n\n${lines.join('\n')}`
  })

const aliasLines = PUBLIC_ALIASES.map(
  ([alias, canonical]) => `- \`/docs/${alias}\` -> \`/docs/${canonical}\``,
)

const llmsFullTxt = `# XID: full public documentation index

> Machine-readable catalog for LLM crawlers and generative engines. Canonical English summaries; localized UI copy may differ.

- Site: ${ORIGIN}/
- Registry: xid-public-technical-docs-registry (${PUBLIC_DOC_SLUGS.length} slugs)
- Sitemap: ${ORIGIN}/sitemap.xml
- Robots: ${ORIGIN}/robots.txt
- Concise index: ${ORIGIN}/llms.txt

## Crawl policy

- Allow: \`/\`, \`/docs\`, and every slug in this file.
- Disallow: \`/sign-in\`, \`/sign-up\`, \`/account\`, \`/console\`, \`/auth\`, \`/v1\`, \`/admin\`, \`/platform-admin\`.
- Internal repository design docs under \`/docs/design\` and similar paths are **not** published.
- Hosted authentication flows are \`noindex\` and out of scope for training.

## URL aliases

${aliasLines.join('\n')}

${fullSections.join('\n\n')}
`

writeFileSync(join(ROOT, 'public/llms.txt'), llmsTxt)
writeFileSync(join(ROOT, 'public/llms-full.txt'), llmsFullTxt)

const wellKnownDir = join(ROOT, 'public/.well-known')
mkdirSync(wellKnownDir, { recursive: true })
writeFileSync(join(wellKnownDir, 'llms.txt'), llmsTxt)

process.stdout.write(
  `wrote llms.txt, llms-full.txt, and .well-known/llms.txt (${PUBLIC_DOC_SLUGS.length} doc slugs)\n`,
)
