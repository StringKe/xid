// 按路由解析页面 SEO 配置,并写入 document.title / meta(随 locale 切换刷新)。

import type { I18n } from '@lingui/core'
import type { MessageDescriptor } from '@lingui/core'
import { buildPublicCanonicalUrl } from './google-analytics'
import { resolvePublicDocSlug } from '../routes/docs/registry'
import {
  docSeoDescriptionForSlug,
  docSeoTitleForSlug,
  seoAcceptInvitationTitle,
  seoAccountConnectionsTitle,
  seoAccountDevicesTitle,
  seoAccountProfileTitle,
  seoAccountSecurityTitle,
  seoAccountSessionsTitle,
  seoActivateDeviceTitle,
  seoCibaActivationTitle,
  seoConsentTitle,
  seoConsoleOrganizationsTitle,
  seoConsoleOverviewTitle,
  seoConsoleSecurityTitle,
  seoConsoleSessionsTitle,
  seoConsoleSettingsTitle,
  seoConsoleUsersTitle,
  seoCreateOrganizationTitle,
  seoDocsHubDescription,
  seoDocsHubTitle,
  seoForgotPasswordTitle,
  seoHomeDescription,
  seoHomeTitle,
  seoMfaTitle,
  seoNotFoundTitle,
  seoOrgApiKeysTitle,
  seoOrgApplicationsTitle,
  seoOrgAuditEventsTitle,
  seoOrgAuthPolicyTitle,
  seoOrgBrandingTitle,
  seoOrgDeliveryChannelsTitle,
  seoOrgDomainsTitle,
  seoOrgInboundSsoTitle,
  seoOrgMembersTitle,
  seoOrgOutboundSsoTitle,
  seoOrgOverviewTitle,
  seoOrgRolesTitle,
  seoOrgScimTargetsTitle,
  seoOrgScimTitle,
  seoOrgSocialProvidersTitle,
  seoOrgWebhooksTitle,
  seoPlatformBillingTitle,
  seoPlatformEventsTitle,
  seoPlatformFlagsTitle,
  seoPlatformOrganizationsTitle,
  seoPlatformOverviewTitle,
  seoPlatformSettingsTitle,
  seoPlatformUsersTitle,
  seoSelectOrganizationTitle,
  seoSignInTitle,
  seoSignUpTitle,
  seoVerifyEmailTitle,
} from './page-seo-descriptors'

export type PageSeoConfig = {
  title: MessageDescriptor
  description?: MessageDescriptor
  indexable: boolean
}

