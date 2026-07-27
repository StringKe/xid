import { renderEntryAsMarkdown, type IndexedEntry } from '@cloudflare/nimbus-docs'
import { config } from 'virtual:nimbus/config'
import { loadPublicDocsIndex } from '../../lib/docs-index-runtime'
import { flattenPublicDocsIndex, parsePublicDocsRoute } from '../../lib/docs-registry'

export const prerender = true

interface SlugProps {
  item: IndexedEntry
}

export async function getStaticPaths() {
  const groups = await loadPublicDocsIndex()
  return flattenPublicDocsIndex(groups).map((item) => ({
    params: { slug: item.markdownUrl.slice(1, -'/index.md'.length) },
    props: { item } as SlugProps,
  }))
}

export async function GET({ props }: { props: SlugProps }) {
  const { item } = props
  const { entry, title, description, markdownUrl, sourceUrl, version } = item
  const data = (entry.data ?? {}) as Record<string, unknown>
  const rawImage = data.socialImage
  const socialImage =
    typeof rawImage === 'string' && rawImage.length > 0 ? rawImage : config.socialImage
  const route = parsePublicDocsRoute(item.url)
  if (!route) throw new TypeError(`unknown public documentation route ${item.url}`)
  const llmsIndexPath =
    route.routeSegment === '' ? '/en/llms.txt' : `/${route.routeSegment}/llms.txt`
  const markdown = renderEntryAsMarkdown(entry)

  const body = [
    '---',
    `title: ${JSON.stringify(title)}`,
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    `locale: ${JSON.stringify(data.locale)}`,
    ...(socialImage ? [`image: ${JSON.stringify(new URL(socialImage, config.site).href)}`] : []),
    ...(version ? [`version: ${JSON.stringify(version)}`] : []),
    '---',
    '',
    '> Documentation Index',
    `> Fetch the locale documentation index at: ${new URL(llmsIndexPath, config.site).href}`,
    '> Use this file to discover all available pages before exploring further.',
    '',
    `# ${title}`,
    '',
    markdown,
    '',
    `Source: ${new URL(sourceUrl ?? markdownUrl, config.site).href}`,
    '',
  ].join('\n')

  return new Response(body, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
