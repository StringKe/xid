// AppMotionConfig:app 级 MotionConfig。
// reducedMotion="user":跟随系统"减少动态效果"设置,motion 自动禁用 transform/
// layout 动画(保留 opacity),与 styles.css 全局 reduced-motion 兜底同向。

import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'

export function AppMotionConfig({ children }: { children: ReactNode }): ReactNode {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}
