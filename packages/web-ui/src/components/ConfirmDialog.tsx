// 危险操作二次确认:<dialog> 原生 a11y;取消/Escape 先播 exit 再 close;
// 确认成功由父级卸载不走 exit(组件无法拦截 unmount)。

import { Trans } from '@lingui/react/macro'
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { motion, springSnappy } from '../motion'
import { tokens } from '../styles/tokens.stylex'
import { Button } from './ui'

export type ConfirmDialogProps = {
  title: ReactNode
  description: ReactNode
  // 交互控件放 children,勿塞进 description 的 <p>(aria-describedby 段落不应含控件)。
  children?: ReactNode
  confirmLabel?: ReactNode
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
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    marginTop: '-0.75rem',
    marginBottom: '1.5rem',
  },
})

const motionEnter = { opacity: 1, scale: 1 } as const
const motionExit = { opacity: 0, scale: 0.96 } as const

export function ConfirmDialog({
  title,
  description,
  children,
  confirmLabel,
  confirmVariant = 'danger',
  isLoading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null)
  // exit 播完才 close + 通知父级。
  const [closing, setClosing] = useState(false)
  const titleId = useId()
  const descId = useId()

  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    el.showModal()
    return () => el.close()
  }, [])

  // 原生 cancel 会立刻关 dialog;接管为先播 exit。
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

      {children ? <div {...stylex.props(styles.form)}>{children}</div> : null}

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
