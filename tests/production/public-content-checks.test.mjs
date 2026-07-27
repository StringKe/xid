import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import {
  PUBLIC_DOC_SECTIONS,
  llmsFullOk,
  llmsOk,
  llmsSectionFullOk,
  llmsSectionOk,
  sitemapOk,
} from './harness/public-content-checks.mjs'

const llmsPath = new URL('../../apps/site/dist/llms.txt', import.meta.url)
const llmsFullPath = new URL('../../apps/site/dist/llms-full.txt', import.meta.url)
const sitemapPath = new URL('../../apps/site/dist/sitemap.xml', import.meta.url)

describe('production public content checks', () => {
  it('accepts the generated global indexes and exact sitemap corpus', async () => {
    const [llms, llmsFull, sitemap] = await Promise.all([
      readFile(llmsPath, 'utf8'),
      readFile(llmsFullPath, 'utf8'),
      readFile(sitemapPath, 'utf8'),
    ])

    expect(llmsOk(llms)).toBe(true)
    expect(llmsFullOk(llmsFull)).toBe(true)
    expect(sitemapOk(sitemap)).toBe(true)
  })

  it.each(PUBLIC_DOC_SECTIONS)(
    'accepts the 41-page $locale section indexes',
    async ({ section }) => {
      const [llms, llmsFull] = await Promise.all([
        readFile(new URL(`../../apps/site/dist/${section}/llms.txt`, import.meta.url), 'utf8'),
        readFile(new URL(`../../apps/site/dist/${section}/llms-full.txt`, import.meta.url), 'utf8'),
      ])

      expect(llmsSectionOk(llms, section)).toBe(true)
      expect(llmsSectionFullOk(llmsFull, section)).toBe(true)
    },
  )

  it('rejects sitemap entries under the legacy docs prefix', async () => {
    const sitemap = await readFile(sitemapPath, 'utf8')
    const injected = sitemap.replace(
      '</urlset>',
      '  <url><loc>https://xid.dev/docs/scim/</loc></url>\n</urlset>',
    )

    expect(sitemapOk(injected)).toBe(false)
  })

  it('rejects internal design targets', async () => {
    const llms = await readFile(llmsPath, 'utf8')
    const injected = `${llms}\n- [Internal](https://xid.dev/docs/design/00-overview)\n`

    expect(llmsOk(injected)).toBe(false)
  })
})
