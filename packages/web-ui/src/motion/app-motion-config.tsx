// reducedMotion="user" 跟随系统偏好,禁用 transform/layout(保留 opacity),与 styles.css 兜底同向。

import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'

export function AppMotionConfig({ children }: { children: ReactNode }): ReactNode {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}
