import { renderPublicDocsLlmsIndex } from '../../lib/docs-agent-content'
import { loadPublicDocsIndex } from '../../lib/docs-index-runtime'
import type { PublicDocsIndexedLocale } from '../../lib/docs-registry'

export const prerender = true

export async function getStaticPaths() {
  const groups = await loadPublicDocsIndex()
  return groups
    .map((group) => ({
      params: { section: group.locale === 'en' ? 'en' : group.routeSegment },
      props: { group },
    }))
}

export function GET({ props }: { props: { group: PublicDocsIndexedLocale } }) {
  return new Response(renderPublicDocsLlmsIndex(props.group), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
