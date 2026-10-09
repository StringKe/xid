import { useLingui } from '@lingui/react'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useLocation } from '@xid-kit/web-ui/tanstack-router'
import { useLocale } from '../lib/locale-context'
import { applyPageSeo, resolvePageSeo } from '../lib/page-seo'

export function RoutePageSeo(): ReactNode {
  const { pathname, search } = useLocation()
  const { locale } = useLocale()
  const { i18n } = useLingui()

  useEffect(() => {
    applyPageSeo(resolvePageSeo(pathname, search), i18n, { pathname, locale })
  }, [pathname, search, locale, i18n])

  return null
}
