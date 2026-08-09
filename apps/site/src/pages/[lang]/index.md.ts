import type { GetStaticPaths } from 'astro'
import { renderHomeMarkdown } from '../../lib/home-surface'
import { SITE_LOCALES, SITE_LOCALE_ROUTE_SEGMENTS, type SiteLocale } from '../../lib/site-locale'

export const prerender = true

type Props = { locale: SiteLocale }

export const getStaticPaths: GetStaticPaths = () =>
  SITE_LOCALES.filter((locale) => locale !== 'en').map((locale) => ({
    params: { lang: SITE_LOCALE_ROUTE_SEGMENTS[locale] },
    props: { locale } satisfies Props,
  }))

export function GET({ props }: { props: Props }) {
  return new Response(renderHomeMarkdown(props.locale), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
