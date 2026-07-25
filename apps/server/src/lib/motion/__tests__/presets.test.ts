import { describe, expect, it } from 'vitest'
import { popoverMotion, springDefault, springMomentum, springPress, springSnappy } from '../presets'

describe('motion presets', () => {
  it('default spring is critically damped without overshoot', () => {
    expect(springDefault).toMatchObject({ type: 'spring', bounce: 0, duration: 0.4 })
  })

  it('momentum spring keeps bounce within the Apple gesture budget', () => {
    expect(springMomentum.bounce).toBeGreaterThan(0)
    expect(springMomentum.bounce).toBeLessThanOrEqual(0.2)
  })

  it('press spring settles faster than the default spring', () => {
    expect(springPress.bounce).toBe(0)
    expect(springPress.duration).toBeLessThan(springDefault.duration)
  })

  it('all spring durations stay within the ui-polish motion budget', () => {
    // ui-polish:布局/编排封顶 500ms,按压等即时反馈在 300ms 内
    for (const spring of [springDefault, springMomentum, springSnappy]) {
      expect(spring.duration).toBeLessThanOrEqual(0.5)
    }
    expect(springPress.duration).toBeLessThanOrEqual(0.3)
  })

  it('popover motion grows from the trigger and exits symmetrically', () => {
    expect(popoverMotion.transition).toBe(springSnappy)
    expect(popoverMotion.initial).toMatchObject({ opacity: 0, scale: 0.96 })
    expect(popoverMotion.animate).toMatchObject({ opacity: 1, scale: 1, y: 0 })
    expect(popoverMotion.exit).toEqual(popoverMotion.initial)
  })
})
