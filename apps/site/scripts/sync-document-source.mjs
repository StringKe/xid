import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { docsMessageDescriptors } from '../src/content-source/docs/message-descriptors.ts'

const SITE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const SOURCE_AST_FILE = path.join(SITE_ROOT, 'src/content-source/docs/documents.json')
const MESSAGE_DESCRIPTORS_FILE = path.join(
  SITE_ROOT,
  'src/content-source/docs/message-descriptors.ts',
)

export function documentMessageId(message) {
  return createHash('sha256').update(`${message}\u001f`).digest('base64url').slice(0, 6)
}

function normalizeRichText(value, messages) {
  if (Array.isArray(value)) {
    for (const item of value) normalizeRichText(item, messages)
    return
  }
  if (value === null || typeof value !== 'object') return

  if (value.kind === 'message') {
    if (typeof value.message !== 'string' || value.message.length === 0) {
      throw new TypeError('document message must contain non-empty source text')
    }
    value.id = documentMessageId(value.message)
    const collision = messages.get(value.id)
    if (collision !== undefined && collision !== value.message) {
      throw new TypeError(`document message id collision between ${collision} and ${value.message}`)
    }
    messages.set(value.id, value.message)
    return
  }

  for (const child of Object.values(value)) normalizeRichText(child, messages)
}

function countRichText(value, stats) {
  if (value.kind === 'sequence') {
    for (const child of value.children) countRichText(child, stats)
    return
  }
  if (value.kind !== 'message') return
  for (const messageValue of Object.values(value.values)) {
    if (messageValue.source === 'static') stats.staticValues += 1
    else if (messageValue.source === 'literal') stats.literalValues += 1
  }
  for (const tag of Object.values(value.tags)) stats.richTags[tag.kind] += 1
}

function computeStats(bundle, catalogMessages) {
  const stats = {
    documents: bundle.documents.length,
    sections: 0,
    paragraphs: 0,
    listItems: 0,
    tables: 0,
    tableRows: 0,
    codeBlocks: 0,
    richTags: { inlineCode: 0, strong: 0, link: 0 },
    staticValues: 0,
    literalValues: 0,
    catalogMessages,
  }
  countRichText(bundle.hub.eyebrow, stats)
  countRichText(bundle.hub.title, stats)
  countRichText(bundle.hub.summary, stats)
  for (const section of bundle.hub.sections) {
    countRichText(section.heading, stats)
    if (section.kind === 'product') section.paragraphs.forEach((item) => countRichText(item, stats))
    if (section.kind === 'capabilities') section.items.forEach((item) => countRichText(item, stats))
    if (section.kind === 'navigation') {
      for (const group of section.groups) countRichText(group.label, stats)
    }
  }

  for (const document of bundle.documents) {
    countRichText(document.title, stats)
    countRichText(document.summary, stats)
    stats.sections += document.sections.length
    for (const section of document.sections) {
      countRichText(section.heading, stats)
      for (const block of section.blocks) {
        if (block.kind === 'paragraph') {
          stats.paragraphs += 1
          countRichText(block.content, stats)
        } else if (block.kind === 'list') {
          stats.listItems += block.items.length
          block.items.forEach((item) => countRichText(item, stats))
        } else if (block.kind === 'table') {
          stats.tables += 1
          stats.tableRows += block.rows.length
          block.headers.forEach((item) => countRichText(item, stats))
          block.rows.flat().forEach((item) => countRichText(item, stats))
        } else if (block.kind === 'code') {
          stats.codeBlocks += 1
        }
      }
    }
  }
  return stats
}

function normalizeCatalog(bundle, messages) {
  const catalog = []
  const added = new Set()
  for (const entry of bundle.messageCatalog ?? []) {
    const id = documentMessageId(entry.message)
    if (messages.get(id) !== entry.message || added.has(id)) continue
    catalog.push({ id, message: entry.message })
    added.add(id)
  }
  for (const [id, message] of messages) {
    if (added.has(id)) continue
    catalog.push({ id, message })
    added.add(id)
  }
  return catalog
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function renderMessageDescriptors(bundle) {
  return [
    '// Generated from documents.json. Do not edit.',
    'export const docsMessageDescriptors = [',
    ...bundle.messageCatalog.map(
      (entry) =>
        `  /*i18n*/ { id: ${JSON.stringify(entry.id)}, message: ${JSON.stringify(entry.message)} },`,
    ),
    '] as const',
    '',
  ].join('\n')
}

export function normalizeDocumentSource(bundle) {
  const messages = new Map()
  normalizeRichText(bundle.hub, messages)
  normalizeRichText(bundle.documents, messages)
  bundle.messageCatalog = normalizeCatalog(bundle, messages)
  bundle.stats = computeStats(bundle, bundle.messageCatalog.length)
  return bundle
}

export async function syncDocumentSource({ check = false } = {}) {
  const [current, currentDescriptors] = await Promise.all([
    readFile(SOURCE_AST_FILE, 'utf8'),
    readFile(MESSAGE_DESCRIPTORS_FILE, 'utf8'),
  ])
  const currentBundle = JSON.parse(current)
  const bundle = normalizeDocumentSource(structuredClone(currentBundle))
  const normalized = formatJson(bundle)
  const descriptors = renderMessageDescriptors(bundle)
  const sourceChanged = JSON.stringify(currentBundle) !== JSON.stringify(bundle)
  const descriptorValuesChanged =
    JSON.stringify(docsMessageDescriptors) !== JSON.stringify(bundle.messageCatalog)
  const descriptorsChanged = check
    ? descriptorValuesChanged
    : descriptorValuesChanged || currentDescriptors !== descriptors
  if (!sourceChanged && !descriptorsChanged) {
    return { changed: false, sourceChanged, descriptorsChanged, stats: bundle.stats }
  }
  if (check) {
    throw new TypeError(
      'document source derived metadata is stale; run pnpm --dir apps/site sync:content-source',
    )
  }
  await Promise.all([
    sourceChanged ? writeFile(SOURCE_AST_FILE, normalized, 'utf8') : undefined,
    descriptorsChanged ? writeFile(MESSAGE_DESCRIPTORS_FILE, descriptors, 'utf8') : undefined,
  ])
  return { changed: true, sourceChanged, descriptorsChanged, stats: bundle.stats }
}

function isMainModule() {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMainModule()) {
  const report = await syncDocumentSource({ check: process.argv.includes('--check') })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}
