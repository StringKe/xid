import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertDocumentMessageIds,
  documentMessageId,
  generateLocalizedContent,
  loadSourceAst,
  renderMessageDescriptors,
} from './generate-localized-content.mjs'
import { renderHtmlDocument } from '../src/content-source/docs/render-html.ts'
import { DOCUMENT_LOCALE_ROUTE_SEGMENTS } from '../src/content-source/docs/types.ts'

const SITE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const MERMAID_BLOCKS = [
  {
    slug: 'getting-started',
    heading: 'Authorization request',
    sourcePosition:
      'apps/site/src/content-source/docs/documents.json:getting-started/authorization-request',
    signature: 'sequenceDiagram',
  },
  {
    slug: 'hosted-auth',
    heading: 'Unified flow',
    sourcePosition: 'apps/site/src/content-source/docs/documents.json:hosted-auth/unified-flow',
    signature: 'flowchart TD',
  },
  {
    slug: 'enterprise-sso',
    heading: 'Two directions',
    sourcePosition:
      'apps/site/src/content-source/docs/documents.json:enterprise-sso/two-directions',
    signature: 'flowchart LR',
  },
  {
    slug: 'webhooks',
    heading: 'Retries and dead letters',
    sourcePosition:
      'apps/site/src/content-source/docs/documents.json:webhooks/retries-and-dead-letters',
    signature: 'flowchart LR',
  },
]
const TYPESCRIPT_SDK_SLUGS = [
  'sdks/core',
  'sdks/backend',
  'sdks/react',
  'sdks/nextjs',
  'sdks/react-native',
  'sdks/vue',
  'sdks/nuxt',
  'sdks/svelte',
  'sdks/solid',
  'sdks/angular',
  'sdks/astro',
  'sdks/remix',
  'sdks/expo',
  'sdks/electron',
  'sdks/tauri',
]
const PUBLIC_NATIVE_SDK_SLUGS = [
  'sdks/react-native',
  'sdks/expo',
  'sdks/electron',
  'sdks/tauri',
  'sdks/ios',
  'sdks/android',
  'sdks/flutter',
  'sdks/macos',
  'sdks/windows',
  'sdks/linux',
]

function visitRichText(value, visitor) {
  if (value.kind === 'sequence') {
    value.children.forEach((child) => visitRichText(child, visitor))
    return
  }
  visitor(value)
}

function collectContentContract(bundle) {
  const messageIds = new Set()
  const codePositions = new Set()
  const values = { static: 0, literal: 0 }
  const tags = { inlineCode: 0, strong: 0, link: 0 }
  const contentStats = {
    documents: bundle.documents.length,
    sections: 0,
    paragraphs: 0,
    listItems: 0,
    tables: 0,
    tableRows: 0,
    codeBlocks: 0,
  }

  const visit = (value) => {
    if (value.kind !== 'message') return
    messageIds.add(value.id)
    for (const messageValue of Object.values(value.values)) values[messageValue.source] += 1
    for (const tag of Object.values(value.tags)) tags[tag.kind] += 1
  }

  for (const field of ['eyebrow', 'title', 'summary']) {
    visitRichText(bundle.hub[field], visit)
  }
  for (const section of bundle.hub.sections) {
    visitRichText(section.heading, visit)
    if (section.kind === 'product') {
      section.paragraphs.forEach((paragraph) => visitRichText(paragraph, visit))
    } else if (section.kind === 'capabilities') {
      section.items.forEach((item) => visitRichText(item, visit))
    } else {
      section.groups.forEach((group) => visitRichText(group.label, visit))
    }
  }
  for (const document of bundle.documents) {
    visitRichText(document.title, visit)
    visitRichText(document.summary, visit)
    contentStats.sections += document.sections.length
    for (const section of document.sections) {
      visitRichText(section.heading, visit)
      for (const block of section.blocks) {
        if (block.kind === 'paragraph') {
          contentStats.paragraphs += 1
          visitRichText(block.content, visit)
        }
        if (block.kind === 'list') {
          contentStats.listItems += block.items.length
          block.items.forEach((item) => visitRichText(item, visit))
        }
        if (block.kind === 'table') {
          contentStats.tables += 1
          contentStats.tableRows += block.rows.length
          block.headers.forEach((header) => visitRichText(header, visit))
          block.rows.forEach((row) => row.forEach((cell) => visitRichText(cell, visit)))
        }
        if (block.kind === 'code') {
          contentStats.codeBlocks += 1
          codePositions.add(block.sourcePosition)
        }
      }
    }
  }
  return { messageIds, codePositions, values, tags, contentStats }
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
  return files.sort()
}

