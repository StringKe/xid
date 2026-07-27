// Button:语义 <button>,变体(primary/secondary/ghost/danger)+ loading 态。
// loading 时 disabled + aria-busy,内联 Spinner;文案由 children 提供(调用方走 lingui)。
// 统一管理 UI 的字重、缓动和 primary 暗边,避免同一操作层级出现多套视觉反馈。
// focus-visible 走全局 :focus-visible outline(styles.css),组件不自带焦点样式。

import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { mergeClassNames } from '../../class-name'
import { Spinner } from './Spinner'

export const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger'] as const
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number]

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  isLoading?: boolean
  fullWidth?: boolean
}

const transition = {
  transitionProperty: {
    default: 'background-color, border-color, color, opacity, transform',
    '@media (prefers-reduced-motion: reduce)': 'none',
  },
  transitionDuration: '0.12s',
  transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const

const styles = stylex.create({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    // 桌面密度 38px;触屏设备抬到 44px 触控目标,不影响鼠标端密度。
    minHeight: {
      default: '2.375rem',
      '@media (pointer: coarse)': '2.75rem',
    },
    paddingBlock: 0,
    paddingInline: '0.875rem',
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    fontFamily: tokens['--xid-font'],
    fontSize: '0.875rem',
    fontWeight: 560,
    // 按钮文案永不折行:窄表格列里两字按钮折成竖排会破坏触控目标形状。
    whiteSpace: 'nowrap',
    // 按压即时反馈:pointer-down 立刻缩小(Apple 流体手感);disabled/loading
    // 的 <button> 不触发 :active,天然豁免。
    transform: { default: 'none', ':active': 'scale(0.97)' },
    ...transition,
  },
  // hover/active 用 color-mix 向 black 暗化,避免引入脱离主题 token 的 oklch/hex 字面量;
  // 1px 同色暗边替代阴影给按钮收边。
  primary: {
    backgroundColor: {
      default: tokens['--xid-primary'],
      ':hover': `color-mix(in oklch, ${tokens['--xid-primary']} 92%, black)`,
      ':active': `color-mix(in oklch, ${tokens['--xid-primary']} 82%, black)`,
    },
    color: tokens['--xid-primary-foreground'],
    borderColor: `color-mix(in oklch, ${tokens['--xid-primary']} 84%, black)`,
  },
  secondary: {
    backgroundColor: {
      default: tokens['--xid-surface'],
      ':hover': tokens['--xid-muted'],
      ':active': tokens['--xid-muted'],
    },
    color: tokens['--xid-fg'],
    borderColor: tokens['--xid-border-strong'],
  },
  ghost: {
    backgroundColor: {
      default: 'transparent',
      ':hover': tokens['--xid-muted'],
      ':active': tokens['--xid-muted'],
    },
    color: tokens['--xid-fg'],
  },
  danger: {
    backgroundColor: {
      default: tokens['--xid-danger'],
      ':hover': `color-mix(in oklch, ${tokens['--xid-danger']} 92%, black)`,
      ':active': `color-mix(in oklch, ${tokens['--xid-danger']} 82%, black)`,
    },
    color: tokens['--xid-danger-foreground'],
    borderColor: `color-mix(in oklch, ${tokens['--xid-danger']} 84%, black)`,
  },
  fullWidth: {
    width: '100%',
  },
  enabled: {
    cursor: 'pointer',
    opacity: 1,
  },
  disabled: {
    cursor: 'not-allowed',
    opacity: 0.55,
  },
})

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    isLoading = false,
    fullWidth = false,
    disabled,
    className,
    style,
    children,
    ...rest
  },
  ref,
): ReactNode {
  const isDisabled = disabled || isLoading
  const base = stylex.props(
    styles.base,
    styles[variant],
    fullWidth && styles.fullWidth,
    isDisabled ? styles.disabled : styles.enabled,
  )

  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={isDisabled}
      aria-busy={isLoading || undefined}
      className={mergeClassNames(base.className, className)}
      style={{ ...base.style, ...style }}
      {...rest}
    >
      {isLoading ? <Spinner size={16} /> : null}
      {children}
    </button>
  )
})
