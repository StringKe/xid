// 只放补充说明;触屏上不显示,关键信息不能只放在 tooltip 里。

import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import type { ReactElement, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text } from '../../styles/scale.stylex'
import { mergeClassNames } from '../../class-name'
import { popupStyles } from './popup-styles'

export type TooltipProps = {
  label: ReactNode
  children: ReactElement
  side?: 'top' | 'bottom' | 'left' | 'right'
}

const styles = stylex.create({
  popup: {
    maxWidth: '18rem',
    paddingBlock: '0.375rem',
    paddingInline: '0.5rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-code'],
    color: tokens['--xid-code-foreground'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.xs,
    lineHeight: '1rem',
  },
})

export function TooltipProvider({ children }: { children: ReactNode }): ReactNode {
  return <BaseTooltip.Provider delay={500}>{children}</BaseTooltip.Provider>
}

export function Tooltip({ label, children, side = 'top' }: TooltipProps): ReactNode {
  const popup = stylex.props(styles.popup)
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner
          side={side}
          sideOffset={6}
          {...stylex.props(popupStyles.positioner)}
        >
          <BaseTooltip.Popup className={mergeClassNames(popup.className, 'xid-motion-fade')}>
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}
