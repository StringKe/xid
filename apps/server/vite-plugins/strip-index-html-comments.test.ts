import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { stripIndexHtmlComments } from './strip-index-html-comments'

const htmlPath = new URL('../index.html', import.meta.url)

describe('stripIndexHtmlComments', () => {
  it('removes inline style and script dev comments from index.html', async () => {
    const html = await readFile(htmlPath, 'utf8')
    const stripped = stripIndexHtmlComments(html)

    expect(stripped).not.toContain('SEO/no-JS')
    expect(stripped).not.toContain('首帧主题兜底')
    expect(stripped).not.toContain('ThemeProvider 挂载后接管维护')
    expect(stripped).toContain('[data-seo-fallback]')
    expect(stripped).toContain('<main data-seo-fallback>')
    expect(stripped).toContain('application/ld+json')
    expect(stripped).toContain('https://schema.org')
  })

  it('preserves JSON-LD script content', async () => {
    const html = await readFile(htmlPath, 'utf8')
    const stripped = stripIndexHtmlComments(html)
    const match = stripped.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/)

    expect(match).not.toBeNull()
    const jsonLd = JSON.parse(match?.[1] ?? '{}') as { '@graph'?: unknown[] }
    expect(Array.isArray(jsonLd['@graph'])).toBe(true)
  })
})
