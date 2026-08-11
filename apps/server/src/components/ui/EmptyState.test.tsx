import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// SSR 无 enter 标记,捕获 motion props 断言动画契约。
const captured = vi.hoisted(() => ({ motionDivProps: [] as Record<string, unknown>[] }))

vi.mock('motion/react', () => ({
  motion: {
    div: (props: Record<string, unknown>): ReactNode => {
      captured.motionDivProps.push(props)
      return (
        <div className={props.className as string} role={props.role as string}>
          {props.children as ReactNode}
        </div>
      )
    },
  },
  AnimatePresence: ({ children }: { children?: ReactNode }): ReactNode => <>{children}</>,
  MotionConfig: ({ children }: { children?: ReactNode }): ReactNode => <>{children}</>,
}))

import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('enters with a spring opacity fade on first mount', () => {
    const html = renderToStaticMarkup(<EmptyState title="Nothing here" />)

    expect(html).toContain('role="status"')
    expect(html).toContain('Nothing here')

    const motionProps = captured.motionDivProps[captured.motionDivProps.length - 1]
    expect(motionProps.initial).toEqual({ opacity: 0 })
    expect(motionProps.animate).toEqual({ opacity: 1 })
    expect(motionProps.transition).toMatchObject({ type: 'spring', bounce: 0, duration: 0.4 })
  })
})
