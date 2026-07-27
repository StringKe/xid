import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { assertDocumentAstBundle, DOCUMENT_LOCALES } from '../src/content-source/docs/types.ts'
import {
  renderMarkdownDocument,
  renderMarkdownHub,
  renderPlainText,
} from '../src/content-source/docs/render-markdown.ts'

const execFileAsync = promisify(execFile)
const SITE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SOURCE_AST_FILE = path.join(SITE_ROOT, 'src/content-source/docs/documents.json')
const MESSAGE_DESCRIPTORS_FILE = path.join(
  SITE_ROOT,
  'src/content-source/docs/message-descriptors.ts',
)
const DEFAULT_OUTPUT_DIRECTORY = path.join(SITE_ROOT, 'src/content/generated/docs')
const I18N_DIRECTORY = path.join(REPOSITORY_ROOT, 'packages/i18n/locales')

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function toRepositoryPath(file) {
  return path.relative(REPOSITORY_ROOT, file).split(path.sep).join('/')
}

async function importLocaleCatalog(locale) {
  const file = path.join(I18N_DIRECTORY, locale, 'messages.mjs')
  const source = await readFile(file, 'utf8')
  const match = /export const messages=JSON\.parse\(("(?:\\.|[^"\\])*")\);?\s*$/.exec(source)
  if (!match) {
    throw new TypeError(`compiled catalog for ${locale} has an unsupported module shape`)
  }
  const jsonStringLiteral = match[1].replace(
    /\\x([0-9a-f]{2})/gi,
    (_escape, code) => `\\u00${code}`,
  )
  const messages = JSON.parse(JSON.parse(jsonStringLiteral))
  if (messages === null || typeof messages !== 'object') {
    throw new TypeError(`compiled catalog for ${locale} does not export messages`)
  }
  return messages
}

function compiledSignature(compiled) {
  if (!Array.isArray(compiled)) {
    throw new TypeError('compiled message must be an array')
  }
  const tokens = []
  for (const token of compiled) {
    if (typeof token === 'string') {
      for (const match of token.matchAll(/<\/?(\d+)>/g)) tokens.push(match[0])
      continue
    }
    if (Array.isArray(token) && token.length === 1 && typeof token[0] === 'string') {
      tokens.push(`{${token[0]}}`)
      continue
    }
    throw new TypeError(
      `docs compiled message contains unsupported ICU token: ${JSON.stringify(token)}`,
    )
  }
  return tokens.sort(stableCompare).join('|')
}

export async function loadAndValidateCatalogs(messageCatalog) {
  const catalogs = {}
  const englishCatalog = await importLocaleCatalog('en')
  for (const locale of DOCUMENT_LOCALES) {
    const catalog = locale === 'en' ? englishCatalog : await importLocaleCatalog(locale)
    for (const entry of messageCatalog) {
      const englishCompiled = englishCatalog[entry.id]
      const localizedCompiled = catalog[entry.id]
      if (englishCompiled === undefined || localizedCompiled === undefined) {
        throw new TypeError(`compiled catalog ${locale} is missing docs message ${entry.id}`)
      }
      const expectedSignature = compiledSignature(englishCompiled)
      const actualSignature = compiledSignature(localizedCompiled)
      if (actualSignature !== expectedSignature) {
        throw new TypeError(`compiled catalog ${locale} changed placeholders for ${entry.id}`)
      }
    }
    catalogs[locale] = catalog
  }
  return catalogs
}

function formatCompiledMessage(compiled, values) {
  if (!Array.isArray(compiled)) {
    throw new TypeError('compiled docs message must be an array')
  }
  let result = ''
  for (const token of compiled) {
    if (typeof token === 'string') {
      result += token
      continue
    }
    if (Array.isArray(token) && token.length === 1 && typeof token[0] === 'string') {
      const value = values[token[0]]
      if (value === undefined) {
        throw new TypeError(`compiled docs message is missing static value ${token[0]}`)
      }
      result += value
      continue
    }
    throw new TypeError(
      `compiled docs message contains unsupported ICU token: ${JSON.stringify(token)}`,
    )
  }
  return result
}

function createTranslator(catalog) {
  return (descriptor) => {
    const compiled = catalog[descriptor.id]
    if (compiled === undefined) {
      throw new TypeError(`compiled catalog is missing ${descriptor.id}`)
    }
    const values = Object.fromEntries(
      Object.entries(descriptor.values).map(([name, value]) => [name, value.value]),
    )
    return formatCompiledMessage(compiled, values)
  }
}

