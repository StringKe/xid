import {
  renderPublicDocsLlmsIndex,
  renderPublicDocsSectionLlmsIndex,
} from '../../lib/docs-agent-content'
import { loadPublicDocsIndex } from '../../lib/docs-index-runtime'
import {
  getPublicDocsIndexedSections,
  type PublicDocsIndexedLocale,
  type PublicDocsIndexedSection,
} from '../../lib/docs-registry'

export const prerender = true

type AgentIndexProps =
  | { kind: 'locale'; group: PublicDocsIndexedLocale }
  | { kind: 'section'; section: PublicDocsIndexedSection }

export async function getStaticPaths() {
  const groups = await loadPublicDocsIndex()
  return groups.flatMap((group) => [
    {
      params: { section: group.locale === 'en' ? 'en' : group.routeSegment },
      props: { kind: 'locale', group } satisfies AgentIndexProps,
    },
    ...getPublicDocsIndexedSections(group).map((section) => ({
      params: { section: section.llmsIndexPath.slice(1, -'/llms.txt'.length) },
      props: { kind: 'section', section } satisfies AgentIndexProps,
    })),
  ])
}

export function GET({ props }: { props: AgentIndexProps }) {
  const body =
    props.kind === 'locale'
      ? renderPublicDocsLlmsIndex(props.group)
      : renderPublicDocsSectionLlmsIndex(props.section)
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
