// 账户门户的日期按当前 locale 格式化,不显示 ISO 原文。

import { useLingui } from '@lingui/react/macro'

export type AccountDates = {
  date: (iso: string) => string
  dateTime: (iso: string) => string
}

export function useAccountDates(): AccountDates {
  const { i18n } = useLingui()
  return {
    date: (iso) => i18n.date(new Date(iso), { dateStyle: 'medium' }),
    dateTime: (iso) => i18n.date(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }),
  }
}

// 会话位置存为 "City, CC";国家代码按 locale 显示名称。
export function useLocationLabel(): (location: string | null) => string | null {
  const { i18n } = useLingui()
  return (location) => {
    if (!location) return null
    const parts = location.split(', ')
    const code = parts.length > 1 ? parts.at(-1) : parts[0]
    if (!code || !/^[A-Z]{2}$/u.test(code)) return location
    const country = new Intl.DisplayNames([i18n.locale], { type: 'region' }).of(code) ?? code
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, ${country}` : country
  }
}
