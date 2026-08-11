import type { HTMLAttributes, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { motion, springDefault } from '../../motion'
import { tokens } from '../../styles/tokens.stylex'
import { mergeClassNames } from '../../class-name'

export type SkeletonProps = HTMLAttributes<HTMLDivElement> & {
  width?: string | number
  height?: string | number
  radius?: string
}

const pulse = stylex.keyframes({
  from: { opacity: 1 },
  '50%': { opacity: 0.55 },
  to: { opacity: 1 },
})

const styles = stylex.create({
  base: {
    display: 'block',
    backgroundColor: tokens['--xid-muted'],
    borderRadius: tokens['--xid-radius-sm'],
    animationName: {
      default: pulse,
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
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
  // pulse 是 CSS animation,会盖掉同元素 motion opacity;enter 挂外层,父子 opacity 相乘互不干扰。
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={springDefault}>
      <div
        aria-hidden="true"
        className={mergeClassNames(base.className, className)}
        style={{
          ...base.style,
          width,
          height,
          borderRadius: radius,
          ...style,
        }}
        {...rest}
      />
    </motion.div>
  )
}
