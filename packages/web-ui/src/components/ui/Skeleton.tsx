// 占位与最终内容同尺寸;200ms 内完成的加载不闪骨架(外层延迟淡入,内层呼吸)。

import type { HTMLAttributes, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { mergeClassNames } from '../../class-name'

export type SkeletonProps = HTMLAttributes<HTMLSpanElement> & {
  width?: string | number
  height?: string | number
  radius?: string
}

export const SKELETON_DELAY_MS = 200

const appear = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
})

const pulse = stylex.keyframes({
  from: { opacity: 1 },
  '50%': { opacity: 0.55 },
  to: { opacity: 1 },
})

const styles = stylex.create({
  delay: {
    display: 'block',
    opacity: 0,
    animationName: appear,
    animationDuration: '150ms',
    animationDelay: `${SKELETON_DELAY_MS}ms`,
    animationFillMode: 'forwards',
    animationTimingFunction: 'ease-out',
  },
  base: {
    display: 'block',
    backgroundColor: tokens['--xid-muted'],
    borderRadius: tokens['--xid-radius-sm'],
    animationName: { default: pulse, '@media (prefers-reduced-motion: reduce)': 'none' },
    animationDuration: '1.4s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
  },
})

export function Skeleton({
  width = '100%',
  height = '1rem',
  radius,
  className,
  style,
  ...rest
}: SkeletonProps): ReactNode {
  const base = stylex.props(styles.base)
  return (
    <span aria-hidden="true" {...stylex.props(styles.delay)}>
      <span
        className={mergeClassNames(base.className, className)}
        style={{ ...base.style, display: 'block', width, height, borderRadius: radius, ...style }}
        {...rest}
      />
    </span>
  )
}
