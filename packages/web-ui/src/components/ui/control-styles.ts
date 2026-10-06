// 输入类控件共用外观:line-strong 内描边、聚焦 accent 描边加 accent-wash 外环、触屏 44px 且字号 16px 防 iOS 缩放。

import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { size, text } from '../../styles/scale.stylex'

export const controlStyles = stylex.create({
  base: {
    width: '100%',
    minHeight: { default: size.control, '@media (pointer: coarse)': size.touch },
    margin: 0,
    paddingBlock: 0,
    paddingInline: '0.625rem',
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-surface'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: { default: text.base, '@media (pointer: coarse)': text.md },
    lineHeight: '1.125rem',
    boxSizing: 'border-box',
    outline: 'none',
    transitionProperty: {
      default: 'box-shadow',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: '120ms',
    transitionTimingFunction: 'ease-out',
    '::placeholder': {
      color: tokens['--xid-faint-foreground'],
    },
  },
  large: {
    minHeight: size.touch,
    paddingInline: '0.75rem',
    fontSize: text.md,
  },
  valid: {
    boxShadow: {
      default: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
      ':focus': `inset 0 0 0 1px ${tokens['--xid-accent']}, 0 0 0 3px ${tokens['--xid-accent-wash']}`,
    },
  },
  invalid: {
    boxShadow: {
      default: `inset 0 0 0 1px ${tokens['--xid-danger']}`,
      ':focus': `inset 0 0 0 1px ${tokens['--xid-danger']}, 0 0 0 3px ${tokens['--xid-danger-bg']}`,
    },
  },
  disabled: {
    cursor: 'not-allowed',
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-muted-foreground'],
  },
})

export function isAriaInvalid(value: unknown): boolean {
  return value === true || value === 'true'
}
