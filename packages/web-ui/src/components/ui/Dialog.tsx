// Base UI Dialog 封装:position 按视口档位选择居中、底部 sheet、全屏或侧边抽屉。
// 几何与进出场在 foundation.css(依赖 data-starting-style),颜色与排版走 StyleX。

import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { useLingui } from '@lingui/react/macro'
import type { ReactNode, RefObject } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text, weight } from '../../styles/scale.stylex'
import { mergeClassNames } from '../../class-name'
import { resolveResponsive, type Responsive } from '../../responsive'
import { Icon } from './Icon'

export const DIALOG_POSITIONS = ['center', 'sheet', 'fullscreen', 'side'] as const
export type DialogPosition = (typeof DIALOG_POSITIONS)[number]

export const DIALOG_SIZES = { sm: '27.5rem', md: '32.5rem', lg: '40rem' } as const
export type DialogSize = keyof typeof DIALOG_SIZES

export type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenChangeComplete?: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  position?: Responsive<DialogPosition>
  size?: DialogSize
  // 侧边抽屉从哪一侧出现。
  side?: 'start' | 'end'
  dismissible?: boolean
  initialFocus?: RefObject<HTMLElement | null>
}

export const DEFAULT_DIALOG_POSITION: Responsive<DialogPosition> = {
  narrow: 'sheet',
  regular: 'center',
}

const STACKED_ON_NARROW = new Set<DialogPosition>(['sheet', 'fullscreen', 'side'])

const styles = stylex.create({
  popup: {
    backgroundColor: tokens['--xid-surface'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    boxShadow: tokens['--xid-shadow-lg'],
    gap: '1.25rem',
    padding: { default: '1.5rem', '@media (max-width: 47.99rem)': '1rem' },
    overflowY: 'auto',
    overscrollBehavior: 'contain',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.75rem',
  },
  headerText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    flexGrow: 1,
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: text.lg,
    fontWeight: weight.display,
    lineHeight: '1.625rem',
    letterSpacing: tokens['--xid-tracking-title'],
    textWrap: 'balance',
  },
  description: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: { default: text.base, '@media (max-width: 47.99rem)': text.md },
    lineHeight: { default: '1.375rem', '@media (max-width: 47.99rem)': '1.5rem' },
  },
  close: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: { default: '2rem', '@media (pointer: coarse)': '2.75rem' },
    height: { default: '2rem', '@media (pointer: coarse)': '2.75rem' },
    marginBlockStart: '-0.25rem',
    marginInlineEnd: '-0.5rem',
    padding: 0,
    borderWidth: 0,
    borderRadius: tokens['--xid-radius'],
    backgroundColor: { default: 'transparent', ':hover': tokens['--xid-muted'] },
    color: tokens['--xid-muted-foreground'],
    cursor: 'pointer',
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    minWidth: 0,
  },
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  footerStackedOnNarrow: {
    flexDirection: { default: 'row', '@media (max-width: 47.99rem)': 'column-reverse' },
    alignItems: { default: 'center', '@media (max-width: 47.99rem)': 'stretch' },
  },
})

function positionClassName(position: Responsive<DialogPosition>, side: 'start' | 'end'): string {
  const resolved = resolveResponsive(position, 'center')
  return [
    `xid-dialog-narrow-${resolved.narrow}`,
    `xid-dialog-regular-${resolved.regular}`,
    `xid-dialog-side-${side}`,
  ].join(' ')
}

export function Dialog({
  open,
  onOpenChange,
  onOpenChangeComplete,
  title,
  description,
  children,
  footer,
  position = DEFAULT_DIALOG_POSITION,
  size = 'sm',
  side = 'end',
  dismissible = true,
  initialFocus,
}: DialogProps): ReactNode {
  const { t } = useLingui()
  const narrow = resolveResponsive(position, 'center').narrow
  const popup = stylex.props(styles.popup)

  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !dismissible) return
        onOpenChange(next)
      }}
      onOpenChangeComplete={onOpenChangeComplete}
      disablePointerDismissal={!dismissible}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="xid-dialog-backdrop" />
        <BaseDialog.Viewport
          className={mergeClassNames('xid-dialog-viewport', positionClassName(position, side))}
        >
          <BaseDialog.Popup
            initialFocus={initialFocus}
            className={mergeClassNames('xid-dialog-popup', popup.className)}
            style={{ ...popup.style, ['--xid-dialog-width' as string]: DIALOG_SIZES[size] }}
          >
            <div {...stylex.props(styles.header)}>
              <div {...stylex.props(styles.headerText)}>
                <BaseDialog.Title {...stylex.props(styles.title)}>{title}</BaseDialog.Title>
                {description ? (
                  <BaseDialog.Description {...stylex.props(styles.description)}>
                    {description}
                  </BaseDialog.Description>
                ) : null}
              </div>
              {dismissible ? (
                <BaseDialog.Close aria-label={t`Close`} {...stylex.props(styles.close)}>
                  <Icon name="x" size={16} />
                </BaseDialog.Close>
              ) : null}
            </div>
            {children ? <div {...stylex.props(styles.body)}>{children}</div> : null}
            {footer ? (
              <div
                {...stylex.props(
                  styles.footer,
                  STACKED_ON_NARROW.has(narrow) && styles.footerStackedOnNarrow,
                )}
              >
                {footer}
              </div>
            ) : null}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
