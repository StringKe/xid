// 产品转化漏斗事件(映射 GA4 推荐事件 + XID 自定义维度)。

import { trackEvent } from './google-analytics'

export function trackLogout(): void {
  trackEvent('logout')
}

export function trackLocaleChange(fromLocale: string, toLocale: string): void {
  trackEvent('locale_change', { from_locale: fromLocale, to_locale: toLocale })
}
