// 侧边导航抽屉:无标题栏的 Base UI Dialog,宽 min(20rem, 90vw);头部与关闭按钮由调用方放进 children。
// 几何与进出场复用 foundation.css 的 xid-dialog side 档位。

import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { mergeClassNames } from '../../class-name'

export type DrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  ariaLabel: string
  side?: 'start' | 'end'
  children: ReactNode
}

const styles = stylex.create({
  popup: {
    backgroundColor: tokens['--xid-sidebar'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    boxShadow: tokens['--xid-shadow-lg'],
    overflowY: 'auto',
    overscrollBehavior: 'contain',
  },
})

export function Drawer({
  open,
  onOpenChange,
  ariaLabel,
  side = 'start',
  children,
}: DrawerProps): ReactNode {
  const popup = stylex.props(styles.popup)
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="xid-dialog-backdrop" />
        <BaseDialog.Viewport
          className={`xid-dialog-viewport xid-dialog-narrow-side xid-dialog-regular-side xid-dialog-side-${side}`}
        >
          <BaseDialog.Popup
            aria-label={ariaLabel}
            className={mergeClassNames('xid-dialog-popup', popup.className)}
            style={{ ...popup.style, ['--xid-dialog-width' as string]: '20rem' }}
          >
            {children}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

export const DrawerClose = BaseDialog.Close