const PUBLIC_LOCALES = ['en', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR'] as const

function exactRoute(pathname: string, path: string, config: PageSeoConfig): PageSeoConfig | null {
  return pathname === path ? config : null
}

function prefixRoute(
  pathname: string,
  prefix: string,
  config: PageSeoConfig,
): PageSeoConfig | null {
  return pathname === prefix || pathname.startsWith(`${prefix}/`) ? config : null
}

function resolveDocsSeo(pathname: string): PageSeoConfig {
  if (pathname === '/docs') {
    return { title: seoDocsHubTitle, description: seoDocsHubDescription, indexable: true }
  }

  const slug = resolvePublicDocSlug(pathname)
  if (!slug) {
    return { title: seoNotFoundTitle, indexable: false }
  }

  return {
    title: docSeoTitleForSlug(slug) ?? seoDocsHubTitle,
    description: docSeoDescriptionForSlug(slug) ?? seoDocsHubDescription,
    indexable: true,
  }
}

export function resolvePageSeo(pathname: string): PageSeoConfig {
  if (pathname === '/') {
    return { title: seoHomeTitle, description: seoHomeDescription, indexable: true }
  }

  if (pathname === '/docs' || pathname.startsWith('/docs/')) {
    return resolveDocsSeo(pathname)
  }

  const privateRoutes: Array<[string, PageSeoConfig]> = [
    ['/sign-in', { title: seoSignInTitle, indexable: false }],
    ['/sign-up', { title: seoSignUpTitle, indexable: false }],
    ['/forgot-password', { title: seoForgotPasswordTitle, indexable: false }],
    ['/reset-password', { title: seoForgotPasswordTitle, indexable: false }],
    ['/mfa', { title: seoMfaTitle, indexable: false }],
    ['/verify-email', { title: seoVerifyEmailTitle, indexable: false }],
    ['/accept-invitation', { title: seoAcceptInvitationTitle, indexable: false }],
    ['/create-organization', { title: seoCreateOrganizationTitle, indexable: false }],
    ['/select-organization', { title: seoSelectOrganizationTitle, indexable: false }],
    ['/consent', { title: seoConsentTitle, indexable: false }],
    ['/activate', { title: seoActivateDeviceTitle, indexable: false }],
    ['/ciba-activation', { title: seoCibaActivationTitle, indexable: false }],
    ['/account', { title: seoAccountProfileTitle, indexable: false }],
    ['/account/security', { title: seoAccountSecurityTitle, indexable: false }],
    ['/account/connections', { title: seoAccountConnectionsTitle, indexable: false }],
    ['/account/sessions', { title: seoAccountSessionsTitle, indexable: false }],
    ['/account/devices', { title: seoAccountDevicesTitle, indexable: false }],
    ['/console', { title: seoConsoleOverviewTitle, indexable: false }],
    ['/console/users', { title: seoConsoleUsersTitle, indexable: false }],
    ['/console/organizations', { title: seoConsoleOrganizationsTitle, indexable: false }],
    ['/console/sessions', { title: seoConsoleSessionsTitle, indexable: false }],
    ['/console/security', { title: seoConsoleSecurityTitle, indexable: false }],
    ['/console/settings', { title: seoConsoleSettingsTitle, indexable: false }],
    ['/console/org', { title: seoOrgOverviewTitle, indexable: false }],
    ['/console/org/members', { title: seoOrgMembersTitle, indexable: false }],
    ['/console/org/roles', { title: seoOrgRolesTitle, indexable: false }],
    ['/console/org/auth-policy', { title: seoOrgAuthPolicyTitle, indexable: false }],
    ['/console/org/delivery-channels', { title: seoOrgDeliveryChannelsTitle, indexable: false }],
    ['/console/org/social-providers', { title: seoOrgSocialProvidersTitle, indexable: false }],
    ['/console/org/sso', { title: seoOrgInboundSsoTitle, indexable: false }],
    ['/console/org/outbound-sso', { title: seoOrgOutboundSsoTitle, indexable: false }],
    ['/console/org/scim', { title: seoOrgScimTitle, indexable: false }],
    ['/console/org/scim-targets', { title: seoOrgScimTargetsTitle, indexable: false }],
    ['/console/org/domains', { title: seoOrgDomainsTitle, indexable: false }],
    ['/console/org/branding', { title: seoOrgBrandingTitle, indexable: false }],
    ['/console/org/applications', { title: seoOrgApplicationsTitle, indexable: false }],
    ['/console/org/webhooks', { title: seoOrgWebhooksTitle, indexable: false }],
    ['/console/org/api-keys', { title: seoOrgApiKeysTitle, indexable: false }],
    ['/console/org/audit-events', { title: seoOrgAuditEventsTitle, indexable: false }],
    ['/console/platform', { title: seoPlatformOverviewTitle, indexable: false }],
    ['/console/platform/organizations', { title: seoPlatformOrganizationsTitle, indexable: false }],
    ['/console/platform/users', { title: seoPlatformUsersTitle, indexable: false }],
    ['/console/platform/events', { title: seoPlatformEventsTitle, indexable: false }],
    ['/console/platform/flags', { title: seoPlatformFlagsTitle, indexable: false }],
    ['/console/platform/billing', { title: seoPlatformBillingTitle, indexable: false }],
    ['/console/platform/settings', { title: seoPlatformSettingsTitle, indexable: false }],
  ]

  for (const [path, config] of privateRoutes) {
    const match = exactRoute(pathname, path, config)
    if (match) return match
  }

  for (const [prefix, config] of [
    ['/console/platform', { title: seoPlatformOverviewTitle, indexable: false }],
    ['/console/org', { title: seoOrgOverviewTitle, indexable: false }],
    ['/console', { title: seoConsoleOverviewTitle, indexable: false }],
    ['/account', { title: seoAccountProfileTitle, indexable: false }],
  ] as const) {
    const match = prefixRoute(pathname, prefix, config)
    if (match) return match
  }

  return { title: seoNotFoundTitle, indexable: false }
}

function setMetaContent(selector: string, content: string): void {
  const element = document.querySelector(selector)
  if (!element) return
  element.setAttribute('content', content)
}

function isCanonicalLink(element: Element | null): element is HTMLLinkElement {
  return element !== null && element.tagName === 'LINK'
}

function ensureCanonicalLink(): HTMLLinkElement {
  const existing = document.querySelector('link#xid-page-canonical')
  if (isCanonicalLink(existing)) return existing
  const link = document.createElement('link')
  link.id = 'xid-page-canonical'
  link.rel = 'canonical'
  document.head.appendChild(link)
  return link
}

function clearDynamicHreflang(): void {
  for (const link of document.querySelectorAll('link[data-xid-hreflang]')) {
    link.remove()
  }
}

function syncHreflang(pathname: string): void {
  clearDynamicHreflang()
  for (const locale of PUBLIC_LOCALES) {
    const link = document.createElement('link')
    link.rel = 'alternate'
    link.hreflang = locale
    link.href = buildPublicCanonicalUrl(pathname, locale)
    link.setAttribute('data-xid-hreflang', 'true')
    document.head.appendChild(link)
  }
  const xDefault = document.createElement('link')
  xDefault.rel = 'alternate'
  xDefault.hreflang = 'x-default'
  xDefault.href = buildPublicCanonicalUrl(pathname, 'en')
  xDefault.setAttribute('data-xid-hreflang', 'true')
  document.head.appendChild(xDefault)
}

export function applyPageSeo(
  config: PageSeoConfig,
  i18n: I18n,
  options?: { pathname?: string; locale?: string },
): void {
  const title = i18n._(config.title)
  document.title = title

  const description = config.description ? i18n._(config.description) : ''
  setMetaContent('meta[name="description"]', description)
  setMetaContent('meta[property="og:description"]', description)
  setMetaContent('meta[name="twitter:description"]', description)

  setMetaContent('meta[property="og:title"]', title)
  setMetaContent('meta[name="twitter:title"]', title)
  setMetaContent('meta[name="robots"]', config.indexable ? 'index,follow' : 'noindex,nofollow')

  const pathname = options?.pathname ?? location.pathname
  const locale = options?.locale ?? i18n.locale
  const canonicalUrl = buildPublicCanonicalUrl(pathname, locale)
  ensureCanonicalLink().href = canonicalUrl
  setMetaContent('meta[property="og:url"]', canonicalUrl)

  if (config.indexable) {
    const run = (): void => {
      syncHreflang(pathname)
    }
    if ('requestIdleCallback' in globalThis) {
      globalThis.requestIdleCallback(run, { timeout: 2_000 })
    } else {
      globalThis.requestAnimationFrame(run)
    }
  } else {
    clearDynamicHreflang()
  }
}