async function directoryDigest(directory) {
  const digest = createHash('sha256')
  for (const file of await listFiles(directory)) {
    digest.update(path.relative(directory, file))
    digest.update('\0')
    digest.update(await readFile(file))
    digest.update('\0')
  }
  return digest.digest('hex')
}

function sourceTranslator(descriptor) {
  let message = descriptor.message
  for (const [name, value] of Object.entries(descriptor.values)) {
    message = message.replaceAll(`{${name}}`, value.value)
  }
  return message
}

test('committed AST exhausts every audited contract without legacy source access', async () => {
  const committed = await loadSourceAst()
  assert.equal(committed.documents.length, 41)

  const contract = collectContentContract(committed)
  assert.deepEqual(contract.contentStats, {
    documents: committed.stats.documents,
    sections: committed.stats.sections,
    paragraphs: committed.stats.paragraphs,
    listItems: committed.stats.listItems,
    tables: committed.stats.tables,
    tableRows: committed.stats.tableRows,
    codeBlocks: committed.stats.codeBlocks,
  })
  assert.equal(committed.messageCatalog.length, committed.stats.catalogMessages)
  assert.deepEqual(contract.tags, committed.stats.richTags)
  assert.deepEqual(contract.values, {
    static: committed.stats.staticValues,
    literal: committed.stats.literalValues,
  })
  assert.equal(contract.codePositions.size, committed.stats.codeBlocks)

  const manifest = JSON.parse(
    await readFile(path.join(SITE_ROOT, 'src/content-source/docs/code-languages.json'), 'utf8'),
  )
  assert.equal(Object.keys(manifest).length, committed.stats.codeBlocks)
  assert.deepEqual(new Set(Object.keys(manifest)), contract.codePositions)
  assert.equal(Object.values(manifest).includes('text'), false)
  assert.deepEqual(
    MERMAID_BLOCKS.map(({ slug, heading }) => {
      const document = committed.documents.find((entry) => entry.slug === slug)
      const section = document?.sections.find((entry) => entry.heading.message === heading)
      const blocks = section?.blocks.filter(
        (entry) => entry.kind === 'code' && entry.language === 'mermaid',
      )
      assert.equal(blocks?.length, 1, `${slug} must contain one Mermaid block`)
      const block = blocks[0]
      return {
        slug,
        heading,
        sourcePosition: block.sourcePosition,
        signature: block.value.split('\n', 1)[0],
        manifestLanguage: manifest[block.sourcePosition],
      }
    }),
    MERMAID_BLOCKS.map((entry) => ({
      ...entry,
      manifestLanguage: 'mermaid',
    })),
  )

  const committedDescriptors = await readFile(
    path.join(SITE_ROOT, 'src/content-source/docs/message-descriptors.ts'),
    'utf8',
  )
  assert.equal(committedDescriptors, renderMessageDescriptors(committed))
  assert.equal(committedDescriptors.match(/\/\*i18n\*\//g)?.length, committed.messageCatalog.length)
  assert.doesNotThrow(() => assertDocumentMessageIds(committed))
  for (const entry of committed.messageCatalog) {
    assert.equal(entry.id, documentMessageId(entry.message))
  }

  for (const locale of committed.locales) {
    const po = await readFile(
      path.join(SITE_ROOT, '../../packages/i18n/locales', locale, 'messages.po'),
      'utf8',
    )
    const activeDocsMessages = po
      .split(/\n\n+/)
      .filter(
        (block) =>
          block.includes('apps/site/src/content-source/docs/message-descriptors.ts') &&
          !block.split('\n').some((line) => line.startsWith('#~')),
      )
    assert.equal(
      activeDocsMessages.length,
      committed.stats.catalogMessages,
      `${locale} catalog must retain all AST messages after Lingui extraction`,
    )
  }
})

test('every public TypeScript SDK discloses source-only unpublished distribution', async () => {
  const bundle = await loadSourceAst()
  const documents = new Map(bundle.documents.map((document) => [document.slug, document]))

  for (const slug of TYPESCRIPT_SDK_SLUGS) {
    const document = documents.get(slug)
    assert.ok(document, `${slug} public document is missing`)
    const disclosure = document.sections[0]?.blocks[0]
    assert.equal(disclosure?.kind, 'paragraph', `${slug} disclosure must precede package usage`)
    assert.equal(disclosure.content.kind, 'message')
    assert.equal(disclosure.content.id, 'Rafp8j')
    assert.equal(
      disclosure.content.message,
      'Registry status: UNPUBLISHED. Install this SDK only from the repository source checkout; do not use an external package registry.',
    )
  }
})

test('public browser SDK examples use the implemented client configuration contracts', async () => {
  const bundle = await loadSourceAst()
  const documents = new Map(bundle.documents.map((document) => [document.slug, document]))
  const codeFor = (slug) =>
    documents
      .get(slug)
      ?.sections.flatMap((section) =>
        section.blocks.filter((block) => block.kind === 'code').map((block) => block.value),
      )
      .join('\n') ?? ''

  const browserSdkCode = [
    'sdks/core',
    'sdks/react',
    'sdks/react-native',
    'sdks/vue',
    'sdks/nuxt',
    'sdks/svelte',
    'sdks/solid',
    'sdks/angular',
    'sdks/astro',
    'sdks/remix',
    'sdks/expo',
  ]
    .map(codeFor)
    .join('\n')
  assert.doesNotMatch(
    browserSdkCode,
    /publishableKey|pk_live_|PUBLIC_XID_PK|XID_PUBLISHABLE_KEY|xidApiUrl/u,
  )
  assert.doesNotMatch(browserSdkCode, /(?:XidPlugin|provideXid)\(\{[^}]*apiUrl:\s*['"]https:\/\//u)

  for (const slug of ['sdks/core', 'sdks/nuxt']) {
    assert.match(codeFor(slug), /mode:\s*'oidc'/u, `${slug} must show explicit OIDC mode`)
    assert.match(codeFor(slug), /issuer:/u, `${slug} must show an issuer`)
    assert.match(codeFor(slug), /clientId:/u, `${slug} must show an OAuth client_id`)
    assert.match(codeFor(slug), /redirectUri:/u, `${slug} must show an exact redirect URI`)
  }
  for (const slug of ['sdks/react', 'sdks/solid', 'sdks/remix']) {
    assert.match(codeFor(slug), /mode="oidc"/u, `${slug} must show explicit OIDC mode`)
    assert.match(codeFor(slug), /issuer=/u, `${slug} must show an issuer`)
    assert.match(codeFor(slug), /clientId=/u, `${slug} must show an OAuth client_id`)
    assert.match(codeFor(slug), /redirectUri=/u, `${slug} must show an exact redirect URI`)
  }
  for (const slug of ['sdks/vue', 'sdks/svelte', 'sdks/angular', 'sdks/astro']) {
    assert.match(
      codeFor(slug),
      /mode:\s*'same-origin'/u,
      `${slug} same-origin example must declare its mode`,
    )
  }

  const coreCode = codeFor('sdks/core')
  assert.match(coreCode, /if \(!authorization\.ok\)/u)
  assert.match(coreCode, /if \(!created\.ok\)/u)
  assert.match(coreCode, /created\.value\.id/u)
  assert.match(coreCode, /revokeApiKey\(\{ id:/u)
  assert.match(coreCode, /secretKey:\s*process\.env\.XID_SECRET_KEY/u)

  const solidCode = codeFor('sdks/solid')
  assert.match(solidCode, /if \(!activated\.ok\)/u)
  assert.match(solidCode, /if \(!token\.ok\)/u)

  const astroCode = codeFor('sdks/astro')
  assert.match(astroCode, /if \(!result\.ok\)/u)
})

test('public native SDK documents match the authorization-code-only client contract', async () => {
  const bundle = await loadSourceAst()
  const documents = new Map(bundle.documents.map((document) => [document.slug, document]))

  for (const slug of PUBLIC_NATIVE_SDK_SLUGS) {
    const document = documents.get(slug)
    assert.ok(document, `${slug} public document is missing`)
    const serialized = JSON.stringify(document)
    const code = document.sections
      .flatMap((section) =>
        section.blocks.filter((block) => block.kind === 'code').map((block) => block.value),
      )
      .join('\n')

    assert.match(serialized, /offline_access/u, `${slug} must disclose the offline_access boundary`)
    assert.match(serialized, /DPoP/u, `${slug} must explain why offline_access is rejected`)
    assert.match(
      serialized,
      /reauthoriz|new authorization flow|new sign-in|SessionExpired/u,
      `${slug} must disclose the access-token expiry behavior`,
    )
    assert.doesNotMatch(
      serialized,
      /auto-refresh(?:es)?|refreshes transparently|refreshing automatically|refresh token rotation|force renewal|revokes? refresh|revocation endpoint|refresh single-flight|stored refresh token is available|offline_access must be included|TokenRefreshFailed/u,
      `${slug} must not promise an unimplemented refresh or revoke path`,
    )
    assert.doesNotMatch(
      code,
      /scopes\s*[:=]\s*(?:listOf\s*\()?\[[^\]]*offline_access/isu,
      `${slug} example must not request offline_access`,
    )
  }
})

test('localized generation writes 336 complete MDX files and is repeatable', async (context) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'xid-localized-docs-'))
  context.after(() => {
    if (process.platform === 'darwin') execFileSync('/usr/bin/trash', [outputDirectory])
  })

  const bundle = await loadSourceAst()
  const first = await generateLocalizedContent({ outputDirectory, bundle })
  assert.equal(first.generatedFiles, 336)
  assert.equal(first.changedFiles, 336)
  const firstDigest = await directoryDigest(outputDirectory)

  const second = await generateLocalizedContent({ outputDirectory, bundle })
  assert.equal(second.generatedFiles, 336)
  assert.equal(second.changedFiles, 0)
  assert.equal(await directoryDigest(outputDirectory), firstDigest)

  const generatedFiles = (await listFiles(outputDirectory)).filter((file) => file.endsWith('.mdx'))
  assert.equal(generatedFiles.length, 336)
  assert.equal(
    generatedFiles.filter((file) => /\/(?:zh-Hans|ja|ko|fr|de|es|pt-BR)\//.test(file)).length,
    294,
  )

  const englishScim = await readFile(path.join(outputDirectory, 'scim.mdx'), 'utf8')
  const chineseCore = await readFile(path.join(outputDirectory, 'zh-Hans/sdks/core.mdx'), 'utf8')
  const englishHub = await readFile(path.join(outputDirectory, 'docs.mdx'), 'utf8')
  assert.match(englishScim, /locale: "en"/)
  assert.match(englishScim, /```shell/)
  assert.match(englishScim, /\/organizations\/\{organization_id\}/)
  assert.match(chineseCore, /\]\(\/zh-hans\/sdks\/react\)/)
  assert.match(englishHub, /title: "XID Identity Platform"/)
  assert.match(englishHub, /## One platform for identity/)
  assert.match(englishHub, /## What XID includes/)
  assert.match(englishHub, /## Explore XID/)
  assert.doesNotMatch(englishHub, /Minimum integration/)
  assert.equal(englishHub.match(/^### /gm)?.length, 8)

  for (const locale of bundle.locales) {
    const localeDirectory = locale === 'en' ? '' : locale
    for (const { slug, signature } of MERMAID_BLOCKS) {
      const generated = await readFile(
        path.join(outputDirectory, localeDirectory, `${slug}.mdx`),
        'utf8',
      )
      assert.equal(
        generated.split('```mermaid').length - 1,
        1,
        `${locale}/${slug} must retain one Mermaid fence`,
      )
      assert.match(generated, new RegExp(`\`\`\`mermaid\\n${signature}`))
    }
  }

  for (const file of generatedFiles) {
    const content = await readFile(file, 'utf8')
    assert.match(content, /^---\n/)
    assert.doesNotMatch(content, /<Localized|<DocsPage|<React/)
    assert.doesNotMatch(content, /<\/?\d+>/)
  }
})

test('localized generation carries draft and noindex publication controls to every locale', async (context) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'xid-publication-flags-'))
  context.after(() => {
    if (process.platform === 'darwin') execFileSync('/usr/bin/trash', [outputDirectory])
  })

  const bundle = structuredClone(await loadSourceAst())
  const draft = bundle.documents[0]
  const noindex = bundle.documents[1]
  assert.ok(draft)
  assert.ok(noindex)
  draft.draft = true
  noindex.noindex = true

  await generateLocalizedContent({ outputDirectory, bundle })

  for (const locale of bundle.locales) {
    const localeDirectory = locale === 'en' ? '' : locale
    const draftSource = await readFile(
      path.join(outputDirectory, localeDirectory, `${draft.slug}.mdx`),
      'utf8',
    )
    const noindexSource = await readFile(
      path.join(outputDirectory, localeDirectory, `${noindex.slug}.mdx`),
      'utf8',
    )
    const hubSource = await readFile(
      path.join(outputDirectory, localeDirectory, 'docs.mdx'),
      'utf8',
    )
    assert.match(draftSource, /^draft: true$/m)
    assert.doesNotMatch(draftSource, /^noindex:/m)
    assert.match(noindexSource, /^noindex: true$/m)
    assert.doesNotMatch(noindexSource, /^draft:/m)
    assert.doesNotMatch(hubSource, /^(?:draft|noindex):/m)
    const routeSegment = DOCUMENT_LOCALE_ROUTE_SEGMENTS[locale]
    const prefix = routeSegment === '' ? '' : `/${routeSegment}`
    const draftHref = `${prefix}/${draft.slug}`
    const noindexHref = `${prefix}/${noindex.slug}`
    assert.doesNotMatch(hubSource, new RegExp(`\\]\\(${draftHref}\\)`))
    assert.match(hubSource, new RegExp(`\\]\\(${noindexHref}\\)`))
  }
})

test('HTML renderer emits semantic rich tags without a Markdown round trip', async () => {
  const bundle = await loadSourceAst()
  const angular = bundle.documents.find((document) => document.slug === 'sdks/angular')
  const core = bundle.documents.find((document) => document.slug === 'sdks/core')
  assert.ok(angular)
  assert.ok(core)

  const angularHtml = renderHtmlDocument(angular, {
    locale: 'en',
    translate: sourceTranslator,
  })
  const coreHtml = renderHtmlDocument(core, {
    locale: 'zh-Hans',
    translate: sourceTranslator,
  })
  assert.match(angularHtml, /<strong>Current package<\/strong>/)
  assert.match(angularHtml, /<pre><code class="language-ts">/)
  assert.match(coreHtml, /href="\/zh-hans\/sdks\/react"/)
  assert.match(coreHtml, /<table>/)
})