async function writeFileIfChanged(file, content) {
  let current = null
  try {
    current = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (current === content) return false
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
  return true
}

export async function loadSourceAst() {
  const bundle = JSON.parse(await readFile(SOURCE_AST_FILE, 'utf8'))
  assertDocumentAstBundle(bundle)
  return bundle
}

export function renderMessageDescriptors(bundle) {
  assertDocumentAstBundle(bundle)
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

export async function syncMessageDescriptors(bundle) {
  return writeFileIfChanged(MESSAGE_DESCRIPTORS_FILE, renderMessageDescriptors(bundle))
}

function frontmatter({ title, description, locale, order }) {
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    `locale: ${JSON.stringify(locale)}`,
    'sidebar:',
    `  order: ${order}`,
    '---',
  ].join('\n')
}

function localizedContentPath(outputDirectory, locale, slug) {
  const localeParts = locale === 'en' ? [] : [locale]
  return path.join(outputDirectory, ...localeParts, ...slug.split('/')) + '.mdx'
}

function localizedHubPath(outputDirectory, locale) {
  const localeParts = locale === 'en' ? [] : [locale]
  return path.join(outputDirectory, ...localeParts, 'index.mdx')
}

async function listMdxFiles(directory) {
  if (!existsSync(directory)) return []
  const files = []
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await visit(target)
      } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
        files.push(target)
      }
    }
  }
  await visit(directory)
  return files.sort(stableCompare)
}

async function moveStaleGeneratedFilesToTrash(outputDirectory, expectedFiles) {
  const outputRoot = `${path.resolve(outputDirectory)}${path.sep}`
  const stale = (await listMdxFiles(outputDirectory)).filter(
    (file) => !expectedFiles.has(path.resolve(file)),
  )
  if (stale.length === 0) return
  for (const file of stale) {
    const resolved = path.resolve(file)
    if (!resolved.startsWith(outputRoot)) {
      throw new TypeError(`refusing to remove generated file outside output root: ${resolved}`)
    }
  }
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/trash')) {
    throw new TypeError(
      `stale generated MDX requires recoverable cleanup: ${stale.map(toRepositoryPath).join(', ')}`,
    )
  }
  await execFileAsync('/usr/bin/trash', stale)
}

export async function generateLocalizedContent(options = {}) {
  const outputDirectory = options.outputDirectory
    ? path.resolve(options.outputDirectory)
    : DEFAULT_OUTPUT_DIRECTORY
  const bundle = options.bundle ?? (await loadSourceAst())
  assertDocumentAstBundle(bundle)
  if (!options.outputDirectory) await syncMessageDescriptors(bundle)
  const catalogs = await loadAndValidateCatalogs(bundle.messageCatalog)
  const expectedFiles = new Set()
  let changedFiles = 0

  for (const locale of DOCUMENT_LOCALES) {
    const renderOptions = {
      locale,
      translate: createTranslator(catalogs[locale]),
    }
    const hubFile = localizedHubPath(outputDirectory, locale)
    const hubTitle = renderPlainText(bundle.hub.title, renderOptions)
    const hubDescription = renderPlainText(bundle.hub.summary, renderOptions)
    const hubBody = renderMarkdownHub(bundle.hub, bundle.documents, renderOptions)
    const hubContent = `${frontmatter({
      title: hubTitle,
      description: hubDescription,
      locale,
      order: 0,
    })}\n\n${hubBody}\n`
    expectedFiles.add(path.resolve(hubFile))
    if (await writeFileIfChanged(hubFile, hubContent)) changedFiles += 1

    for (const [index, document] of bundle.documents.entries()) {
      const file = localizedContentPath(outputDirectory, locale, document.slug)
      const title = renderPlainText(document.title, renderOptions)
      const description = renderPlainText(document.summary, renderOptions)
      const body = renderMarkdownDocument(document, renderOptions)
      const content = `${frontmatter({
        title,
        description,
        locale,
        order: index + 1,
      })}\n\n${body}\n`
      expectedFiles.add(path.resolve(file))
      if (await writeFileIfChanged(file, content)) changedFiles += 1
    }
  }

  await moveStaleGeneratedFilesToTrash(outputDirectory, expectedFiles)
  const generatedFiles = await listMdxFiles(outputDirectory)
  if (generatedFiles.length !== 328 || expectedFiles.size !== 328) {
    throw new TypeError(
      `localized generation must produce 328 MDX files, received ${generatedFiles.length}`,
    )
  }
  return {
    outputDirectory,
    generatedFiles: generatedFiles.length,
    changedFiles,
    stats: bundle.stats,
  }
}

function isMainModule() {
  if (!process.argv[1]) return false
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

if (isMainModule()) {
  const report = await generateLocalizedContent()
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}
