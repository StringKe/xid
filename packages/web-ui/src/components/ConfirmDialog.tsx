// 二次确认:挂载即打开;取消先播关闭动画,动画结束再通知父级卸载。
// 窄屏是底部 sheet,按钮堆叠在拇指区;宽屏居中,取消与主操作分在两侧。

import { Trans } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Alert, Button, Dialog, type DialogPosition } from './ui'
import type { Responsive } from '../responsive'

export type ConfirmDialogProps = {
  title: ReactNode
  description: ReactNode
  // 交互控件放 children,勿塞进 description(aria-describedby 段落不应含控件)。
  children?: ReactNode
  // 模态遮罩会盖住页面级提示,确认失败的原因必须在框内展示。
  error?: ReactNode
  confirmLabel?: ReactNode
  confirmVariant?: 'danger' | 'primary'
  isLoading?: boolean
  position?: Responsive<DialogPosition>
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  description,
  children,
  error,
  confirmLabel,
  confirmVariant = 'danger',
  isLoading = false,
  position,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactNode {
  const [open, setOpen] = useState(true)

  function requestClose(): void {
    if (isLoading) return
    setOpen(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose()
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onCancel()
      }}
      title={title}
      description={description}
      position={position}
      dismissible={!isLoading}
      footer={
        <>
          <Button variant="secondary" size="md" disabled={isLoading} onClick={requestClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant={confirmVariant} isLoading={isLoading} onClick={onConfirm}>
            {confirmLabel ?? <Trans>Confirm</Trans>}
          </Button>
        </>
      }
    >
      {children || error ? (
        <>
          {children}
          {error ? <Alert tone="error">{error}</Alert> : null}
        </>
      ) : null}
    </Dialog>
  )
}
