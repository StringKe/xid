import { trackEvent } from './google-analytics'

export function trackLogout(): void {
  trackEvent('logout')
}

export function trackLocaleChange(fromLocale: string, toLocale: string): void {
  trackEvent('locale_change', { from_locale: fromLocale, to_locale: toLocale })
}
