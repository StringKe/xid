import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// 用 test double 捕获 MotionConfig props,验证 app 级配置映射(MotionConfig 本身
// 只写 context,SSR 输出无可断言标记)。
vi.mock('motion/react', () => ({
  MotionConfig: ({
    children,
    reducedMotion,
  }: {
    children: ReactNode
    reducedMotion?: string
  }): ReactNode => <div data-reduced-motion={reducedMotion}>{children}</div>,
}))

import { AppMotionConfig } from '../app-motion-config'

describe('AppMotionConfig', () => {
  it('renders MotionConfig with reducedMotion="user"', () => {
    const html = renderToStaticMarkup(
      <AppMotionConfig>
        <span>app</span>
      </AppMotionConfig>,
    )

    expect(html).toContain('data-reduced-motion="user"')
    expect(html).toContain('app')
  })
})
