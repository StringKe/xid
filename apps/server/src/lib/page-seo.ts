import type { I18n } from '@lingui/core'
import type { MessageDescriptor } from '@lingui/core'
import { isSignUpIntent } from '../../shared/hosted-auth-intent'
import { buildPublicCanonicalUrl } from './google-analytics'
import {
  seoAcceptInvitationTitle,
  seoAccountDeleteTitle,
  seoAccountDevicesTitle,
  seoAccountOrganizationsTitle,
  seoAccountPrivacyTitle,
  seoAccountProfileTitle,
  seoAccountSecurityTitle,
  seoActivateDeviceTitle,
  seoCibaActivationTitle,
  seoConsentTitle,
  seoCreateOrganizationTitle,
  seoForgotPasswordTitle,
  seoCreatePasskeyTitle,
  seoMfaSetupTitle,
  seoMfaTitle,
  seoMagicLinkTitle,
  seoNotFoundTitle,
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

// /sign-in 同时承载登录与注册,标签页标题跟随 intent。
export function resolvePageSeo(pathname: string, search = ''): PageSeoConfig {
  if (pathname === '/sign-in' && isSignUpIntent(new URLSearchParams(search).get('intent'))) {
    return { title: seoSignUpTitle, indexable: false }
  }
  const privateRoutes: Array<[string, PageSeoConfig]> = [
    ['/sign-in', { title: seoSignInTitle, indexable: false }],
    ['/sign-up', { title: seoSignUpTitle, indexable: false }],
    ['/forgot-password', { title: seoForgotPasswordTitle, indexable: false }],
    ['/reset-password', { title: seoForgotPasswordTitle, indexable: false }],
    ['/mfa', { title: seoMfaTitle, indexable: false }],
    ['/mfa/setup', { title: seoMfaSetupTitle, indexable: false }],
    ['/create-passkey', { title: seoCreatePasskeyTitle, indexable: false }],
    ['/verify-email', { title: seoVerifyEmailTitle, indexable: false }],
    ['/magic-link', { title: seoMagicLinkTitle, indexable: false }],
    ['/accept-invitation', { title: seoAcceptInvitationTitle, indexable: false }],
    ['/create-organization', { title: seoCreateOrganizationTitle, indexable: false }],
    ['/select-organization', { title: seoSelectOrganizationTitle, indexable: false }],
    ['/consent', { title: seoConsentTitle, indexable: false }],
    ['/activate', { title: seoActivateDeviceTitle, indexable: false }],
    ['/ciba-activation', { title: seoCibaActivationTitle, indexable: false }],
    ['/account', { title: seoAccountSecurityTitle, indexable: false }],
    ['/account/profile', { title: seoAccountProfileTitle, indexable: false }],
    ['/account/security', { title: seoAccountSecurityTitle, indexable: false }],
    ['/account/connections', { title: seoAccountSecurityTitle, indexable: false }],
    ['/account/devices', { title: seoAccountDevicesTitle, indexable: false }],
    ['/account/sessions', { title: seoAccountDevicesTitle, indexable: false }],
    ['/account/organizations', { title: seoAccountOrganizationsTitle, indexable: false }],
    ['/account/privacy', { title: seoAccountPrivacyTitle, indexable: false }],
    ['/account/privacy/delete', { title: seoAccountDeleteTitle, indexable: false }],
  ]

  for (const [path, config] of privateRoutes) {
    const match = exactRoute(pathname, path, config)
    if (match) return match
  }

  for (const [prefix, config] of [
    ['/account', { title: seoAccountSecurityTitle, indexable: false }],
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
  const canonicalUrl = buildPublicCanonicalUrl(pathname)
  ensureCanonicalLink().href = canonicalUrl
  setMetaContent('meta[property="og:url"]', canonicalUrl)
}
