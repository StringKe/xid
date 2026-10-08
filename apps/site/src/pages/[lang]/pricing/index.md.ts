import type { GetStaticPaths } from 'astro'
import { getLocalizedPricingStaticPaths, renderPricingMarkdown } from '../../../lib/pricing-surface'
import type { SiteLocale } from '../../../lib/site-locale'

export const prerender = true
export const getStaticPaths: GetStaticPaths = () => getLocalizedPricingStaticPaths()

export function GET({ props }: { props: { locale: SiteLocale } }) {
  return new Response(renderPricingMarkdown(props.locale), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
