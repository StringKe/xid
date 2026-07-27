import { copyFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const DIST_ROOT = path.join(SITE_ROOT, 'dist')
const LOCALES = [
  ['zh-hans', 'zh-Hans'],
  ['ja', 'ja'],
  ['ko', 'ko'],
  ['fr', 'fr'],
  ['de', 'de'],
  ['es', 'es'],
  ['pt-br', 'pt-BR'],
]

for (const [segment, locale] of LOCALES) {
  const source = path.join(DIST_ROOT, segment, '404', 'index.html')
  const target = path.join(DIST_ROOT, segment, '404.html')
  const html = await readFile(source, 'utf8')
  if (!html.includes(`<html lang="${locale}"`)) {
    throw new Error(`${source} does not use locale ${locale}`)
  }
  await copyFile(source, target)
}

process.stdout.write(`Generated ${LOCALES.length} localized 404 pages\n`)
