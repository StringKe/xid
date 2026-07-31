import { readFile } from 'node:fs/promises'
import type { IndexedEntry } from '@cloudflare/nimbus-docs'
import { loadPublicDocsIndex } from '../../lib/docs-index-runtime'
import { flattenPublicDocsIndex } from '../../lib/docs-registry'

export const prerender = true

interface SlugProps {
  item: IndexedEntry
}

export async function getStaticPaths() {
  const groups = await loadPublicDocsIndex()
  return flattenPublicDocsIndex(groups).map((item) => ({
    params: { slug: item.sourceUrl?.slice(1, -'/index.mdx'.length) },
    props: { item } as SlugProps,
  }))
}

export async function GET({ props }: { props: SlugProps }) {
  const { filePath } = props.item.entry
  if (!filePath) {
    throw new TypeError(`documentation source file is unavailable for ${props.item.url}`)
  }
  const authoredSource = await readFile(filePath, 'utf8')
  return new Response(authoredSource, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
