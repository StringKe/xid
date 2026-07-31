import type { GetStaticPaths } from 'astro'
import { getLocalizedStatusStaticPaths, renderStatusMdx } from '../../../lib/status-surface'
import type { SiteLocale } from '../../../lib/site-locale'

export const prerender = true
export const getStaticPaths: GetStaticPaths = () => getLocalizedStatusStaticPaths()

export function GET({ props }: { props: { locale: SiteLocale } }) {
  return new Response(renderStatusMdx(props.locale), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
