// landing CTA:按设计系统 Button 视觉(primary/secondary/ghost x sm/md/lg)渲染的 <a>。
// 不复用 ui/Button(语义是链接而非按钮,a>button 嵌套非法),视觉口径与 DS 对齐:
// primary 带 1px 暗边 + 内嵌高光,secondary 细边 surface,ghost 无底。

import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { trackCtaClick } from '../../lib/google-analytics-funnel'
import { tokens } from '../../styles/tokens.stylex'
import { space } from './landing-space.stylex'

export const cta = stylex.create({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.snug,
    fontFamily: tokens['--xid-font'],
    fontWeight: 560,
    whiteSpace: 'nowrap',
    textDecorationLine: 'none',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: tokens['--xid-radius'],
    cursor: 'pointer',
    // 按压即时反馈:pointer-down 立刻缩小,与 ui/Button 同口径。
    transform: { default: 'none', ':active': 'scale(0.97)' },
    transitionProperty: 'background-color, border-color, color, box-shadow, transform',
    transitionDuration: '0.2s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
    outline: { default: 'none', ':focus-visible': `2px solid ${tokens['--xid-accent']}` },
    outlineOffset: '2px',
  },
  // 移动端(minHeight <= 48rem)统一抬到 2.75rem,触控目标 >= 44px。
  sm: {
    minHeight: { default: '1.75rem', '@media (max-width: 48rem)': '2.75rem' },
    paddingInline: '0.625rem',
    fontSize: '0.8125rem',
  },
  md: {
    minHeight: { default: '2.25rem', '@media (max-width: 48rem)': '2.75rem' },
    paddingInline: '0.875rem',
    fontSize: '0.875rem',
  },
  lg: {
    minHeight: { default: '2.625rem', '@media (max-width: 48rem)': '2.75rem' },
    paddingInline: '1.125rem',
    fontSize: '1rem',
  },
  primary: {
    backgroundColor: {
      default: tokens['--xid-primary'],
      ':hover': `color-mix(in oklch, ${tokens['--xid-primary']} 92%, black)`,
      ':active': `color-mix(in oklch, ${tokens['--xid-primary']} 82%, black)`,
    },
    color: tokens['--xid-primary-foreground'],
    borderColor: `color-mix(in oklch, ${tokens['--xid-primary']} 84%, black)`,
    boxShadow: 'inset 0 1px 0 oklch(1 0 0 / 0.08), 0 1px 1px oklch(0.165 0.014 264 / 0.08)',
  },
  secondary: {
    backgroundColor: {
      default: tokens['--xid-surface'],
      ':hover': tokens['--xid-muted'],
      ':active': `color-mix(in oklch, ${tokens['--xid-muted']} 90%, black)`,
    },
    color: tokens['--xid-fg'],
    borderColor: tokens['--xid-border-strong'],
    boxShadow: '0 1px 1px oklch(0.165 0.014 264 / 0.05)',
  },
  ghost: {
    backgroundColor: {
      default: 'transparent',
      ':hover': tokens['--xid-muted'],
      ':active': `color-mix(in oklch, ${tokens['--xid-muted']} 90%, black)`,
    },
    color: tokens['--xid-fg'],
  },
  fullWidth: { width: '100%' },
})

export type CtaVariant = 'primary' | 'secondary' | 'ghost'
export type CtaSize = 'sm' | 'md' | 'lg'

export type CtaLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'style'> & {
  variant?: CtaVariant
  size?: CtaSize
  fullWidth?: boolean
  analyticsId?: string
  analyticsPlacement?: string
  children: ReactNode
}

export function CtaLink({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  analyticsId,
  analyticsPlacement,
  children,
  onClick,
  href = '#',
  ...rest
}: CtaLinkProps): ReactNode {
  function handleClick(event: MouseEvent<HTMLAnchorElement>): void {
    if (analyticsId) {
      trackCtaClick({
        ctaId: analyticsId,
        href,
        placement: analyticsPlacement,
      })
    }
    onClick?.(event)
  }

  return (
    <a
      {...rest}
      href={href}
      onClick={handleClick}
      {...stylex.props(cta.base, cta[size], cta[variant], fullWidth && cta.fullWidth)}
    >
      {children}
    </a>
  )
}
