// Google Analytics 4 + 标记网关(G-M7Q66DQ8KX)客户端事件层。
// gtag/dataLayer 与 /ts/ 脚本由 index.html 加载;此处只发事件,不重复注入。

export const GA_MEASUREMENT_ID = 'G-M7Q66DQ8KX'

export const PUBLIC_SITE_ORIGIN = 'https://xid.dev'

type GtagFn = (...args: readonly unknown[]) => void

type AnalyticsPageGroup = 'hosted_auth' | 'account' | 'other'

export type AnalyticsPageView = {
  pagePath: string
  pageTitle: string
  pageLocation?: string
  contentGroup?: AnalyticsPageGroup
  locale?: string
}

export type AnalyticsEventParams = Record<string, string | number | boolean | undefined>

function readGtag(): GtagFn | null {
  const candidate = (globalThis as { gtag?: GtagFn }).gtag
  return typeof candidate === 'function' ? candidate : null
}

function pushDataLayer(args: readonly unknown[]): void {
  const layer = (globalThis as { dataLayer?: unknown[] }).dataLayer
  if (Array.isArray(layer)) {
    layer.push(args)
    return
  }
  ;(globalThis as unknown as { dataLayer: unknown[] }).dataLayer = [args]
}

function gtagInvoke(...args: readonly unknown[]): void {
  const gtag = readGtag()
  if (gtag) {
    gtag(...args)
    return
  }
  pushDataLayer(args)
}

export function isAnalyticsEnabled(): boolean {
  if (typeof location === 'undefined') return false
  const host = location.hostname
  if (host === 'localhost' || host === '127.0.0.1') return false
  return host === 'xid.dev' || host.endsWith('.xid.dev')
}

export function resolveAnalyticsPageGroup(pathname: string): AnalyticsPageGroup {
  if (pathname.startsWith('/account')) return 'account'
  if (
    pathname.startsWith('/sign-in') ||
    pathname.startsWith('/sign-up') ||
    pathname.startsWith('/forgot-password') ||
    pathname.startsWith('/reset-password') ||
    pathname.startsWith('/verify-email') ||
    pathname.startsWith('/mfa') ||
    pathname.startsWith('/consent') ||
    pathname.startsWith('/accept-invitation') ||
    pathname.startsWith('/create-organization') ||
    pathname.startsWith('/select-organization') ||
    pathname.startsWith('/activate') ||
    pathname.startsWith('/ciba-activation')
  ) {
    return 'hosted_auth'
  }
  return 'other'
}

export function buildPublicCanonicalUrl(pathname: string): string {
  return new URL(pathname || '/', PUBLIC_SITE_ORIGIN).toString()
}

export function trackPageView(input: AnalyticsPageView): void {
  if (!isAnalyticsEnabled()) return
  const pageLocation = input.pageLocation ?? `${location.origin}${input.pagePath}`
  const contentGroup = input.contentGroup ?? resolveAnalyticsPageGroup(input.pagePath)

  gtagInvoke('event', 'page_view', {
    send_to: GA_MEASUREMENT_ID,
    page_path: input.pagePath,
    page_title: input.pageTitle,
    page_location: pageLocation,
    content_group: contentGroup,
    ...(input.locale ? { language: input.locale } : {}),
  })
}

export function trackEvent(eventName: string, params: AnalyticsEventParams = {}): void {
  if (!isAnalyticsEnabled()) return
  const cleaned = Object.fromEntries(
    Object.entries({ send_to: GA_MEASUREMENT_ID, ...params }).filter(
      ([, value]) => value !== undefined,
    ),
  )
  gtagInvoke('event', eventName, cleaned)
}

export function setAnalyticsUserId(userId: string | null): void {
  if (!isAnalyticsEnabled()) return
  if (!userId) {
    gtagInvoke('set', { user_id: null })
    return
  }
  gtagInvoke('set', { user_id: userId })
}
