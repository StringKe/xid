// 证书到期与最近登录时间的显示计算。

import type { I18n } from '@lingui/core'

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

export const CERTIFICATE_WARNING_DAYS = 30

export function daysUntil(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : Math.ceil((time - now) / DAY_MS)
}

export function earliestExpiry<T extends { notAfter: string | null }>(
  items: readonly T[],
): T | null {
  return items.reduce<T | null>((earliest, item) => {
    if (!item.notAfter) return earliest
    if (!earliest?.notAfter) return item
    return Date.parse(item.notAfter) < Date.parse(earliest.notAfter) ? item : earliest
  }, null)
}

export function relativeTime(i18n: I18n, value: string, now = Date.now()): string {
  const diff = Date.parse(value) - now
  const format = new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto' })
  const abs = Math.abs(diff)
  if (abs < HOUR_MS) return format.format(Math.round(diff / MINUTE_MS), 'minute')
  if (abs < DAY_MS) return format.format(Math.round(diff / HOUR_MS), 'hour')
  if (abs < 30 * DAY_MS) return format.format(Math.round(diff / DAY_MS), 'day')
  return i18n.date(new Date(value), { dateStyle: 'medium' })
}

export function protocolLabel(type: string): string {
  if (type === 'saml') return 'SAML 2.0'
  if (type === 'oidc') return 'OpenID Connect'
  if (type === 'wsfed') return 'WS-Federation'
  return type.toUpperCase()
}

// 指纹只显示首尾各三组,完整值放 title。
export function shortFingerprint(value: string): string {
  const parts = value.split(':')
  if (parts.length <= 6) return value
  return `${parts.slice(0, 3).join(':')}:…:${parts.slice(-2).join(':')}`
}
