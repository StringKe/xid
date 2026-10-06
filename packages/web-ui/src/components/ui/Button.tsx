// 禁用与加载用 aria-disabled 而非 disabled 属性:按钮保持可聚焦,读屏能读到原因;点击在此吞掉。
// focus-visible 走全局 outline(styles.css)。

import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { media, size, text, weight } from '../../styles/scale.stylex'
import { mergeClassNames } from '../../class-name'
import type { Responsive } from '../../responsive'
import { responsiveHiddenClassName } from './responsive-hidden'
import { Spinner } from './Spinner'

export const BUTTON_VARIANTS = ['primary', 'accent', 'secondary', 'ghost', 'danger'] as const
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number]

export const BUTTON_SIZES = ['md', 'lg'] as const
export type ButtonSize = (typeof BUTTON_SIZES)[number]

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'hidden'> & {
  variant?: ButtonVariant
  size?: ButtonSize
  isLoading?: boolean
  fullWidth?: boolean
  hidden?: Responsive<boolean>
}

const styles = stylex.create({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.375rem',
    minHeight: { default: size.control, [media.coarse]: size.touch },
    paddingBlock: 0,
    paddingInline: '0.875rem',
    borderRadius: tokens['--xid-radius'],
    borderWidth: 0,
    borderStyle: 'none',
    fontFamily: tokens['--xid-font'],
    fontSize: text.base,
    lineHeight: '1.125rem',
    fontWeight: weight.medium,
    whiteSpace: 'nowrap',
    textDecoration: 'none',
    cursor: 'pointer',
    transform: { default: 'none', ':active': 'scale(0.97)' },
    transitionProperty: {
      default: 'background-color, box-shadow, color, transform',
      [media.reducedMotion]: 'none',
    },
    transitionDuration: '120ms',
    transitionTimingFunction: 'ease-out',
  },
  large: {
    minHeight: size.touch,
    paddingInline: '1rem',
  },
  primary: {
    backgroundColor: {
      default: tokens['--xid-primary'],
      ':hover': `color-mix(in srgb, ${tokens['--xid-primary']} 84%, transparent)`,
    },
    color: tokens['--xid-primary-foreground'],
  },
  accent: {
    backgroundColor: { default: tokens['--xid-accent'], ':hover': tokens['--xid-accent-strong'] },
    color: tokens['--xid-accent-foreground'],
  },
  secondary: {
    backgroundColor: { default: tokens['--xid-surface'], ':hover': tokens['--xid-muted'] },
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
    color: tokens['--xid-fg'],
  },
  ghost: {
    backgroundColor: { default: 'transparent', ':hover': tokens['--xid-muted'] },
    color: tokens['--xid-fg'],
    paddingInline: '0.75rem',
  },
  danger: {
    backgroundColor: {
      default: tokens['--xid-danger'],
      ':hover': `color-mix(in srgb, ${tokens['--xid-danger']} 86%, transparent)`,
    },
    color: tokens['--xid-danger-foreground'],
  },
  fullWidth: {
    width: '100%',
  },
  unavailable: {
    cursor: 'not-allowed',
    opacity: 0.55,
  },
  busy: {
    cursor: 'progress',
  },
})

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size: buttonSize = 'md',
    isLoading = false,
    fullWidth = false,
    disabled = false,
    hidden,
    className,
    style,
    children,
    onClick,
    type = 'button',
    ...rest
  },
  ref,
): ReactNode {
  const isBlocked = disabled || isLoading
  const base = stylex.props(
    styles.base,
    buttonSize === 'lg' && styles.large,
    styles[variant],
    fullWidth && styles.fullWidth,
    disabled && styles.unavailable,
    isLoading && styles.busy,
  )

  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    if (isBlocked) {
      event.preventDefault()
      return
    }
    onClick?.(event)
  }

  return (
    <button
      ref={ref}
      type={type}
      aria-disabled={isBlocked || undefined}
      aria-busy={isLoading || undefined}
      className={mergeClassNames(base.className, responsiveHiddenClassName(hidden), className)}
      style={{ ...base.style, ...style }}
      onClick={handleClick}
      {...rest}
    >
      {isLoading ? <Spinner size={16} /> : null}
      {children}
    </button>
  )
})
