// 非模态弹出层;trigger 必须是能转发 ref 与 props 的按钮元素(例如 Button)。

import { Popover as BasePopover } from '@base-ui/react/popover'
import type { ReactElement, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text, weight } from '../../styles/scale.stylex'
import { mergeClassNames } from '../../class-name'
import { popupStyles } from './popup-styles'

export type PopoverProps = {
  trigger: ReactElement
  title?: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

const styles = stylex.create({
  surface: {
    gap: '0.5rem',
    padding: '0.875rem 1rem',
    maxWidth: 'min(22rem, var(--available-width))',
  },
  title: {
    margin: 0,
    fontSize: text.base,
    fontWeight: weight.medium,
    color: tokens['--xid-fg'],
  },
})

export function Popover({
  trigger,
  title,
  children,
  side = 'bottom',
  align = 'center',
  open,
  onOpenChange,
}: PopoverProps): ReactNode {
  const surface = stylex.props(popupStyles.surface, styles.surface)
  return (
    <BasePopover.Root
      open={open}
      onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}
    >
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner
          side={side}
          align={align}
          sideOffset={6}
          {...stylex.props(popupStyles.positioner)}
        >
          <BasePopover.Popup className={mergeClassNames(surface.className, 'xid-motion-pop')}>
            {title ? (
              <BasePopover.Title {...stylex.props(styles.title)}>{title}</BasePopover.Title>
            ) : null}
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  )
}
