import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// MotionConfig 只写 context,用 double 捕获 props。
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
