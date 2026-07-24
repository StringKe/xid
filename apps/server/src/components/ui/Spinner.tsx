// Spinner:加载态指示。role=status + 可见文案走 lingui(屏幕阅读器可读)。
// 视觉走 StyleX,取色 currentColor 随上下文前景自适应;尺寸由 size(px)控制。
// 旋转动画用 stylex.keyframes,reduced-motion 偏好下停转。

import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'

export type SpinnerProps = {
  size?: number
  // 自定义无障碍标签(默认 "Loading");纯装饰场景由父容器提供 label 时可隐藏。
  label?: string
}

const spin = stylex.keyframes({
  to: { transform: 'rotate(360deg)' },
})

const styles = stylex.create({
  wrapper: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  // currentColor 自适应:primary 按钮里随前景色变浅 arc,普通上下文随 fg;轨道为同色低透明。
  ring: {
    borderWidth: '2px',
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklch, currentColor 25%, transparent)',
    borderTopColor: 'currentColor',
    borderRadius: '50%',
    display: 'inline-block',
    // reduced-motion 下停转。
    animationName: {
      default: spin,
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    animationDuration: '0.6s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  // 视觉隐藏但 AT 可读。
  srOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  },
})

export function Spinner({ size = 20, label }: SpinnerProps): ReactNode {
  const { t } = useLingui()
  const text = label ?? t`Loading`

  return (
    <span role="status" aria-live="polite" {...stylex.props(styles.wrapper)}>
      <span
        aria-hidden="true"
        {...stylex.props(styles.ring)}
        style={{ width: size, height: size }}
      />
      <span {...stylex.props(styles.srOnly)}>{text}</span>
    </span>
  )
}
