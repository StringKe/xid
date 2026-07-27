import type { MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useLocale } from '@xid-kit/web-ui/locale-context'
import { useLocation } from '@xid-kit/web-ui/tanstack-router'
import { trackPageView } from '../lib/google-analytics'

const TITLES: Readonly<Record<string, MessageDescriptor>> = {
  '/console': /*i18n*/ { id: 'kjo2do', message: 'Console overview | XID' },
  '/console/users': /*i18n*/ { id: 'q4CxF4', message: 'Users | Console | XID' },
  '/console/organizations': /*i18n*/ {
    id: 'ZlJXTl',
    message: 'Organizations | Console | XID',
  },
  '/console/settings': /*i18n*/ { id: '0QsJ5l', message: 'Settings | Console | XID' },
  '/console/org': /*i18n*/ { id: 'y-pBk0', message: 'Organization overview | Console | XID' },
  '/console/org/members': /*i18n*/ { id: 'lUBUZG', message: 'Members | Console | XID' },
  '/console/org/roles': /*i18n*/ { id: '3CjwFT', message: 'Roles | Console | XID' },
  '/console/org/auth-policy': /*i18n*/ {
    id: '6Fss-s',
    message: 'Auth policy | Console | XID',
  },
  '/console/org/delivery-channels': /*i18n*/ {
    id: 'XVhIDa',
    message: 'Delivery channels | Console | XID',
  },
  '/console/org/social-providers': /*i18n*/ {
    id: '-sjyu1',
    message: 'Social providers | Console | XID',
  },
  '/console/org/sso': /*i18n*/ {
    id: 'gUsPa_',
    message: 'Inbound enterprise SSO | Console | XID',
  },
  '/console/org/outbound-sso': /*i18n*/ {
    id: 'WDJu9v',
    message: 'Outbound enterprise SSO | Console | XID',
  },
  '/console/org/scim': /*i18n*/ { id: 'UB_mLd', message: 'Directory sync | Console | XID' },
  '/console/org/scim-targets': /*i18n*/ {
    id: 'vhGFye',
    message: 'SCIM targets | Console | XID',
  },
  '/console/org/domains': /*i18n*/ { id: '8F9YFg', message: 'Domains | Console | XID' },
  '/console/org/branding': /*i18n*/ { id: 'kFEuyM', message: 'Branding | Console | XID' },
  '/console/org/applications': /*i18n*/ {
    id: 'zE6GZ8',
    message: 'OAuth applications | Console | XID',
  },
  '/console/org/webhooks': /*i18n*/ { id: '0-WDPk', message: 'Webhooks | Console | XID' },
  '/console/org/api-keys': /*i18n*/ { id: '6mxmcc', message: 'API keys | Console | XID' },
  '/console/org/audit-events': /*i18n*/ {
    id: '7u-mRS',
    message: 'Audit events | Console | XID',
  },
  '/console/platform': /*i18n*/ { id: '1VwcCx', message: 'Platform overview | Console | XID' },
  '/console/platform/organizations': /*i18n*/ {
    id: 'Qesqz6',
    message: 'Platform organizations | Console | XID',
  },
  '/console/platform/users': /*i18n*/ {
    id: 'TFOSQi',
    message: 'Platform users | Console | XID',
  },
  '/console/platform/events': /*i18n*/ { id: 'm_6zdm', message: 'Event stream | Console | XID' },
  '/console/platform/flags': /*i18n*/ { id: 'u1fW7C', message: 'Feature flags | Console | XID' },
  '/console/platform/billing': /*i18n*/ {
    id: 'pJMmXv',
    message: 'Billing overview | Console | XID',
  },
  '/console/platform/settings': /*i18n*/ {
    id: '848QWZ',
    message: 'Platform settings | Console | XID',
  },
}

const NOT_FOUND_TITLE: MessageDescriptor = /*i18n*/ {
  id: 'iUkekb',
  message: 'Page not found | XID',
}

export function normalizeConsoleMetadataPath(pathname: string): string {
  if (pathname === '/') return pathname
  return pathname.replace(/\/+$/, '')
}

export function titleForPath(pathname: string): MessageDescriptor {
  return TITLES[normalizeConsoleMetadataPath(pathname)] ?? NOT_FOUND_TITLE
}

export function RouteMetadata(): ReactNode {
  const { pathname } = useLocation()
  const { locale } = useLocale()
  const { i18n } = useLingui()

  useEffect(() => {
    document.title = i18n._(titleForPath(pathname))
    document.querySelector('meta[name="robots"]')?.setAttribute('content', 'noindex,nofollow')
    trackPageView({
      pagePath: `${pathname}${location.search}`,
      pageTitle: document.title,
      contentGroup: 'console',
      locale,
    })
  }, [i18n, locale, pathname])

  return null
}
