// 随路由与 locale 同步 document.title 与 head meta(lingui 本地化)。

import { useLingui } from '@lingui/react'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useLocation } from '../lib/router'
import { useLocale } from '../lib/locale-context'
import { applyPageSeo, resolvePageSeo } from '../lib/page-seo'

export function RoutePageSeo(): ReactNode {
  const { pathname } = useLocation()
  const { locale } = useLocale()
  const { i18n } = useLingui()

  useEffect(() => {
    applyPageSeo(resolvePageSeo(pathname), i18n, { pathname, locale })
  }, [pathname, locale, i18n])

  return null
}
