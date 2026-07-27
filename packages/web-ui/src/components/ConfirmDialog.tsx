// ConfirmDialog:危险操作二次确认对话框(删除/撤销)。
// 用 <dialog> 原生元素实现(a11y:focus trap / aria-modal / Escape 关闭)。
// 调用方传 onConfirm(async) + onCancel;isLoading 期间禁止重复提交。
// 文案全走 lingui(children prop),禁硬编码。
// 进出场由 motion 驱动:打开 opacity + scale 0.96 -> 1;取消(按钮 / Escape)先播 exit,
// onAnimationComplete 后再 close + 回调父级卸载(backdrop 淡出见 styles.css)。
// 确认成功路径由父级直接卸载,不走 exit(组件无法拦截父级 unmount)。

import { Trans } from '@lingui/react/macro'
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { motion, springSnappy } from '../motion'
import { tokens } from '../styles/tokens.stylex'
import { Button } from './ui'

export type ConfirmDialogProps = {
  // 对话框标题(已本地化)。
  title: ReactNode
  // 对话框描述内容(已本地化)。
  description: ReactNode
  // 确认按钮文案(默认 "Confirm")。
  confirmLabel?: ReactNode
  // 确认按钮变体(默认 danger)。
  confirmVariant?: 'danger' | 'primary'
  isLoading?: boolean
  onConfirm: () => void
  onCancel: () => void
}

const styles = stylex.create({
  dialog: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-lg'],
    background: tokens['--xid-surface'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    padding: '1.5rem',
    maxWidth: '22rem',
    width: '90vw',
    boxShadow: tokens['--xid-shadow-lg'],
  },
  title: {
    margin: '0 0 0.75rem',
    fontSize: '1rem',
    fontWeight: 700,
  },
  description: {
    margin: '0 0 1.5rem',
    fontSize: '0.875rem',
    lineHeight: 1.5,
    color: tokens['--xid-muted-foreground'],
  },
  actions: {
    display: 'flex',
    gap: '0.75rem',
    justifyContent: 'flex-end',
  },
})

const motionEnter = { opacity: 1, scale: 1 } as const
const motionExit = { opacity: 0, scale: 0.96 } as const

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  confirmVariant = 'danger',
  isLoading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null)
  // true = 正在播 exit;动画完成才 close + 通知父级。
  const [closing, setClosing] = useState(false)
  const titleId = useId()
  const descId = useId()

  // 挂载即打开 dialog(modal mode),卸载时关闭。
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    el.showModal()
    return () => el.close()
  }, [])

  // Escape 默认会触发 cancel 事件并关闭 dialog;接管为先播 exit 再关闭。
  const handleCancel = (event: React.SyntheticEvent): void => {
    event.preventDefault()
    setClosing(true)
  }

  const handleAnimationComplete = (): void => {
    if (!closing) return
    dialogRef.current?.close()
    onCancel()
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-redundant-roles
    <motion.dialog
      ref={dialogRef}
      onCancel={handleCancel}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      initial={motionExit}
      animate={closing ? motionExit : motionEnter}
      transition={springSnappy}
      onAnimationComplete={handleAnimationComplete}
      {...stylex.props(styles.dialog)}
    >
      <h2 id={titleId} {...stylex.props(styles.title)}>
        {title}
      </h2>

      <p id={descId} {...stylex.props(styles.description)}>
        {description}
      </p>

      <div {...stylex.props(styles.actions)}>
        <Button
          variant="secondary"
          disabled={isLoading || closing}
          onClick={() => setClosing(true)}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button variant={confirmVariant} isLoading={isLoading} onClick={onConfirm}>
          {confirmLabel ?? <Trans>Confirm</Trans>}
        </Button>
      </div>
    </motion.dialog>
  )
}
