import type { IndexedEntry } from '@cloudflare/nimbus-docs'
import { config } from 'virtual:nimbus/config'
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
  const { item } = props
  const { entry, title, description, version } = item
  const data = (entry.data ?? {}) as Record<string, unknown>
  const rawImage = data.socialImage
  const socialImage =
    typeof rawImage === 'string' && rawImage.length > 0
      ? rawImage
      : config.socialImage

  const body = [
    '---',
    `title: ${JSON.stringify(title)}`,
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    `locale: ${JSON.stringify(data.locale)}`,
    ...(socialImage
      ? [`image: ${JSON.stringify(new URL(socialImage, config.site).href)}`]
      : []),
    ...(version ? [`version: ${JSON.stringify(version)}`] : []),
    '---',
    '',
    entry.body ?? '',
  ].join('\n')

  return new Response(body, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
