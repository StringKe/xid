// SPA 路由级 GA4 page_view(配合 index.html 加载的 Google 标记网关 /ts)。

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useLocation } from '../lib/router'
import { useLocale } from '../lib/locale-context'
import { resolveAnalyticsPageGroup, trackPageView } from '../lib/google-analytics'

export function RouteAnalytics(): ReactNode {
  const { pathname } = useLocation()
  const { locale } = useLocale()

  useEffect(() => {
    const pageTitle = document.title
    const pagePath = `${pathname}${location.search}`
    trackPageView({
      pagePath,
      pageTitle,
      contentGroup: resolveAnalyticsPageGroup(pathname),
      locale,
    })
  }, [pathname, locale])

  return null
}
