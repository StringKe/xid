// 从 en catalog 同步 page-seo MessageDescriptor id(供 vitest 等无 macro 环境使用)。

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { messages } from '../../../packages/i18n/locales/en/messages.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'src/lib/page-seo-messages.ts')
const OUTPUT = join(ROOT, 'src/lib/page-seo-descriptors.ts')

function readMsgid(block) {
  const lines = block.split('\n')
  const parts = []
  let inMsgid = false
  for (const line of lines) {
    if (line.startsWith('msgid ')) {
      inMsgid = true
      if (line === 'msgid ""') continue
      const match = line.match(/^msgid "((?:\\.|[^"\\])*)"$/)
      if (match) parts.push(JSON.parse(`"${match[1]}"`))
      continue
    }
    if (inMsgid && line.startsWith('"') && !line.startsWith('msgstr')) {
      parts.push(JSON.parse(line.trim()))
      continue
    }
    if (line.startsWith('msgstr')) break
  }
  return parts.join('')
}

function flattenMessage(value) {
  if (!Array.isArray(value)) return String(value)
  return value.map((part) => (typeof part === 'string' ? part : '')).join('')
}

function escapeTs(value) {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')
}

const byText = new Map()
for (const [id, value] of Object.entries(messages)) {
  byText.set(flattenMessage(value), id)
}

const po = readFileSync(join(ROOT, '../../packages/i18n/locales/en/messages.po'), 'utf8')
const idByText = new Map()
for (const block of po.split(/\n\n+/)) {
  if (!block.includes('page-seo-messages.ts')) continue
  const text = readMsgid(block)
  const id = byText.get(text)
  if (!id) throw new Error(`missing catalog id for: ${text}`)
  idByText.set(text, id)
}

const source = readFileSync(SOURCE, 'utf8')
const exportMatches = [...source.matchAll(new RegExp('export const (\\w+) = msg`([^`]+)`', 'g'))]

function extractSlugMsgMap(mapName) {
  const marker = `const ${mapName}`
  const start = source.indexOf(marker)
  if (start < 0) return []
  const open = source.indexOf('{', start)
  const close = source.indexOf('\n}\n', open)
  const block = source.slice(open, close + 1)
  return [...block.matchAll(/(?:'([^']+)'|([A-Za-z0-9_-]+)): msg`([^`]+)`/gu)].map(
    ([, quoted, bare, text]) => [quoted ?? bare, text],
  )
}

const docTitleMatches = extractSlugMsgMap('DOC_TITLE_BY_SLUG')
const docDescriptionMatches = extractSlugMsgMap('DOC_DESCRIPTION_BY_SLUG')

const lines = [
  '// 自动生成:node apps/server/scripts/sync-page-seo-descriptors.mjs',
  '// 页面级 SEO MessageDescriptor(无 macro,供测试与 SSR 直引)。源文案在 page-seo-messages.ts。',
  '',
  "import type { MessageDescriptor } from '@lingui/core'",
  '',
  'function seoDescriptor(id: string, message: string): MessageDescriptor {',
  '  return { id, message }',
  '}',
  '',
]

for (const [, name, text] of exportMatches) {
  const id = idByText.get(text)
  if (!id) throw new Error(`missing catalog id for export ${name}: ${text}`)
  lines.push(`export const ${name} = seoDescriptor('${id}', \`${escapeTs(text)}\`)`)
}

function appendSlugMapLines(mapName, matches, exportName) {
  lines.push('')
  lines.push(`const ${mapName}: Record<string, MessageDescriptor> = {`)
  for (const [slug, text] of matches) {
    const id = idByText.get(text)
    if (!id) throw new Error(`missing catalog id for slug ${slug}: ${text}`)
    lines.push(`  '${slug}': seoDescriptor('${id}', \`${escapeTs(text)}\`),`)
  }
  lines.push('}')
  lines.push('')
  lines.push(`export function ${exportName}(slug: string): MessageDescriptor | null {`)
  lines.push(`  return ${mapName}[slug] ?? null`)
  lines.push('}')
}

appendSlugMapLines('DOC_DESCRIPTION_BY_SLUG', docDescriptionMatches, 'docSeoDescriptionForSlug')
appendSlugMapLines('DOC_TITLE_BY_SLUG', docTitleMatches, 'docSeoTitleForSlug')
lines.push('')

writeFileSync(OUTPUT, `${lines.join('\n')}\n`)
process.stdout.write(`wrote ${OUTPUT}\n`)
