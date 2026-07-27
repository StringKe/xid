import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  generateLocalizedContent,
  loadSourceAst,
  renderMessageDescriptors,
} from './generate-localized-content.mjs'
import { renderHtmlDocument } from '../src/content-source/docs/render-html.ts'

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
      section.paragraphs.forEach((paragraph) =>
        visitRichText(paragraph, visit),
      )
    } else if (section.kind === 'quickStart') {
      section.steps.forEach((step) => visitRichText(step, visit))
    } else {
      section.groups.forEach((group) => visitRichText(group.label, visit))
    }
  }
  for (const document of bundle.documents) {
    visitRichText(document.title, visit)
    visitRichText(document.summary, visit)
    for (const section of document.sections) {
      visitRichText(section.heading, visit)
      for (const block of section.blocks) {
        if (block.kind === 'paragraph') visitRichText(block.content, visit)
        if (block.kind === 'list') {
          block.items.forEach((item) => visitRichText(item, visit))
        }
        if (block.kind === 'table') {
          block.headers.forEach((header) => visitRichText(header, visit))
          block.rows.forEach((row) => row.forEach((cell) => visitRichText(cell, visit)))
        }
        if (block.kind === 'code') codePositions.add(block.sourcePosition)
      }
    }
  }
  return { messageIds, codePositions, values, tags }
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
  assert.deepEqual(committed.stats, {
    documents: 40,
    sections: 273,
    paragraphs: 111,
    listItems: 174,
    tables: 70,
    tableRows: 476,
    codeBlocks: 123,
    richTags: { inlineCode: 289, strong: 17, link: 16 },
    staticValues: 2,
    literalValues: 3,
    catalogMessages: 1120,
  })

  const contract = collectContentContract(committed)
  assert.equal(contract.messageIds.size, 1114)
  assert.equal(committed.messageCatalog.length, 1120)
  assert.deepEqual(contract.tags, { inlineCode: 290, strong: 17, link: 16 })
  assert.deepEqual(contract.values, { static: 2, literal: 3 })
  assert.equal(contract.codePositions.size, 123)

  const manifest = JSON.parse(
    await readFile(path.join(SITE_ROOT, 'src/content-source/docs/code-languages.json'), 'utf8'),
  )
  assert.equal(Object.keys(manifest).length, 123)
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
      1120,
      `${locale} catalog must retain all AST messages after Lingui extraction`,
    )
  }
})

test('localized generation writes 328 complete MDX files and is repeatable', async (context) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'xid-localized-docs-'))
  context.after(() => {
    if (process.platform === 'darwin') execFileSync('/usr/bin/trash', [outputDirectory])
  })

  const bundle = await loadSourceAst()
  const first = await generateLocalizedContent({ outputDirectory, bundle })
  assert.equal(first.generatedFiles, 328)
  assert.equal(first.changedFiles, 328)
  const firstDigest = await directoryDigest(outputDirectory)

  const second = await generateLocalizedContent({ outputDirectory, bundle })
  assert.equal(second.generatedFiles, 328)
  assert.equal(second.changedFiles, 0)
  assert.equal(await directoryDigest(outputDirectory), firstDigest)

  const generatedFiles = (await listFiles(outputDirectory)).filter((file) => file.endsWith('.mdx'))
  assert.equal(generatedFiles.length, 328)
  assert.equal(
    generatedFiles.filter((file) => /\/(?:zh-Hans|ja|ko|fr|de|es|pt-BR)\//.test(file)).length,
    287,
  )

  const englishScim = await readFile(path.join(outputDirectory, 'scim.mdx'), 'utf8')
  const chineseCore = await readFile(path.join(outputDirectory, 'zh-Hans/sdks/core.mdx'), 'utf8')
  const englishHub = await readFile(path.join(outputDirectory, 'index.mdx'), 'utf8')
  assert.match(englishScim, /locale: "en"/)
  assert.match(englishScim, /```shell/)
  assert.match(englishScim, /\/organizations\/\{organization_id\}/)
  assert.match(chineseCore, /\]\(\/zh-hans\/sdks\/react\)/)
  assert.match(englishHub, /## Platform/)
  assert.match(englishHub, /## Minimum integration/)
  assert.match(englishHub, /## All developer docs/)
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
