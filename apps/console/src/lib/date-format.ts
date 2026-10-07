// Console 所有表格与详情的日期统一按当前界面语言的 medium 样式显示。

import type { I18n } from '@lingui/core'

type DateValue = string | number | null | undefined

export function formatDate(i18n: I18n, value: DateValue): string | null {
  if (value === null || value === undefined || value === '') return null
  return i18n.date(new Date(value), { dateStyle: 'medium' })
}

export function formatDateTime(i18n: I18n, value: DateValue): string | null {
  if (value === null || value === undefined || value === '') return null
  return i18n.date(new Date(value), { dateStyle: 'medium', timeStyle: 'short' })
}
