import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { formatDate, formatDateTime } from '../lib/date-format'

// 表格单元格等拿不到 i18n 的位置用它渲染日期,格式与 Users 列表一致。
export function FormattedDate({
  value,
  time = false,
}: {
  value: string | number
  time?: boolean
}): ReactNode {
  const { i18n } = useLingui()
  return <>{time ? formatDateTime(i18n, value) : formatDate(i18n, value)}</>
}
