// <48rem 的账户分段导航:横向滚动,当前项滚入视口;还有未露出的项时对应边缘渐隐,提示可以滑动。

import { useLingui } from '@lingui/react/macro'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { Link, useLocation } from '@xid-kit/web-ui/tanstack-router'
import { tokens } from '../../styles/tokens.stylex'
import { ACCOUNT_NAV_ITEMS, isActiveAccountPath } from './account-nav-items'

type Overflow = { start: boolean; end: boolean }

const NO_OVERFLOW: Overflow = { start: false, end: false }

const styles = stylex.create({
  frame: {
    position: 'relative',
  },
  segmented: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '1.25rem',
    paddingInline: '1rem',
    overflowX: 'auto',
    scrollbarWidth: 'none',
    scrollPaddingInline: '2.5rem',
  },
  segment: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    minHeight: '2.75rem',
    borderBottomWidth: '2px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'transparent',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    lineHeight: '1.125rem',
    whiteSpace: 'nowrap',
    textDecoration: 'none',
  },
  segmentActive: {
    borderBottomColor: tokens['--xid-fg'],
    color: tokens['--xid-fg'],
    fontWeight: weight.medium,
  },
  fade: {
    position: 'absolute',
    insetBlock: 0,
    width: '2.5rem',
    pointerEvents: 'none',
    opacity: 0,
    transitionProperty: { default: 'opacity', '@media (prefers-reduced-motion: reduce)': 'none' },
    transitionDuration: '150ms',
    transitionTimingFunction: 'ease-out',
  },
  fadeStart: {
    left: 0,
    backgroundImage: `linear-gradient(to right, ${tokens['--xid-sidebar']} 30%, transparent)`,
  },
  fadeEnd: {
    right: 0,
    backgroundImage: `linear-gradient(to left, ${tokens['--xid-sidebar']} 30%, transparent)`,
  },
  fadeVisible: {
    opacity: 1,
  },
})

function overflowOf(element: HTMLElement): Overflow {
  const maxScroll = element.scrollWidth - element.clientWidth
  if (maxScroll <= 1) return NO_OVERFLOW
  const offset = Math.abs(element.scrollLeft)
  return { start: offset > 1, end: offset < maxScroll - 1 }
}

function useHorizontalOverflow(navRef: { current: HTMLElement | null }): Overflow {
  const [overflow, setOverflow] = useState<Overflow>(NO_OVERFLOW)
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const update = (): void => {
      const next = overflowOf(nav)
      setOverflow((current) =>
        current.start === next.start && current.end === next.end ? current : next,
      )
    }
    update()
    nav.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(nav)
    return () => {
      nav.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [navRef])
  return overflow
}

export function AccountSegmentedNav(): ReactNode {
  const { t } = useLingui()
  const location = useLocation()
  const navRef = useRef<HTMLElement | null>(null)
  const overflow = useHorizontalOverflow(navRef)
  useEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [location.pathname])
  return (
    <div {...stylex.props(styles.frame)}>
      <nav ref={navRef} aria-label={t`Account`} {...stylex.props(styles.segmented)}>
        {ACCOUNT_NAV_ITEMS.map((item) => {
          const active = isActiveAccountPath(location.pathname, item.to)
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active ? 'page' : undefined}
              {...stylex.props(styles.segment, active && styles.segmentActive)}
            >
              {item.label}
            </Link>
          )
        })}
      </nav>
      <span
        aria-hidden="true"
        {...stylex.props(styles.fade, styles.fadeStart, overflow.start && styles.fadeVisible)}
      />
      <span
        aria-hidden="true"
        {...stylex.props(styles.fade, styles.fadeEnd, overflow.end && styles.fadeVisible)}
      />
    </div>
  )
}
