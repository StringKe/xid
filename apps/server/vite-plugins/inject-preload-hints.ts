// 生产构建:为 index.html 注入 latin 字体 preload,缩短 LCP 字体等待。

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

const LATIN_FONT_PREFIX = 'inter-latin-wght-normal'
const ENTRY_SCRIPT_PREFIX = 'index-'
const HOME_PAGE_PREFIX = 'HomePage-'

export function injectPreloadHintsPlugin(): Plugin {
  return {
    name: 'xid-inject-preload-hints',
    apply: 'build',
    closeBundle() {
      const outDir = join(process.cwd(), 'dist/client')
      const indexPath = join(outDir, 'index.html')
      let html: string
      try {
        html = readFileSync(indexPath, 'utf8')
      } catch {
        return
      }

      const assetsDir = join(outDir, 'assets')
      let assetNames: string[] = []
      try {
        assetNames = readdirSync(assetsDir)
      } catch {
        return
      }

      const hints: string[] = []
      const latinFont = assetNames.find(
        (name) => name.startsWith(LATIN_FONT_PREFIX) && name.endsWith('.woff2'),
      )
      if (latinFont && !html.includes(latinFont)) {
        hints.push(
          `    <link rel="preload" href="/assets/${latinFont}" as="font" type="font/woff2" crossorigin />`,
        )
      }

      for (const prefix of [ENTRY_SCRIPT_PREFIX, HOME_PAGE_PREFIX] as const) {
        const script = assetNames.find((name) => name.startsWith(prefix) && name.endsWith('.js'))
        if (script && !html.includes(`href="/assets/${script}"`)) {
          hints.push(`    <link rel="modulepreload" href="/assets/${script}" />`)
        }
      }

      if (hints.length === 0) return

      const next = html.replace('</head>', `${hints.join('\n')}\n  </head>`)
      writeFileSync(indexPath, next)
    },
  }
}
