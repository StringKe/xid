// 既有页面的提示入口,外观与行为同 Notice;tone=error 对应 Notice 的 danger。

import type { CSSProperties, ReactNode } from 'react'
import { Notice, type NoticeTone } from './Notice'

export const ALERT_TONES = ['error', 'success', 'warning', 'info'] as const
export type AlertTone = (typeof ALERT_TONES)[number]

export type AlertProps = {
  tone?: AlertTone
  title?: ReactNode
  action?: ReactNode
  style?: CSSProperties
  children: ReactNode
}

const NOTICE_TONE: Record<AlertTone, NoticeTone> = {
  error: 'danger',
  success: 'success',
  warning: 'warning',
  info: 'info',
}

export function Alert({ tone = 'info', title, action, style, children }: AlertProps): ReactNode {
  return (
    <Notice tone={NOTICE_TONE[tone]} title={title} action={action} style={style}>
      {children}
    </Notice>
  )
}
