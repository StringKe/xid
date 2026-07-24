// Reveal:滚动入场包装(设计稿 .rv/.rv--in)。隐藏态只在客户端施加,
// IntersectionObserver 命中后一次性显示;reduced-motion 或无 IO 环境直接显示终态。

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'

export function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

const styles = stylex.create({
  base: {
    opacity: { default: 0, '@media (prefers-reduced-motion: reduce)': 1 },
    transform: {
      default: 'translateY(14px)',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionProperty: 'opacity, transform',
    transitionDuration: { default: '0.5s', '@media (prefers-reduced-motion: reduce)': '0s' },
    transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
  },
  seen: { opacity: 1, transform: 'none' },
})

export type RevealProps = {
  children: ReactNode
  as?: 'div' | 'article' | 'header'
  // 同组元素错峰入场(ms),经 inline transitionDelay 注入。
  delayMs?: number
  // 调用方的容器样式(布局/外观),与 reveal 态合并。
  sx?: StyleXStyles | ReadonlyArray<StyleXStyles>
}

export function Reveal({ children, as: Tag = 'div', delayMs = 0, sx }: RevealProps): ReactNode {
  const ref = useRef<HTMLElement | null>(null)
  const [seen, setSeen] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (prefersReducedMotion() || !('IntersectionObserver' in globalThis)) {
      setSeen(true)
      return
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setSeen(true)
          io.disconnect()
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    )
    const observe = (): void => {
      io.observe(el)
    }
    let cancel: (() => void) | undefined
    if ('requestIdleCallback' in globalThis) {
      const idleId = globalThis.requestIdleCallback(observe, { timeout: 800 })
      cancel = () => globalThis.cancelIdleCallback(idleId)
    } else {
      const rafId = globalThis.requestAnimationFrame(observe)
      cancel = () => globalThis.cancelAnimationFrame(rafId)
    }
    return () => {
      cancel?.()
      io.disconnect()
    }
  }, [])

  const extra = Array.isArray(sx) ? sx : [sx]
  return (
    <Tag
      // 多 tag 共用同一 ref 回调,HTMLElement 足够。
      ref={ref as never}
      {...stylex.props(styles.base, seen && styles.seen, ...extra)}
      style={delayMs ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      {children}
    </Tag>
  )
}
